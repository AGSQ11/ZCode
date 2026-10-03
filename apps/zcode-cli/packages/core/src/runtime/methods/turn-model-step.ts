import { beginLocalTurnPreparation } from "@zcode/contracts";
import {
  CompactTrigger,
  CoreErrorType,
  SessionEventType,
  createChildTraceContext,
  createCoreError,
  createMessageId,
  createPartId,
  getModelUsageTotalTokens,
  traceContextToLogContext,
  TurnMachineImpl,
} from "../deps.js";
import type { MessageId, Model, ModelNetworkStatusEvent, ModelToolContract } from "../deps.js";
import {
  createRuntimeAssistantEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import {
  createModelContextExceededFinishError,
  createCompactRapidRefillError,
  objectKeys,
  projectExecutionErrorPayload,
  finalizeSuspiciousEmptyModelResult,
  isContextExceededFinishReason,
  isSuspiciousEmptyModelResult,
  readRawFinishReason,
  throwIfTurnAborted,
  isModelContextExceededError,
  isTurnCancellationError,
  buildTurnFileChangeSummary,
} from "../helpers/index.js";
import type {
  DrainedPendingInputDiagnostics,
  RunModelTextRequestOptions,
  RuntimeModelStreamSnapshot,
  RuntimeModelTextResult,
} from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { executeToolCallsForModelStep } from "./turn-tools.js";
import {
  captureAssistantPersistenceAnchor,
  finishModelStepWithoutToolCalls,
  persistCompletedAssistantStep,
  persistOutputTokenLimitErrorCarrier,
} from "./turn-stop.js";
import { createStreamingToolCoordinator } from "./streaming-tool-coordinator.js";
import { persistCancelledStreamSnapshot } from "./cancelled-stream-persistence.js";
import {
  beginStartPlanBusyAdmissionRetryAttempt,
  createStartPlanBusyAutoRetryExhaustedError,
  emitStreamRecoveryRetryEvents,
  emitStreamRecoveryStarted,
  getStartPlanBusyAdmissionRetryDelayMs,
  isStartPlanBusyStreamRecoveryFailure,
} from "./streaming-recovery.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import {
  evaluateRapidRefill,
  MAX_CONSECUTIVE_RAPID_REFILLS,
  RAPID_REFILL_TOOL_TURN_THRESHOLD,
  recordCompactHistoryRound,
  recordCompactSuccess,
  recordModelHistoryRound,
} from "./turn-loop-state.js";
import {
  querySourceForTask,
  recordMainTurnCacheHitUsage,
  recordMainTurnModelUsage,
} from "./turn-model-step-usage.js";
import { estimateCurrentModelInputTokens } from "./compact.js";
import {
  resolveModelStepMaxOutputTokens,
  resolveNormalRequestMaxOutputTokens,
} from "./model-token-limits.js";
import {
  appendOutputTokenContinuation,
  classifyOutputTokenContinuation,
  commitAssistantToTurnRequest,
  commitTurnRequestEntries,
  completeOutputTokenRecovery,
  hasAssistantReasoningContent,
  OUTPUT_TOKEN_LIMIT_ERROR_MESSAGE,
} from "./turn-output-token-continuation.js";
import {
  isModelGroupRoutingError,
  ModelGroupRoutingError,
  prepareRoutedAttempt,
  readGroupTurnRouting,
  type GroupTurnRoutingState,
} from "./turn-model.js";
import { isDeadlineExceeded } from "@zcode/shared/model-group-routing";

type ModelStepResult = "continue" | "output_continuation" | "break";

export async function runModelBackedTurnStep(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    drainedSteerForNextRequest?: DrainedPendingInputDiagnostics;
    latestRealUserMessageIndex?: number;
    messages: RunModelTextRequestOptions["messages"];
    sourceEntries: readonly (RuntimeMessageEntry | undefined)[];
    recordedMessages: RunModelTextRequestOptions["messages"];
    requestEntries: readonly RuntimeMessageEntry[];
    tools: ModelToolContract[];
  },
): Promise<ModelStepResult> {
  const assistantMessageId = createMessageId();
  const stepTelemetry = this.agentTelemetry.step({
    stepId: assistantMessageId,
    stepIndex: state.modelStepCount,
  });
  return stepTelemetry.run(async () => {
    try {
      const result = await runModelBackedTurnStepImpl.call(
        this,
        state,
        options,
        assistantMessageId,
      );
      stepTelemetry.finishCompleted(
        result === "output_continuation"
          ? "model_completed"
          : result === "continue"
            ? "tool_requested"
            : "turn_completed",
      );
      return result;
    } catch (error) {
      if (isTurnCancellationError(error, state.turnAbortSignal)) {
        stepTelemetry.finishCancelled("abort_signal");
      } else {
        stepTelemetry.finishFailed("unhandled", "unknown", error);
      }
      throw error;
    }
  });
}

