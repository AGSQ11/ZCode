import assert from "node:assert/strict";
import test from "node:test";
import { APICallError } from "ai";
import {
  ModelErrorCode,
  ModelRequestSessionType,
  ModelRetryBudget,
  ModelTransportKind,
  type ModelId,
  type ModelProviderId,
  type TraceId,
} from "@zcode/contracts";
import {
  isSinglePhysicalAttemptBudget,
  retryBudgetAllows,
  retryAttemptLoopContinues,
  retryBudgetMaxAttempts,
} from "../src/model/retry-budget.js";
import { retryAllowedByFailurePolicy } from "../src/model/workflow-model-failure-policy.js";
import { canRetryEmptyCompletion } from "../src/model/empty-completion-retry.js";
import { calculateRetryDelay, toAdapterError } from "../src/model/runner-retry.js";
import { classifyModelFailure } from "../src/model/failure-classifier.js";
import type { ClassifiedModelFailure } from "../src/model/failure-classifier.js";
import type { ModelStatusContext } from "../src/model/runner-status.js";

test("G15 & G16: Single physical attempt adapter policy disables all retry loops", () => {
  const budget = ModelRetryBudget.SinglePhysicalAttempt;

  assert.equal(isSinglePhysicalAttemptBudget(budget), true);

  // retryBudgetAllows: must strictly return false under single physical attempt
  assert.equal(retryBudgetAllows(budget, 1, 10), false);
  assert.equal(retryBudgetAllows(budget, 0, 10), false);

  // retryAttemptLoopContinues: allowed for attempt 1, blocked for attempt > 1
  assert.equal(retryAttemptLoopContinues(budget, 1, 10), true);
  assert.equal(retryAttemptLoopContinues(budget, 2, 10), false);

  // retryBudgetMaxAttempts reports 1
  assert.equal(retryBudgetMaxAttempts(budget, 10), 1);

  // canRetryEmptyCompletion is disabled
  assert.equal(
    canRetryEmptyCompletion({
      attempt: 1,
      maxAttempts: 10,
      retryCount: 0,
      singlePhysicalAttempt: true,
    }),
    false,
  );

  // retryAllowedByFailurePolicy strictly returns false
  const retryableFailure: ClassifiedModelFailure = {
    code: "transient_error",
    message: "Network glitch",
    reason: "network_reset",
    retryReason: "network_reset",
    retryable: true,
  };
  assert.equal(
    retryAllowedByFailurePolicy(retryableFailure, ModelRetryBudget.SinglePhysicalAttempt, undefined),
    false,
  );
});

test("Spec §9: single_physical_attempt dispatches the physical request exactly once", async () => {
  // LOW 评审补齐：不只是断言预算谓词返回 false，而是让真实 runner-stream 以
  // 失败 stub 驱动 attempt 循环，按 stub 侧计数验证物理派发恰好一次。
  const { runStreamText } = await import("../src/model/runner-stream.js");

  let dispatchCount = 0;
  const failingStream = () => {
    dispatchCount += 1;
    return {
      fullStream: (async function* () {
        yield { type: "error", error: new Error("boom") } as never;
      })(),
    } as never;
  };

  const resolved = {
    providerId: "test-provider",
    modelId: "test-model",
    providerKind: "openai-compatible",
    baseURL: "https://provider.example/v1",
    headers: {},
    properties: { contextWindow: 128_000, maxOutputTokens: 8_192 },
  } as never;

  const input = {
    env: {},
    request: {
      messages: [],
      modelRetryBudget: ModelRetryBudget.SinglePhysicalAttempt,
      traceContext: undefined,
    } as never,
    resolveModel: () => resolved,
    resolved,
    retry: {
      maxAttempts: 10,
      baseDelayMs: 1,
      backoffFactor: 2,
      maxDelayMs: 2,
      jitter: false,
    } as never,
    runtime: { streamText: failingStream, generateText: failingStream } as never,
    streamIdleTimeoutMs: 1_000,
    modelIoFullRetentionEnabled: false,
  } as never;

  let thrown: unknown;
  try {
    for await (const _event of runStreamText(input)) {
      // 不应产出任何事件；异常路径直接抛出。
      void _event;
    }
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error, "expected the attempt to fail");
  assert.equal(dispatchCount, 1, "single physical attempt must dispatch exactly once");
});

test("Spec §10: 429-shaped adapter error exposes retryAfterMs on thrown error context", () => {
  // 与生产同一条链路：AI SDK APICallError（429 + Retry-After 头）→ classifyModelFailure
  // → toAdapterError；断言离开 adapter 的错误上下文保留 provider 指示的等待时长。
  const apiError = new APICallError({
    message: "Too Many Requests",
    url: "https://provider.example/v1/chat/completions",
    requestBodyValues: {},
    statusCode: 429,
    responseHeaders: { "retry-after": "120" },
    isRetryable: true,
  });

  const failure = classifyModelFailure(apiError);
  assert.equal(failure.code, ModelErrorCode.ModelRateLimited);
  assert.equal(failure.retryable, true);
  assert.equal(failure.retryAfterMs, 120_000);

  const statusContext = {
    requestId: "req-single-attempt",
    traceId: "trace-single-attempt" as TraceId,
    providerId: "test-provider" as ModelProviderId,
    modelId: "test-model" as ModelId,
    transport: ModelTransportKind.Http,
    maxAttempts: 1,
    modelRequestSessionType: ModelRequestSessionType.Main,
  } as unknown as ModelStatusContext;

  const thrown = toAdapterError(apiError, failure, statusContext, 1);
  assert.equal(thrown.name, "AiSdkModelAdapterError");
  assert.equal(thrown.context?.retryAfterMs, 120_000);

  // 数字秒与 HTTP-date 两种 Retry-After 形态共用 failure-inspection 的同一个解析器。
  const httpDateFailure = classifyModelFailure(
    new APICallError({
      message: "Too Many Requests",
      url: "https://provider.example/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 429,
      responseHeaders: { "retry-after": new Date(Date.now() + 90_000).toUTCString() },
      isRetryable: true,
    }),
  );
  assert.ok(httpDateFailure.retryAfterMs !== undefined);
  assert.ok(httpDateFailure.retryAfterMs > 0);
  const httpDateThrown = toAdapterError(apiError, httpDateFailure, statusContext, 1);
  assert.equal(httpDateThrown.context?.retryAfterMs, httpDateFailure.retryAfterMs);

  // 不给 provider 指示的合法等待设时长上限（旧实现的 60s/5min 上限会破坏路由层冷却）；
  // 只允许把算术结果钳到安全整数。
  const retryOptions = {
    maxAttempts: 1,
    baseDelayMs: 2_000,
    backoffFactor: 2,
    maxDelayMs: 60_000,
    jitter: false,
  };
  assert.equal(calculateRetryDelay(retryOptions, 1, 120_000), 120_000);
  assert.equal(calculateRetryDelay(retryOptions, 1, 10 * 60_000), 10 * 60_000);
  // 超大/恶意 Retry-After 钳到计时器安全上限（Node setTimeout >2^31-1ms 会退化为 1ms，
  // 与路由层尊重完整等待的语义背离）；合法值不受影响。
  assert.equal(
    calculateRetryDelay(retryOptions, 1, Number.MAX_SAFE_INTEGER + 1),
    2_147_483_647,
  );
});
