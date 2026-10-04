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
// options 叶子必须深克隆--单层 spread 会保留嵌套对象与 runtime live 状态的
// 共享引用，把「快照隔离」变成只隔了表皮。
export function cloneExecutionTarget(target: ExecutionTarget): ExecutionTarget {
  if (target.kind === "model") {
    return {
      kind: "model",
      selection: {
        providerId: target.selection.providerId,
        modelId: target.selection.modelId,
        ...(target.selection.options
          ? { options: deepClonePlainValue(target.selection.options) as typeof target.selection.options }
          : {}),
      },
    };
  }
  return { kind: "group", groupId: target.groupId };
}

function deepClonePlainValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => deepClonePlainValue(item));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error("cloneExecutionTarget cannot clone non-plain option values");
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      deepClonePlainValue(item),
    ]),
  );
}