async function runModelBackedTurnStepImpl(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    drainedSteerForNextRequest?: DrainedPendingInputDiagnostics;
    latestRealUserMessageIndex?: number;
    messages: RunModelTextRequestOptions["messages"];
    sourceEntries: readonly (RuntimeMessageEntry | undefined)[];
    recordedMessages: RunModelTextRequestOptions["messages"];
    requestEntries: readonly RuntimeMessageEntry[];
    tools: ModelToolContract[];
  },
  assistantMessageId: MessageId,
): Promise<ModelStepResult> {
  const modelStepIndex = state.modelStepCount;
  const modelStartedAt = Date.now();
  const assistantCreatedAt = modelStartedAt;
  const assistantPersistenceAnchor = captureAssistantPersistenceAnchor(this);
  const querySource = querySourceForTask(this.config.taskType);
  // 组路由状态（仅组目标存在）：failover 在同一个逻辑 invocation 内换成员重试，
  // 共享 deadline 与尝试预算（spec §9/§11）。
  const groupRouting = readGroupTurnRouting(state);
  // 物理尝试内可换成员：model 及派生预算必须在每次尝试时从 state.model 重取，
  // 不能冻结在 step 入口的第一个成员上。
  let model = state.model;
  let executionModelSelection = { providerId: model.providerId, modelId: model.modelId };
  // 请求预算由 Agent 执行链显式决定。普通 Turn 选择打满模型声明的上限，
  // ModelFactory 不再把该请求参数伪装成长期 ModelSelection/Active Model 状态。
  let executionMaxOutputTokens = model.optionSpecs.maxOutputTokens.max;
  let executionContextWindow = model.properties.contextWindow;
  let modelTraceContext = createModelStepTraceContext(state, model, querySource);

  this.logModelRequestSteeringContext({
    activeTurn: state.activeTurn,
    drained: options.drainedSteerForNextRequest,
    messages: options.messages,
    modelStepCount: state.modelStepCount,
    traceContext: modelTraceContext,
  });
  const finishPersistence = beginLocalTurnPreparation(modelTraceContext, "persistence");
  await this.persistAssistantMessage(
    assistantMessageId,
    state.currentUserMessageId,
    assistantCreatedAt,
    undefined,
    modelTraceContext,
    model,
  );
  await this.persistPart(
    {
      id: createPartId(),
      sessionID: this.sessionId,
      messageID: assistantMessageId,
      type: "step-start",
    },
    modelTraceContext,
  );

  const modelRequestEvent = this.createEvent(
    SessionEventType.ModelRequest,
    {
      // 自动续写提示只属于本次请求，不应写入持久化的 ModelRequest 轨迹。
      messages: options.recordedMessages,
      providerId: String(model.providerId),
      modelId: String(model.modelId),
      querySource,
      toolCount: options.tools.length,
      iteration: state.toolCallCount === 0 ? 0 : Math.ceil(state.toolCallCount / 10),
    },
    modelTraceContext,
  );
  await this.appendEvent(modelRequestEvent, modelTraceContext);
  state.events.push(modelRequestEvent);
  finishPersistence();
  const networkEventStartIndex = state.events.length;
  const streamRecoveryRequest = state.pendingStreamRecoveryRequest;
  state.pendingStreamRecoveryRequest = undefined;

  let result: RuntimeModelTextResult;
  // 组 failover 在同一个逻辑 invocation 内循环物理尝试：共享 deadline 与
  // min(maxMemberAttempts, enabled member count) 预算，绝不给失败成员另起新预算
  // （spec §9/§11）。非组目标只走一次循环体，行为与此前逐字节一致。
  let streamingToolCoordinator = createStreamingToolCoordinator(this, state, {
    assistantMessageId,
    model,
    traceContext: modelTraceContext,
  });
  let latestStreamSnapshot: RuntimeModelStreamSnapshot = { reasoning: [], text: "" };
  let latestModelRequestId: string | undefined;
  let latestFailedModelRequestId: string | undefined;
  const recordModelNetworkStatus = (event: ModelNetworkStatusEvent): void => {
    if (event.type === "model_request_started") {
      latestModelRequestId = event.requestId;
      return;
    }
    if (event.type === "model_stream_stalled" || event.type === "model_request_failed") {
      latestFailedModelRequestId = event.requestId;
    }
  };

  for (;;) {
    const attemptReservation = groupRouting?.activeReservation;
    const attemptMemberId = groupRouting?.activeMemberId;
    // P1-3/spec §8：attempts24h 只在物理请求真正派发前自增恰好一次；
    // 预留（reservation）与 skip/cancel before execution 都不计数。
    attemptReservation?.markDispatched();
    const toolCallCountAtAttemptStart = state.toolCallCount;
    // spec §10 lease lifecycle 5：每个物理尝试的 lease 必须在 finally 里恰好释放
    // 一次（router 的 release 幂等，success 路径先行写入 outcome，catch 里的分类
    // 结果只在未写时生效）。
    let attemptOutcome: { outcome: LeaseOutcome; retryAfterMs?: number } | undefined;
    try {
      const baselineMaxOutputTokens = resolveNormalRequestMaxOutputTokens({
        modelMaxOutputTokens: executionMaxOutputTokens,
      });
      result = await this.runModelTextRequest({
        abortSignal: state.turnAbortSignal,
        assistantMessageId,
        events: state.events,
        maxOutputTokens: resolveModelStepMaxOutputTokens({
          baselineMaxOutputTokens,
          contextWindow: executionContextWindow,
          estimatedCurrentUsage: estimateCurrentModelInputTokens(
            options.messages,
            options.sourceEntries,
          ),
          modelContextBudgetStrategy: this.config.modelContextBudgetStrategy,
        }),
        latestRealUserMessageIndex: options.latestRealUserMessageIndex,
        messages: options.messages,
        sourceEntries: options.sourceEntries,
        model,
        onStreamSnapshot: (snapshot) => {
          latestStreamSnapshot = snapshot;
        },
        onModelNetworkStatus: recordModelNetworkStatus,
        onStreamReasoningDelta: (text) => streamingToolCoordinator.recordReasoningDelta(text),
        onStreamTextDelta: (text) => streamingToolCoordinator.recordTextDelta(text),
        onStreamToolCall: (toolCall) => streamingToolCoordinator.accept(toolCall),
        streamRecovery: streamRecoveryRequest,
        tools: options.tools,
        traceContext: modelTraceContext,
      });
      throwIfTurnAborted(state.turnAbortSignal);
      attemptOutcome = { outcome: "success" };
      break;
    } catch (error) {
      const classification = classifyGroupAttemptFailure(this, error, state.turnAbortSignal);
      attemptOutcome = {
        outcome: classification.outcome,
        ...(classification.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: classification.retryAfterMs }),
      };
      // spec §11 失败处理顺序：先关闭失败迭代器、丢弃 buffered prelude、记录失败并
      // 释放 lease，然后才准备下一成员--lease 不释放就重选会让 router 的容量检查
      // 把本尝试的 inFlight 算进去，末位容量场景下误报 GROUP_BUSY。finally 的幂等
      // release 是兜底（router release 幂等，重复调用无副作用）。
      attemptReservation?.release(attemptOutcome.outcome, attemptOutcome.retryAfterMs ?? null);
      if (groupRouting && groupRouting.activeReservation === attemptReservation) {
        groupRouting.activeReservation = undefined;
      }

      // PRE-COMMIT 边界：本次尝试没有已提交的 text/reasoning delta，也没有新提交的
      // tool call（证据与 streamingToolCoordinator.recoverFromModelFailure 的提交
      // 判定同源：latestStreamSnapshot + toolCallCount delta）。只有在这个边界内
      // 才允许自动 failover；post-commit 一律交给既有 stream recovery（spec §11）。
      const committedReasoning = latestStreamSnapshot.reasoning.filter(hasAssistantReasoningContent);
      const isPreCommitBoundary =
        latestStreamSnapshot.text.length === 0 &&
        committedReasoning.length === 0 &&
        state.toolCallCount === toolCallCountAtAttemptStart;

      if (
        groupRouting &&
        isPreCommitBoundary &&
        classification.failoverEligible &&
        !state.turnAbortSignal.aborted &&
        !isModelGroupRoutingError(error)
      ) {
        // 先丢弃失败尝试的 buffered prelude 与未完成 tool 输入（spec §11 步骤 1-2），
        // 再准备下一成员；顺序反过来会让 prepare 成功、abandon 失败时新 lease 泄漏。
        await streamingToolCoordinator.abandon("model_failed");
        const failoverDecision = await tryPrepareGroupFailoverAttempt(this, state, groupRouting, {
          excludedMemberId: attemptMemberId,
        });
        if (failoverDecision.kind === "retry") {
          model = failoverDecision.model;
          state.model = failoverDecision.model;
          executionModelSelection = {
            providerId: model.providerId,
            modelId: model.modelId,
          };
          executionMaxOutputTokens = model.optionSpecs.maxOutputTokens.max;
          executionContextWindow = model.properties.contextWindow;
          modelTraceContext = createModelStepTraceContext(state, model, querySource);
          streamingToolCoordinator = createStreamingToolCoordinator(this, state, {
            assistantMessageId,
            model,
            traceContext: modelTraceContext,
          });
          latestStreamSnapshot = { reasoning: [], text: "" };
          latestModelRequestId = undefined;
          latestFailedModelRequestId = undefined;
          continue;
        }
        if (failoverDecision.kind === "error") {
          // 结构化组错误（GROUP_EXHAUSTED / GROUP_DEADLINE_EXCEEDED / GROUP_COOLING_DOWN /
          // GROUP_BUSY）必须原样穿出，不能让下方通用 stream recovery / 重试逻辑把它吞成
          // 普通模型错误（spec §9：routing failure 是 core/driver 边界的显式终态）。
          // coordinator 已在 failover 判定前 abandon，这里直接抛出。
          throw failoverDecision.error;
        }
        // kind === "no_budget"：failover 关闭或预算/deadline 耗尽，落回既有失败处理，
        // 由下面的逻辑持久化并抛出当前成员的结构化失败（spec §9：不静默 fallthrough）。
      }

      // ===== 以下为既有最终失败处理（非组目标、或组 failover 不适用/已耗尽时到达）=====
      let finalError = error;
      await recordMainTurnModelUsage(this, state, {
        assistantMessageId,
        error: finalError,
        model,
        modelTraceContext,
        networkEventStartIndex,
        startedAt: modelStartedAt,
        status: state.turnAbortSignal.aborted ? "cancelled" : "error",
      });
      const failedRequestId = latestFailedModelRequestId ?? latestModelRequestId;
      const toolCallCountBeforeStreamRecovery = state.toolCallCount;
      if (
        await streamingToolCoordinator.recoverFromModelFailure(
          error,
          assistantCreatedAt,
          failedRequestId ? { failedRequestId } : undefined,
        )
      ) {
        if (state.toolCallCount > toolCallCountBeforeStreamRecovery) {
          completeOutputTokenRecovery(state.turnRequestState);
        }
        return "continue";
      }
      const admissionRetryDelayMs = getStartPlanBusyAdmissionRetryDelayMs({
        error: finalError,
        providerId: executionModelSelection.providerId,
        state,
        turnNumber: this.turnNumber,
      });
      if (!state.turnAbortSignal.aborted && admissionRetryDelayMs !== undefined) {
      // 第二轮及以后 Start Plan 可能在首 token 前被 admission 并发限制拒绝；
      // 这时没有文本或 tool anchor，旧 stream recovery 不会启动，必须关闭空 assistant 后短重试。
      const recoveryAttempt = beginStartPlanBusyAdmissionRetryAttempt(state);
      this.logger?.warn("Main turn retrying after Start Plan admission busy", {
        ...traceContextToLogContext(modelTraceContext),
        event: "model.main_turn.retry_start_plan_admission_busy",
        module: "core.runtime",
        retryDelayMs: admissionRetryDelayMs,
        retryNumber: recoveryAttempt.retryNumber,
        maxRetries: recoveryAttempt.maxRetries,
        status: "waiting",
      });
      await emitStreamRecoveryStarted(
        this,
        state,
        {
          assistantMessageId,
          ...(failedRequestId ? { failedRequestId } : {}),
          traceContext: modelTraceContext,
        },
        finalError,
        recoveryAttempt,
      );
      await this.persistAssistantMessage(
        assistantMessageId,
        state.userMessageId,
        assistantCreatedAt,
        {
          completed: Date.now(),
          finish: "start_plan_admission_retry_discarded",
        },
        modelTraceContext,
        model,
      );
      state.modelResponse = "";
      state.modelStepCount += 1;
      recordModelHistoryRound(state);
      state.turnMachine = new TurnMachineImpl(state.turnMachine.receiveModelResponse(""));
      state.turnMachine = new TurnMachineImpl(state.turnMachine.aggregateResults());
      await emitStreamRecoveryRetryEvents(
        this,
        state,
        {
          assistantMessageId,
          ...(failedRequestId ? { failedRequestId } : {}),
          traceContext: modelTraceContext,
        },
        {
          ...recoveryAttempt,
          discardedReasoningBytes: 0,
          discardedTextBytes: 0,
          reason: "no_tool_committed",
          toolCallIds: [],
        },
      );
      await streamingToolCoordinator.abandon("model_failed");
      await new Promise((resolve) => setTimeout(resolve, admissionRetryDelayMs));
      throwIfTurnAborted(state.turnAbortSignal);
      return "continue";
    }
    if (
      state.streamRecoveryRetryCount > 0 &&
      !state.turnAbortSignal.aborted &&
      isStartPlanBusyStreamRecoveryFailure(finalError)
    ) {
      // Start Plan 运行中断流会先走 core stream recovery；恢复次数耗尽后，
      // 继续抛原 provider 文案会和首轮繁忙失败无法区分，UI 也就不能展示"自动重试达到最大次数"。
      finalError = createStartPlanBusyAutoRetryExhaustedError(finalError);
    }
    await streamingToolCoordinator.abandon(
      state.turnAbortSignal.aborted ? "cancelled" : "model_failed",
    );
    if (
      state.turnAbortSignal.aborted &&
      isTurnCancellationError(finalError, state.turnAbortSignal)
    ) {
      await persistCancelledStreamSnapshot(this, {
        assistantCreatedAt,
        assistantMessageId,
        snapshot: latestStreamSnapshot,
        traceContext: modelTraceContext,
      });
      const reasoning = latestStreamSnapshot.reasoning.filter(hasAssistantReasoningContent);
      if (latestStreamSnapshot.text.length > 0 || reasoning.length > 0) {
        // 取消时 durable snapshot 已经持久化，但成功路径的 live history commit
        // 和 historyRoundCount 不会执行，导致当前进程与 cold resume 的 provider history 不一致。
        commitTurnRequestEntries(this, state.turnRequestState, [
          createRuntimeAssistantEntry(
            latestStreamSnapshot.text,
            undefined,
            reasoning,
            state.model
              ? { providerId: state.model.providerId, modelId: state.model.modelId }
              : undefined,
          ),
        ]);
        recordModelHistoryRound(state);
      }
    }
    const finalErrorRecord =
      finalError && typeof finalError === "object"
        ? (finalError as Record<string, unknown>)
        : undefined;
    const persistedErrorCode =
      typeof finalErrorRecord?.code === "string" ? finalErrorRecord.code : undefined;
    const persistedErrorProjection = projectExecutionErrorPayload(finalError);
    const persistedTurnResult = isTurnCancellationError(finalError, state.turnAbortSignal)
      ? "cancelled"
      : undefined;
    await this.persistAssistantMessage(
      assistantMessageId,
      state.userMessageId,
      assistantCreatedAt,
      {
        completed: Date.now(),
        error: {
          name: finalError instanceof Error ? finalError.name : "UnknownError",
          data: {
            message: finalError instanceof Error ? finalError.message : String(finalError),
            ...(persistedErrorCode ? { code: persistedErrorCode } : {}),
            // live TurnError 有结构化归因，但 transcript 过去未持久化，冷恢复后会丢成 runtime。
            ...(persistedErrorProjection.attribution
              ? { attribution: persistedErrorProjection.attribution }
              : {}),
            // 用户 Stop 的模型中止过去只持久化通用 error name/message，
            // cold hydration 无法区分正常取消和真实 provider 失败，最终错误地生成 TurnError。
            ...(persistedTurnResult ? { turnResult: persistedTurnResult } : {}),
          },
        },
      },
      modelTraceContext,
      model,
    );
    if (
      isModelContextExceededError(finalError) &&
      (await recoverModelStepAfterContextExceeded.call(
        this,
        state,
        finalError,
        modelStepIndex,
        options.requestEntries,
      ))
    ) {
      return "continue";
    }
    throw finalError;
  } finally {
    // spec §10 lease lifecycle 5：finally 里恰好释放一次。catch 已按失败分类写入
    // outcome；成功路径写入 success。catch 内的 failover 重试（continue）与结构化
    // 组错误（throw）同样经过这里，旧 lease 绝不跨物理尝试泄漏。
    if (attemptReservation && attemptOutcome) {
      attemptReservation.release(attemptOutcome.outcome, attemptOutcome.retryAfterMs ?? null);
      if (groupRouting?.activeReservation === attemptReservation) {
        groupRouting.activeReservation = undefined;
      }
    }
  }
  }

  state.modelResponse = result.text;
  state.modelStepCount += 1;
  state.tokenCount += getModelUsageTotalTokens(result.usage);

  if (result.usage.cacheReadTokens && result.usage.cacheReadTokens > 0) {
    this.messageHistory.setCacheHit(result.usage.cacheReadTokens);
  }

  let toolCalls = this.extractToolCallsFromResult(result);
  const providerToolCallCount = toolCalls.length;
  const localTerminalResponse = state.automationCreateLimitReached === true;
  if (state.automationCreateLimitReached && toolCalls.length > 0) {
    // 即使 provider 在 tools=[] 后仍幻觉出工具调用，也不能重新进入执行器；
    // 上限命中后的当前用户 turn 已经是纯文本终止边界。
    this.logger?.warn("Ignored tool calls after automation create limit was reached", {
      event: "automation.create_limit.tool_calls_ignored",
      module: "core.runtime",
      status: "completed",
      toolCallCount: toolCalls.length,
    });
    toolCalls = [];
    state.modelResponse = buildAutomationCreateLimitFallback(state.input);
  } else if (state.automationCreateLimitReached && state.modelResponse.trim().length === 0) {
    state.modelResponse = buildAutomationCreateLimitFallback(state.input);
  }
  const usage = result.usage ?? {};
  const responseLength = state.modelResponse.length;
  const rawFinishReason = readRawFinishReason(result.providerMetadata);
  // Automation create-limit 已经接管当前响应的终止语义；若在清空
  // provider tool calls 后仍重新解释 length/context reason，纯文本终态会再续跑 3 次。
  const outputTokenContinuation = localTerminalResponse
    ? "none"
    : classifyOutputTokenContinuation({
        continuationCount: state.turnRequestState.outputTokenContinuationCount,
        finishReason: result.finishReason,
        rawFinishReason,
        toolCallCount: providerToolCallCount,
      });
  this.logger?.info("Model response diagnostics", {
    ...traceContextToLogContext(modelTraceContext),
    event: "model.response.diagnostics",
    finishReason: result.finishReason,
    module: "core.runtime",
    providerMetadataKeys: objectKeys(result.providerMetadata),
    rawFinishReason,
    responseEmpty: responseLength === 0,
    responseLength,
    status: "completed",
    toolCallCount: toolCalls.length,
    usageCacheReadTokens: usage.cacheReadTokens,
    usageCacheWriteTokens: usage.cacheWriteTokens,
    usageInputTokens: usage.inputTokens,
    usageOutputTokens: usage.outputTokens,
    usageReasoningTokens: usage.reasoningTokens,
    usageTotalTokens: usage.totalTokens,
  });
  if (
    !localTerminalResponse &&
    outputTokenContinuation === "none" &&
    toolCalls.length === 0 &&
    isContextExceededFinishReason(result.finishReason, rawFinishReason)
  ) {
    // 超窗 provider 可能返回空内容和 zero usage；必须先识别 overflow，
    // 否则会被 suspicious empty 包成普通 ModelError，后续 reactive compact 无法触发。
    const contextError = createModelContextExceededFinishError({
      finishReason: result.finishReason,
      rawFinishReason,
    });
    if (
      await recoverModelStepAfterContextExceeded.call(
        this,
        state,
        contextError,
        modelStepIndex,
        options.requestEntries,
      )
    ) {
      return "continue";
    }
    throw contextError;
  }
  if (
    !localTerminalResponse &&
    outputTokenContinuation === "none" &&
    isSuspiciousEmptyModelResult(result.finishReason, responseLength, toolCalls.length, usage)
  ) {
    this.logger?.warn("Model returned an empty non-stop result", {
      ...traceContextToLogContext(modelTraceContext),
      event: "model.response.suspicious_empty",
      finishReason: result.finishReason,
      module: "core.runtime",
      rawFinishReason,
      responseLength,
      status: "completed",
      toolCallCount: toolCalls.length,
      usageTotalTokens: usage.totalTokens,
    });
    finalizeSuspiciousEmptyModelResult({
      finishReason: result.finishReason,
      model: executionModelSelection,
      providerMetadata: result.providerMetadata,
      rawFinishReason,
    });
  }
  // AI SDK 可能把非标准 output-limit 归一化为 other；Runtime 已确认恢复语义后，
  // live 事件与持久化必须统一使用 length，同时由上方 diagnostics 保留 provider 原始事实。
  if (outputTokenContinuation !== "none") result.finishReason = "length";
  for (const reasoning of result.reasoning ?? []) {
    if (!hasAssistantReasoningContent(reasoning)) continue;
    await this.persistPart(
      {
        id: createPartId(),
        sessionID: this.sessionId,
        messageID: assistantMessageId,
        type: "reasoning",
        text: reasoning.text,
        metadata: reasoning.providerOptions,
        time: {
          start: modelStartedAt,
          end: Date.now(),
        },
      },
      modelTraceContext,
    );
  }
  if (state.modelResponse.length > 0) {
    await this.persistPart(
      {
        id: createPartId(),
        sessionID: this.sessionId,
        messageID: assistantMessageId,
        type: "text",
        text: state.modelResponse,
        time: {
          start: modelStartedAt,
          end: Date.now(),
        },
      },
      modelTraceContext,
    );
  }

  const cacheHit =
    querySource === "main_turn" ? recordMainTurnCacheHitUsage(this, result.usage) : undefined;
  // subagent 的文件 checkpoint 已经持久化，但旧 gate 只允许 main_turn 把
  // 汇总写入 ModelComplete，导致 child 详情无法从权威事件恢复摘要和撤销入口。
  const supportsTurnFileChanges = querySource === "main_turn" || querySource === "subagent";
  const fileChanges =
    supportsTurnFileChanges && toolCalls.length === 0
      ? buildTurnFileChangeSummary(this.currentTurnFileChanges)
      : undefined;
  const modelCompleteEvent = this.createEvent(
    SessionEventType.ModelComplete,
    {
      content: state.modelResponse,
      // 桌面 continuous 实时事件只携带当前 model_complete payload。
      // 如果主轮次只发 usage 不发 contextWindow，旧 task stream 无法生成 usage_update，
      // 长程任务中输入栏会拿不到 context meter 的 size 而隐藏。
      ...(querySource === "main_turn" && executionContextWindow !== undefined
        ? { contextWindow: executionContextWindow }
        : {}),
      querySource,
      stopReason: result.finishReason,
      usage: result.usage,
      ...(cacheHit ? { cacheHit } : {}),
      ...(fileChanges ? { fileChanges } : {}),
      ...(querySource === "main_turn" && result.contextUsageBreakdown
        ? { contextUsageBreakdown: result.contextUsageBreakdown }
        : {}),
      toolCallCount: toolCalls.length,
    },
    modelTraceContext,
  );
  await this.appendEvent(modelCompleteEvent, modelTraceContext);
  state.events.push(modelCompleteEvent);
  this.lastAssistantCompletedAtMs = Date.now();
  await recordMainTurnModelUsage(this, state, {
    assistantMessageId,
    model,
    modelTraceContext,
    networkEventStartIndex,
    result,
    startedAt: modelStartedAt,
    status: "completed",
    toolCallCount: toolCalls.length,
  });
  state.turnMachine = new TurnMachineImpl(
    state.turnMachine.receiveModelResponse(state.modelResponse),
  );
  throwIfTurnAborted(state.turnAbortSignal);

  this.logger?.info("Model request completed", {
    ...traceContextToLogContext(modelTraceContext),
    durationMs: Date.now() - modelStartedAt,
    event: "model.request.completed",
    module: "core.runtime",
    status: "completed",
    totalTokens: state.tokenCount,
    toolCallCount: toolCalls.length,
  });

  const executableToolCalls = toolCalls.filter((toolCall) => !toolCall.providerExecuted);
  const streamedToolResults = await streamingToolCoordinator.drain(executableToolCalls);
  if (outputTokenContinuation !== "none") {
    // 首次命中 output-limit 时，当前 request 可能带有一次性的 project-memory attachment；
    // query-local 状态必须从实际请求数组推进，不能退回请求前的数组。
    state.turnRequestState.entries = options.requestEntries;
    const assistantCommitted = await persistCompletedAssistantStep(this, state, {
      assistantPersistenceAnchor,
      assistantCreatedAt,
      assistantMessageId,
      includeEmptyAssistant: false,
      modelTraceContext,
      result,
    });
    if (assistantCommitted) recordModelHistoryRound(state);
    if (outputTokenContinuation === "continue") {
      appendOutputTokenContinuation(state.turnRequestState);
      state.reactiveCompactAttemptedInCurrentModelStep = false;
      state.turnMachine = new TurnMachineImpl(state.turnMachine.aggregateResults());
      return "output_continuation";
    }

    const exhaustedError = createCoreError(
      CoreErrorType.ModelError,
      OUTPUT_TOKEN_LIMIT_ERROR_MESSAGE,
      {
        context: {
          providerCode: "model_output_limit_exceeded",
          reason: "model_output_limit_exceeded",
          source: "provider",
        },
        recoverable: true,
      },
    );
    const exhaustedErrorProjection = projectExecutionErrorPayload(
      exhaustedError,
      OUTPUT_TOKEN_LIMIT_ERROR_MESSAGE,
    );
    completeOutputTokenRecovery(state.turnRequestState);
    await persistOutputTokenLimitErrorCarrier(this, state, {
      error: {
        name: exhaustedErrorProjection.code ?? exhaustedError.type,
        data: {
          ...(exhaustedErrorProjection.code ? { code: exhaustedErrorProjection.code } : {}),
          message: exhaustedErrorProjection.message,
          // 既有 cold hydration 用 retryable 恢复 UI recoverable；这里复用该字段，
          // 不为单一错误扩展 transcript/hydration schema。
          retryable: exhaustedError.recoverable,
          ...(exhaustedErrorProjection.attribution
            ? { attribution: exhaustedErrorProjection.attribution }
            : {}),
        },
      },
      finishReason: result.finishReason,
      model,
      modelTraceContext,
    });
    if (state.activeTurn) state.activeTurn.steerable = false;
    // 上游 query loop 会把 max_output_tokens API-error assistant 交给外层；这里复用
    // 既有 ModelError -> TurnError 收口表达同一实时错误，同时只结束当前 Turn command。
    throw exhaustedError;
  }
  completeOutputTokenRecovery(state.turnRequestState);
  if (executableToolCalls.length === 0) {
    return await finishModelStepWithoutToolCalls.call(this, state, {
      assistantPersistenceAnchor,
      assistantCreatedAt,
      assistantMessageId,
      modelTraceContext,
      result,
    });
  }

  state.toolCallCount += executableToolCalls.length;
  // 合并修复：工具调用 assistant 必须同时进入 canonical history 与本轮 request history。
  // 只写 canonical history 会让紧随其后的工具结果失去对应 assistant tool-call。
  if (commitAssistantToTurnRequest(this, state, result, executableToolCalls)) {
    recordModelHistoryRound(state);
  }
  const toolStepResult = await executeToolCallsForModelStep.call(this, state, {
    assistantCreatedAt,
    assistantMessageId,
    modelTraceContext,
    result,
    toolCalls: executableToolCalls,
    streamedToolResults,
  });
  return toolStepResult;
}

