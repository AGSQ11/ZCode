import type { ModelSelection } from "@zcode/contracts";
import type { ExecutionTarget } from "@zcode/shared/model-group-types";

export function cloneModelSelection(selection: ModelSelection): ModelSelection {
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(selection.options ? { options: { ...selection.options } } : {}),
  };
}

// structuredClone 对含函数/类实例的对象会抛 DataCloneError 或静默丢原型；
// ExecutionTarget 是普通字面量联合（含 model selection），按形状显式克隆，
// 与 cloneModelSelection 保持同一防御语义（快照/恢复不共享可变引用）。
export function cloneExecutionTarget(target: ExecutionTarget): ExecutionTarget {
  if (target.kind === "model") {
    return { kind: "model", selection: cloneModelSelection(target.selection) };
  }
  return { kind: "group", groupId: target.groupId };
}
