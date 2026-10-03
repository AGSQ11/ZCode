import {
  SESSION_ENTRY_MODEL_SELECTION,
  SESSION_ENTRY_EXECUTION_TARGET,
  type Model,
  type ModelSelection,
  type TraceContext,
  type TurnInputIntentMetadata,
} from "@zcode/contracts";
import type {
  ExecutionTarget,
  ModelGroup,
  ModelGroupsConfig,
} from "@zcode/shared/model-group-types";
import { isDeadlineExceeded, computeRequestDeadlineMs } from "@zcode/shared/model-group-routing";
import { getCurrentModelInvocationContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { cloneModelSelection } from "../model-selection.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import { createRuntimeModel, withModelInvocationContext } from "./runtime-model.js";
import { applyRuntimeExecutionState } from "../execution-state.js";
import type { ReservationLease } from "../model-group-router.js";

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
 * 模型组路由错误：消息前缀即结构化代码（GROUP_EXHAUSTED / GROUP_DEADLINE_EXCEEDED /
 * GROUP_COOLING_DOWN / GROUP_BUSY），spec §9 要求它们在 core/workflow-driver 边界保持
 * 显式终态，不能被外层通用重试 unwrap 成普通模型错误。core 不得 import adapter
 * 内部类型，这里用最小的本地 Error 子类携带稳定 code 字段。
 */
export class ModelGroupRoutingError extends Error {
  readonly code: string;
  readonly groupId?: string;
  readonly rejections?: readonly { memberId: string; reason: string }[];

  constructor(
    code: "GROUP_EXHAUSTED" | "GROUP_DEADLINE_EXCEEDED" | "GROUP_COOLING_DOWN" | "GROUP_BUSY",
    message: string,
    options?: { groupId?: string; rejections?: readonly { memberId: string; reason: string }[] },
  ) {
    super(`${code}: ${message}`);
    this.name = "ModelGroupRoutingError";
    this.code = code;
    this.groupId = options?.groupId;
    this.rejections = options?.rejections;
  }
}

export function isModelGroupRoutingError(error: unknown): error is ModelGroupRoutingError {
  return error instanceof ModelGroupRoutingError;
}

/**
 * 读取 modelGroupsConfig：AgentRuntimeConfig 允许快照或 async 函数两种形态
 * （bootstrap 函数形式接 live Personal Repository，spec §6：组编辑必须影响下一条
 * 被 admission 的 turn）。此前 `(runtime.config as any).modelGroupsConfig` 只 await
 * 原值，函数形态会得到函数本身而非配置，组路由静默拿到 undefined。
 */
export async function resolveModelGroupsConfig(
  runtime: AgentRuntimeInternal,
): Promise<ModelGroupsConfig | undefined> {
  const source = runtime.config.modelGroupsConfig;
  if (typeof source === "function") {
    return await source();
  }
  return source;
}

/** prepareRoutedAttempt 的路由结果；turn/turn-model-step 据此驱动 failover。 */
export interface PreparedRoutedAttempt {
  model: Model;
  selection: ModelSelection;
  group?: ModelGroup;
  memberId?: string;
  reservation?: ReservationLease;
  /** 本次逻辑请求的绝对 deadline（ms，Date.now 域）；无组或组未启用 failover deadline 时为 undefined。 */
  deadlineMs?: number;
  /** 当前物理尝试序号（1 起）。 */
  attemptNumber?: number;
  /** 本次逻辑请求的物理尝试预算：min(maxMemberAttempts, enabled member count)。 */
  maxAttempts?: number;
}

/** 计算组 failover 的物理尝试预算（spec §9：初始请求计为 attempt 1）。 */
export function computeGroupAttemptBudget(group: ModelGroup): number {
  const enabledMemberCount = group.members.filter((m) => m.enabled).length;
  return Math.max(1, Math.min(group.failover.maxMemberAttempts, enabledMemberCount));
}

/**
 * 组路由的 turn-loop 载体。RegularTurnLoopState 的接口归 turn-loop-state.ts 所有，
 * 本字段在 turn.ts 构造 loopState 时以类型断言附加，turn-model-step.ts 经
 * readGroupTurnRouting 读回--跨文件的唯一约定点就是这个属性名。
 */
export const GROUP_TURN_ROUTING_STATE_KEY = "groupTurnRouting" as const;

export interface GroupTurnRoutingState {
  /** 逻辑请求起点（Date.now ms），deadline 与遥测共用。 */
  requestStartedAtMs: number;
  /** 逻辑请求绝对 deadline（computeRequestDeadlineMs 输出）。 */
  deadlineAtMs: number;
  /** 本次逻辑请求已消耗的物理尝试数（含当前在飞）。 */
  attemptsUsed: number;
  /** 物理尝试预算：min(maxMemberAttempts, enabled member count)。 */
  maxAttempts: number;
  /** 本次逻辑请求已尝试过的成员（物理尝试每成员至多一次，spec §9）。 */
  attemptedMemberIds: Set<string>;
  /** 当前在飞物理尝试的 lease；turn-model-step 的 finally 必须恰好 release 一次。 */
  activeReservation?: ReservationLease;
  /** 当前在飞物理尝试的成员。 */
  activeMemberId?: string;
  /** 首个尝试使用的 requestDependencies；failover 重选成员时沿用同一份。 */
  requestDependencies?: import("@zcode/contracts").ModelRequestDependencies;
  /**
   * 逻辑请求起点的组 failover.enabled 快照。failover 资格判定必须用请求起点的
   * 冻结事实；turn 中途改配置只影响下一条被 admission 的 turn（spec §6）。
   */
  failoverEnabled: boolean;
}

export function readGroupTurnRouting(state: unknown): GroupTurnRoutingState | undefined {
  if (state === null || typeof state !== "object") return undefined;
  const value = (state as Record<string, unknown>)[GROUP_TURN_ROUTING_STATE_KEY];
  return value === null || typeof value !== "object" ? undefined : (value as GroupTurnRoutingState);
}

/**
 * 路由并准备一个模型请求尝试（核心单点缝合）。
 *
 * P0-1：executeTurn 的组分支与 turn-model-step 的 failover 都必须经此创建 Model；
 * 只有这里发出的 Model 才绑定 single_physical_attempt 预算与成员级路由事件。
 *
 * deadlineAt 为本次逻辑请求的绝对超时点（由调用方在逻辑请求起点用
 * computeRequestDeadlineMs 算出）；在选择新成员前已超时即抛 GROUP_DEADLINE_EXCEEDED，
 * 不再发起新的物理尝试（spec §9：deadline 到期中止 pending work，无下一次尝试）。
 */
export async function prepareRoutedAttempt(
  runtime: AgentRuntimeInternal,
  options: {
    target?: ExecutionTarget;
    traceContext: TraceContext;
    requestDependencies?: import("@zcode/contracts").ModelRequestDependencies;
    excludedMemberIds?: ReadonlySet<string>;
    deadlineAt?: number;
    signal?: AbortSignal;
  },
): Promise<PreparedRoutedAttempt> {
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

  const groupsConfig = await resolveModelGroupsConfig(runtime);
  const group = groupsConfig?.groups.find((g: ModelGroup) => g.id === target.groupId);
  if (!group) {
    throw new Error(`Model group not found: ${target.groupId}`);
  }
  if (!group.enabled) {
    throw new Error(`Model group is disabled: ${group.name}`);
  }

  const maxAttempts = computeGroupAttemptBudget(group);
  const excluded = options.excludedMemberIds ?? new Set<string>();

  // deadline 在路由开始处启动（spec §9：requestDeadlineMs 覆盖候选准备、准入、
  // 网络尝试与恢复）。调用方在 failover 重选时传入共享 deadline；首次路由则由
  // 这里按组的 requestDeadlineMs 现场计算并随结果返回。
  const deadlineAt =
    options.deadlineAt ?? computeRequestDeadlineMs(Date.now(), group.failover.requestDeadlineMs);

  // deadline 门：任何新成员选择（含 pin 复用与 failover 重选）之前判定；
  // 已过期请求不得再消耗成员尝试预算（spec §9）。
  if (isDeadlineExceeded(Date.now(), deadlineAt)) {
    throw new ModelGroupRoutingError(
      "GROUP_DEADLINE_EXCEEDED",
      "Request deadline exhausted before selecting a group member",
      { groupId: group.id },
    );
  }

  // Turn affinity check: if turn pin exists, prefer pinned member
  if (group.affinity === "turn" && runtime.turnPinnedMemberId && !excluded.has(runtime.turnPinnedMemberId)) {
    const pinnedMember = group.members.find((m) => m.id === runtime.turnPinnedMemberId && m.enabled);
    if (pinnedMember) {
      // P1-2：pin 路径必须用 reservePinnedMember--此前用单成员假组调
      // selectAndReserve，其末尾 setGroupCursor(group.id, (0+1)%1=0) 会在每次
      // pin 复用时把真实组的 round_robin/平局游标静默重置为 0。
      const res = await router.reservePinnedMember(group, pinnedMember);
      if (res.routedAttempt) {
        const { member, attemptNumber, reservation } = res.routedAttempt;
        const model = createTurnModel(runtime, {
          selection: member.selection,
          requestDependencies: options.requestDependencies,
          singlePhysicalAttempt: true,
        });
        try {
          await runtime.emitModelGroupRouted({
            payload: {
              groupId: group.id,
              groupName: group.name,
              groupRevision: group.revision,
              memberId: member.id,
              attemptNumber,
              maxAttempts,
              actualSelection: member.selection,
              reason: "turn_pin",
            },
            traceContext: options.traceContext,
          });
        } catch (error) {
          // 事件下发失败时租约已持有且不会到达调用方，必须就地释放，
          // 否则在飞计数永久泄漏（悬空租约）。
          reservation.release("neutral");
          throw error;
        }
        return {
          model,
          selection: member.selection,
          group,
          memberId: member.id,
          reservation,
          deadlineMs: deadlineAt,
          attemptNumber,
          maxAttempts,
        };
      }
      // pin 失效（冷却/容量/连接不可用）：落入策略路由重选；若因容量改用其他成员，
      // spec §8 要求记录 capacity 迁移原因。
    }
  }

  // Strategy routing
  const res = await router.selectAndReserve(group, excluded);
  if (!res.routedAttempt) {
    if (res.allCoolingDown) {
      throw new ModelGroupRoutingError(
        "GROUP_COOLING_DOWN",
        "All group members are cooling down",
        { groupId: group.id, rejections: res.rejections },
      );
    }
    if (res.allBusy) {
      throw new ModelGroupRoutingError(
        "GROUP_BUSY",
        "All group members have exceeded concurrent in-flight capacity",
        { groupId: group.id, rejections: res.rejections },
      );
    }
    throw new ModelGroupRoutingError("GROUP_EXHAUSTED", "No eligible group members available", {
      groupId: group.id,
      rejections: res.rejections,
    });
  }

  const { member, attemptNumber, reservation } = res.routedAttempt;
  const previousPin = group.affinity === "turn" ? runtime.turnPinnedMemberId : undefined;
  if (group.affinity === "turn") {
    runtime.turnPinnedMemberId = member.id;
  }

  const model = createTurnModel(runtime, {
    selection: member.selection,
    requestDependencies: options.requestDependencies,
    singlePhysicalAttempt: true,
  });

  try {
    await runtime.emitModelGroupRouted({
      payload: {
        groupId: group.id,
        groupName: group.name,
        groupRevision: group.revision,
        memberId: member.id,
        attemptNumber,
        maxAttempts,
        actualSelection: member.selection,
        reason:
          excluded.size > 0
            ? "failover"
            : previousPin && previousPin !== member.id
              ? "capacity"
              : "initial",
        ...(previousPin && previousPin !== member.id
          ? { transitionFromMemberId: previousPin }
          : {}),
      },
      traceContext: options.traceContext,
    });
  } catch (error) {
    // 事件下发失败时租约已持有且不会到达调用方，必须就地释放，
    // 否则在飞计数永久泄漏（悬空租约）。
    reservation.release("neutral");
    throw error;
  }

  return {
    model,
    selection: member.selection,
    group,
    memberId: member.id,
    reservation,
    deadlineMs: deadlineAt,
    attemptNumber,
    maxAttempts,
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
