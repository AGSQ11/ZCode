import {
  SESSION_ENTRY_MODEL_SELECTION,
  SESSION_ENTRY_EXECUTION_TARGET,
  SessionEventType,
  type Model,
  type ModelSelection,
  type TraceContext,
  type TurnInputIntentMetadata,
} from "@zcode/contracts";
import type { ExecutionTarget, ModelGroup } from "@zcode/shared/model-group-types";
import { getCurrentModelInvocationContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { cloneModelSelection } from "../model-selection.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import { createRuntimeModel, withModelInvocationContext } from "./runtime-model.js";
import { applyRuntimeExecutionState } from "../execution-state.js";

export function createTurnModel(
  runtime: AgentRuntimeInternal,
  options: {
    selection?: ModelSelection;
    requestDependencies?: import("@zcode/contracts").ModelRequestDependencies;
    singlePhysicalAttempt?: boolean;
  } = {},
): Model {
  const selection = options.selection ?? runtime.getSessionModelSelection();
  const baseModel = createRuntimeModel(runtime, {
    selection,
    requestDependencies: options.requestDependencies,
  });
  return withModelInvocationContext(baseModel, (request) => ({
    ...(options.singlePhysicalAttempt ? { modelRetryBudget: "single_physical_attempt" } : {}),
    refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(runtime, {
      abortSignal: request.abortSignal,
      model: baseModel,
      traceContext: getCurrentModelInvocationContext()?.traceContext ?? runtime.rootTraceContext,
    }),
  }));
}

export async function persistRuntimeExecutionTarget(
  runtime: AgentRuntimeInternal,
  target: ExecutionTarget,
): Promise<void> {
  if (!runtime.sessionStore?.saveSessionEntry) return;
  const timestamp = Date.now();
  try {
    await runtime.sessionStore.saveSessionEntry({
      id: `${runtime.sessionId}:runtime-execution-target`,
      sessionID: runtime.sessionId,
      type: SESSION_ENTRY_EXECUTION_TARGET,
      touchSession: false,
      time: { created: timestamp, updated: timestamp },
      data: target,
    });
  } catch (error) {
    runtime.logger?.warn("Session execution target persistence failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "session.execution_target.persist_failed",
    });
  }
}

/**
 * 路由并准备一个模型请求尝试（核心单点缝合）。
 */
export async function prepareRoutedAttempt(
  runtime: AgentRuntimeInternal,
  options: {
    target?: ExecutionTarget;
    traceContext: TraceContext;
    requestDependencies?: import("@zcode/contracts").ModelRequestDependencies;
    excludedMemberIds?: ReadonlySet<string>;
    signal?: AbortSignal;
  },
): Promise<{
  model: Model;
  selection: ModelSelection;
  group?: ModelGroup;
  memberId?: string;
  reservation?: import("../model-group-router.js").ReservationLease;
}> {
  const target = options.target ?? runtime.getSessionExecutionTarget();

  // 直接单模型分支
  if (!target || target.kind === "model") {
    const selection = target ? target.selection : runtime.getSessionModelSelection();
    if (!selection) {
      throw new Error("No model selection available for execution");
    }
    const model = createTurnModel(runtime, {
      selection,
      requestDependencies: options.requestDependencies,
    });
    return { model, selection };
  }

  // 模型组分支
  const router = runtime.modelGroupRouter;
  if (!router) {
    throw new Error("ModelGroupRouter is not available in runtime");
  }

  const groupsConfig = await (runtime.config as any).modelGroupsConfig;
  const group = groupsConfig?.groups.find((g: ModelGroup) => g.id === target.groupId);
  if (!group) {
    throw new Error(`Model group not found: ${target.groupId}`);
  }
  if (!group.enabled) {
    throw new Error(`Model group is disabled: ${group.name}`);
  }

  const excluded = options.excludedMemberIds ?? new Set<string>();

  // Turn affinity check: if turn pin exists, prefer pinned member
  if (group.affinity === "turn" && runtime.turnPinnedMemberId && !excluded.has(runtime.turnPinnedMemberId)) {
    const pinnedMember = group.members.find((m: any) => m.id === runtime.turnPinnedMemberId && m.enabled);
    if (pinnedMember) {
      // Validate pin
      const res = await router.selectAndReserve(
        { ...group, members: [pinnedMember] },
        new Set(),
      );
      if (res.routedAttempt) {
        const { member, attemptNumber, reservation } = res.routedAttempt;
        const model = createTurnModel(runtime, {
          selection: member.selection,
          requestDependencies: options.requestDependencies,
          singlePhysicalAttempt: true,
        });
        await runtime.emitModelGroupRouted({
          payload: {
            groupId: group.id,
            groupName: group.name,
            groupRevision: group.revision,
            memberId: member.id,
            attemptNumber,
            maxAttempts: Math.min(group.failover.maxMemberAttempts, group.members.length),
            actualSelection: member.selection,
            reason: "turn_pin",
          },
          traceContext: options.traceContext,
        });
        return {
          model,
          selection: member.selection,
          group,
          memberId: member.id,
          reservation,
        };
      }
    }
  }

  // Strategy routing
  const res = await router.selectAndReserve(group, excluded);
  if (!res.routedAttempt) {
    if (res.allCoolingDown) {
      throw new Error("GROUP_COOLING_DOWN: All group members are cooling down");
    }
    if (res.allBusy) {
      throw new Error("GROUP_BUSY: All group members have exceeded concurrent in-flight capacity");
    }
    throw new Error("GROUP_EXHAUSTED: No eligible group members available");
  }

  const { member, attemptNumber, reservation } = res.routedAttempt;
  if (group.affinity === "turn") {
    runtime.turnPinnedMemberId = member.id;
  }

  const model = createTurnModel(runtime, {
    selection: member.selection,
    requestDependencies: options.requestDependencies,
    singlePhysicalAttempt: true,
  });

  await runtime.emitModelGroupRouted({
    payload: {
      groupId: group.id,
      groupName: group.name,
      groupRevision: group.revision,
      memberId: member.id,
      attemptNumber,
      maxAttempts: Math.min(group.failover.maxMemberAttempts, group.members.length),
      actualSelection: member.selection,
      reason: excluded.size > 0 ? "failover" : "initial",
    },
    traceContext: options.traceContext,
  });

  return {
    model,
    selection: member.selection,
    group,
    memberId: member.id,
    reservation,
  };
}

