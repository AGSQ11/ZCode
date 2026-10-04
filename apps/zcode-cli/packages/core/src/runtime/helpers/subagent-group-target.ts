import type {
  ExecutionTarget,
  ModelGroup,
  ModelGroupsConfig,
} from "@zcode/shared/model-group-types";
import { createCoreError, CoreErrorType, type ModelSelection } from "../deps.js";
import { cloneModelSelection } from "../model-selection.js";

/**
 * Subagent 模型组意图（spec 2026-10-04 §2.2）：返回本次运行应路由的组 id；
 * undefined 表示继续走既有单模型路径（resolveSubagentSelection）。
 *
 * 优先级：Core Server 具体 override > profile 组 > profile 单模型 > 继承父会话组目标。
 * 父会话为组时 sessionModelSelection 为空，若不在这里继承组，子任务会因
 * selection-missing 直接启动失败。
 */
export function resolveSubagentGroupIntent(input: {
  overrideSelection?: ModelSelection;
  profileGroupId?: string;
  profileSelection?: ModelSelection | null;
  parentTarget?: ExecutionTarget;
}): string | undefined {
  if (input.overrideSelection) return undefined;
  if (input.profileGroupId) return input.profileGroupId;
  if (input.profileSelection) return undefined;
  return input.parentTarget?.kind === "group" ? input.parentTarget.groupId : undefined;
}

/**
 * 启动前按 live 配置校验组（spec §2.3），并挑选 child 预塑形预算用的代表成员（spec §3）：
 * 父 turn 正在使用的成员属于该组时沿用它，否则取第一个启用成员。代表成员只用于
 * context/token 预算的初始形状；child 的权威意图是 group executionTarget。
 *
 * 组不可用时直接报错，不回落父模型：那会悄悄改变用户显式指定的子任务模型。
 */
export function resolveSubagentGroupLaunch(input: {
  groupId: string;
  groupsConfig: ModelGroupsConfig | undefined;
  routerAvailable: boolean;
  activeParentSelection?: Pick<ModelSelection, "providerId" | "modelId">;
}): { group: ModelGroup; representativeSelection: ModelSelection } {
  const group = input.groupsConfig?.groups.find((candidate) => candidate.id === input.groupId);
  const enabledMembers = group?.enabled ? group.members.filter((member) => member.enabled) : [];
  const firstMember = enabledMembers[0];
  if (!group || !firstMember || !input.routerAvailable) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      `Cannot start subagent: Model group unavailable / 模型组不可用 [reason=group-unavailable; group=${input.groupId}]`,
      {
        recoverable: true,
        context: { reason: "group-unavailable", groupId: input.groupId },
      },
    );
  }
  const active = input.activeParentSelection;
  const routedMember = active
    ? enabledMembers.find(
        (member) =>
          member.selection.providerId === active.providerId &&
          member.selection.modelId === active.modelId,
      )
    : undefined;
  return {
    group,
    representativeSelection: cloneModelSelection((routedMember ?? firstMember).selection),
  };
}