function buildAutomationCreateLimitFallback(input: string): string {
  if (/\p{Script=Han}/u.test(input)) {
    return "定时任务已达到 20 个上限，本次未创建。请前往「自动化」手动删除一个已有任务后重试。";
  }
  return "The limit of 20 scheduled tasks has been reached, so no task was created. Manually delete an existing task on the Automations page, then try again.";
}

async function recoverModelStepAfterContextExceeded(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  contextError: unknown,
  modelStepIndex: number,
  activeEntries: readonly RuntimeMessageEntry[],
): Promise<boolean> {
  if (state.reactiveCompactAttemptedInCurrentModelStep) {
    return false;
  }

  const rapidRefill = evaluateRapidRefill(state.compactTracking);
  if (rapidRefill.shouldBlock) {
    this.logger?.warn("Reactive compact rapid-refill breaker tripped", {
      ...traceContextToLogContext(state.turnTraceContext),
      event: "compact.rapid_refill_breaker",
      consecutiveRapidRefills: rapidRefill.consecutiveRapidRefills,
      modelStepIndex,
      module: "core.runtime",
      status: "failed",
      toolTurnsSinceCompact: rapidRefill.toolTurnsSinceCompact,
      trigger: CompactTrigger.Reactive,
    });
    throw createCompactRapidRefillError({
      consecutiveRapidRefills: rapidRefill.consecutiveRapidRefills,
      maxConsecutiveRapidRefills: MAX_CONSECUTIVE_RAPID_REFILLS,
      toolTurnThreshold: RAPID_REFILL_TOOL_TURN_THRESHOLD,
      toolTurnsSinceCompact: rapidRefill.toolTurnsSinceCompact,
    });
  }

  state.reactiveCompactAttemptedInCurrentModelStep = true;
  const compactOutcome = await this.reactiveCompactAfterContextExceeded(
    contextError,
    state.turnTraceContext,
    state.events,
    state.turnAbortSignal,
    {
      activeEntries,
      modelStepIndex,
      rapidRefillCount: rapidRefill.consecutiveRapidRefills,
      model: state.model,
      turnRequestState: state.turnRequestState,
    },
  );
  if (compactOutcome !== "compacted") {
    return false;
  }

  recordCompactSuccess(state, rapidRefill);
  recordCompactHistoryRound(state);
  state.turnMachine = new TurnMachineImpl(
    TurnMachineImpl.create(
      this.sessionId,
      this.turnNumber,
      state.input,
      state.traceId,
      state.turnId,
    ).start(),
  );
  return true;
}

