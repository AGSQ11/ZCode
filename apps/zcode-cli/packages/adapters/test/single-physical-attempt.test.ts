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
  assert.equal(
    calculateRetryDelay(retryOptions, 1, Number.MAX_SAFE_INTEGER + 1),
    Number.MAX_SAFE_INTEGER,
  );
});