/**
 * 在 Submission 真正开始执行或 Guide 被下一次 model step 消费时应用其执行配置。
 * 选择只决定新创建的 Model；已经被其他 Loop 持有的 Model 不会被修改。
 */
export async function applySubmissionExecutionState(
  runtime: AgentRuntimeInternal,
  intent: TurnInputIntentMetadata | undefined,
  traceContext: TraceContext,
  modelExecution?: import("../types.js").ModelExecutionContext,
  preparedModel?: Model,
): Promise<Model | undefined> {
  const selection = intent?.modelSelection;
  const executionTarget = (intent as any)?.executionTarget;
  const previousSelection = runtime.getSessionModelSelection();
  let model = preparedModel;

  if (executionTarget) {
    runtime.setSessionExecutionTarget(executionTarget);
    await persistRuntimeExecutionTarget(runtime, executionTarget);
  }

  if (selection) {
    model ??= createTurnModel(runtime, {
      selection,
      requestDependencies: modelExecution?.requestDependencies,
    });
    if (modelExecution?.selectionScope !== "execution") {
      const appliedSelection = cloneModelSelection(selection);
      runtime.setSessionModelSelection(appliedSelection);
      await persistRuntimeModelSelection(runtime, appliedSelection);
      if (!sameModelSelection(previousSelection, appliedSelection)) {
        await runtime.emitModelSelected({
          model,
          modelSelection: appliedSelection,
          effectiveReasoningLevel: model.options.reasoningLevel,
          previousModelSelection: previousSelection,
          supportedThoughtLevels: model.optionSpecs.reasoningLevel.values,
          traceContext,
        });
      }
    }
  }

  if (intent?.mode !== undefined || intent?.planEnabled !== undefined) {
    await applyRuntimeExecutionState(runtime, intent, { source: "command", traceContext });
  }

  return model;
}

export function sameModelSelection(
  left: ModelSelection | undefined,
  right: ModelSelection,
): boolean {
  return (
    left?.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.options?.reasoningLevel === right.options?.reasoningLevel
  );
}

export async function persistRuntimeModelSelection(
  runtime: AgentRuntimeInternal,
  selection: ModelSelection,
): Promise<void> {
  if (!runtime.sessionStore?.saveSessionEntry) return;
  const timestamp = Date.now();
  try {
    await runtime.sessionStore.saveSessionEntry({
      id: `${runtime.sessionId}:runtime-model-selection`,
      sessionID: runtime.sessionId,
      type: SESSION_ENTRY_MODEL_SELECTION,
      touchSession: false,
      time: { created: timestamp, updated: timestamp },
      data: selection,
    });
  } catch (error) {
    runtime.logger?.warn("Session model selection persistence failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "session.model_selection.persist_failed",
      modelId: selection.modelId,
      module: "core.runtime",
      providerId: selection.providerId,
      status: "failed",
      thoughtLevel: selection.options?.reasoningLevel,
    });
  }
}