/** 按当前尝试成员重建 step trace context（failover 换成员后 providerId/modelId 必须跟随）。 */
function createModelStepTraceContext(
  state: RegularTurnLoopState,
  model: Model,
  querySource: ReturnType<typeof querySourceForTask>,
) {
  return createChildTraceContext(state.turnTraceContext, {
    attributes: {
      providerId: String(model.providerId),
      modelId: String(model.modelId),
      iteration: state.toolCallCount === 0 ? 0 : Math.ceil(state.toolCallCount / 10),
      querySource,
    },
  });
}

type LeaseOutcome = "success" | "transient_failure" | "terminal_failure" | "cancelled" | "neutral";

interface GroupFailureClassification {
  outcome: LeaseOutcome;
  retryAfterMs?: number;
  /** true = 允许在 PRE-COMMIT 边界换成员重试；cancel/terminal/neutral 不重试。 */
  failoverEligible: boolean;
}

/**
 * spec §9 失败分类在 core 接缝的实现：把 adapter 归一化错误（AiSdkModelAdapterError
 * 经 toAdapterError 带出的 context.reason/statusCode/retryable/retryAfterMs，core
 * 按既有 error-payload 约定读取这些字段，不 import adapter 内部类型）映射为 lease
 * 结局与 failover 资格。
 *
 * 映射表（spec §9 failure class → group action）：
 * - 用户 abort / turn abort / deadline → cancelled，不 failover；
 * - 网络 reset/timeout/408/transient 5xx/429 → transient_failure + Retry-After，可 failover；
 * - auth 401/403、quota 402/结构化业务码、model-404/not-entitled → terminal_failure，不 failover
 *   （健康效果由 router 的 release 承担，spec：换用其他可用连接的成员而非本成员重试）；
 * - policy refusal / 内部编程错误 / tool failure → neutral，不 failover（不能用成员重试掩盖 bug）；
 * - 未知 → neutral + warn（诊断分类 unclassified，不静默当作 transient）。
 */
function classifyGroupAttemptFailure(
  runtime: AgentRuntimeInternal,
  error: unknown,
  abortSignal: AbortSignal,
): GroupFailureClassification {
  // 取消优先于一切：用户 Stop / turn abort / deadline 取消都不 failover（spec §11：
  // cancellation wins every race；不为用户按 Stop 而 failover）。
  if (abortSignal.aborted || isTurnCancellationError(error, abortSignal)) {
    return { outcome: "cancelled", failoverEligible: false };
  }

  const context = readAdapterErrorContext(error);
  const reason = context.reason;
  const statusCode = context.statusCode;
  const retryable = context.retryable === true;
  const retryAfterMs = context.retryAfterMs;

  // transient：网络/超时/408/5xx/429/overload，或 adapter 明确标记 retryable 的失败。
  if (
    reason === "network_error" ||
    reason === "timeout" ||
    reason === "stream_idle_timeout" ||
    reason === "server_error" ||
    reason === "rate_limited" ||
    reason === "provider_overloaded" ||
    reason === "stale_connection" ||
    statusCode === 408 ||
    statusCode === 429 ||
    (statusCode !== undefined && statusCode >= 500) ||
    retryable
  ) {
    return {
      outcome: "transient_failure",
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      failoverEligible: true,
    };
  }

  // terminal：鉴权 401/403、配额 402/结构化业务码、model 404/not-entitled。
  if (
    reason === "auth_failed" ||
    reason === "provider_not_configured" ||
    statusCode === 401 ||
    statusCode === 402 ||
    statusCode === 403 ||
    statusCode === 404 ||
    context.code === "model_not_found" ||
    context.code === "provider_not_configured" ||
    context.code === "model_request_auth_missing"
  ) {
    return { outcome: "terminal_failure", failoverEligible: false };
  }

  // neutral：policy refusal、无效请求（shared malformed request 不能用成员重试掩盖）、
  // context 超窗（spec §9：request-specific，无 general circuit damage，走既有
  // reactive compact 而非 failover）、内部编程错误与 tool failure。
  if (
    reason === "invalid_request" ||
    reason === "context_exceeded" ||
    context.code === "invalid_model_request" ||
    context.code === "invalid_model_response" ||
    context.code === "model_context_exceeded" ||
    isModelContextExceededError(error)
  ) {
    return { outcome: "neutral", failoverEligible: false };
  }

  // 未知错误：按 spec §9 记 unclassified 诊断并按 neutral 处理，绝不静默当 transient。
  runtime.logger?.warn("Unclassified model group attempt failure; treating as neutral", {
    errorMessage: error instanceof Error ? error.message : String(error),
    errorName: error instanceof Error ? error.name : undefined,
    event: "model.group_attempt.unclassified_failure",
    module: "core.runtime",
    reason,
    status: "failed",
    statusCode,
  });
  return { outcome: "neutral", failoverEligible: false };
}

/** 读取 adapter 归一化错误上下文的稳定字段（与 core error-payload 读取约定一致）。 */
function readAdapterErrorContext(error: unknown): {
  reason?: string;
  statusCode?: number;
  retryable?: boolean;
  retryAfterMs?: number;
  code?: string;
} {
  let current = error;
  const seen = new WeakSet<object>();
  for (let depth = 0; depth <= 6; depth += 1) {
    if (current === null || typeof current !== "object") break;
    if (seen.has(current)) break;
    seen.add(current);
    const record = current as Record<string, unknown>;
    const context =
      record.context !== null && typeof record.context === "object"
        ? (record.context as Record<string, unknown>)
        : undefined;
    if (context) {
      const reason = typeof context.reason === "string" ? context.reason : undefined;
      const statusCode =
        typeof context.statusCode === "number"
          ? context.statusCode
          : typeof context.status === "number"
            ? context.status
            : undefined;
      const retryable = typeof context.retryable === "boolean" ? context.retryable : undefined;
      const retryAfterMs =
        typeof context.retryAfterMs === "number" && Number.isFinite(context.retryAfterMs)
          ? context.retryAfterMs
          : undefined;
      if (reason !== undefined || statusCode !== undefined || retryable !== undefined) {
        return {
          ...(reason === undefined ? {} : { reason }),
          ...(statusCode === undefined ? {} : { statusCode }),
          ...(retryable === undefined ? {} : { retryable }),
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
          ...(typeof record.code === "string" ? { code: record.code } : {}),
        };
      }
    }
    current = record.cause;
  }
  return {};
}

type GroupFailoverDecision =
  | { kind: "retry"; model: Model }
  | { kind: "error"; error: unknown }
  | { kind: "no_budget" };

/**
 * 在同一个逻辑 invocation 内准备下一个成员的物理尝试：
 * - 复用共享 deadline 与尝试预算（spec §9/§11：恢复不重置预算）；
 * - 已尝试成员进入 excluded 集（每成员至多一次物理尝试）；
 * - prepareRoutedAttempt 抛出的结构化组错误原样返回给调用方穿出。
 */
async function tryPrepareGroupFailoverAttempt(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  groupRouting: GroupTurnRoutingState,
  options: {
    excludedMemberId?: string;
  },
): Promise<GroupFailoverDecision> {
  const target = runtime.getSessionExecutionTarget();
  if (!target || target.kind !== "group") return { kind: "no_budget" };

  if (options.excludedMemberId) {
    groupRouting.attemptedMemberIds.add(options.excludedMemberId);
  }

  // failover 关闭：一次物理尝试即终态，返回该成员的结构化失败（spec §9：
  // failover.enabled=false 时不静默 fallthrough）。failover 资格用请求起点
  // 冻结的组快照事实；turn 中途改配置只影响下一逻辑请求。
  if (!groupRouting.failoverEnabled) return { kind: "no_budget" };

  if (groupRouting.attemptsUsed >= groupRouting.maxAttempts) {
    // 预算耗尽（spec §9）：surface GROUP_EXHAUSTED 而不是最后一个成员的原始错误，
    // 否则 UI/恢复链路无法区分「组预算用尽」与「单成员失败」。
    return {
      kind: "error",
      error: new ModelGroupRoutingError(
        "GROUP_EXHAUSTED",
        `Group member attempt budget exhausted after ${groupRouting.attemptsUsed} attempt(s)`,
        { groupId: target.groupId },
      ),
    };
  }
  if (isDeadlineExceeded(Date.now(), groupRouting.deadlineAtMs)) {
    return {
      kind: "error",
      error: new ModelGroupRoutingError(
        "GROUP_DEADLINE_EXCEEDED",
        "Request deadline exhausted; no next group member attempt",
        { groupId: target.groupId },
      ),
    };
  }

  try {
    const prepared = await prepareRoutedAttempt(runtime, {
      target,
      traceContext: state.turnTraceContext,
      requestDependencies: groupRouting.requestDependencies,
      excludedMemberIds: groupRouting.attemptedMemberIds,
      deadlineAt: groupRouting.deadlineAtMs,
      // failover 必须用请求起点冻结的组快照；实时解析会让 attempt 间的
      // revision/成员集漂移，把中途删除误判成普通失败。
      ...(groupRouting.frozenGroup ? { frozenGroup: groupRouting.frozenGroup } : {}),
      signal: state.turnAbortSignal,
    });
    if (!prepared.group || !prepared.reservation) {
      // prepareRoutedAttempt 在组 target 下必然返回 group+reservation；防御性兜底。
      return { kind: "no_budget" };
    }
    groupRouting.attemptsUsed += 1;
    groupRouting.activeReservation = prepared.reservation;
    groupRouting.activeMemberId = prepared.memberId;
    return { kind: "retry", model: prepared.model };
  } catch (error) {
    if (isModelGroupRoutingError(error)) {
      return { kind: "error", error };
    }
    throw error;
  }
}
