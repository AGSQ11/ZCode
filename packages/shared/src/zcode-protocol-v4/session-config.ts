import { z } from "zod";
import { modelSelectionSchema } from "../model-selection.js";
import { executionTargetSchema } from "../model-group-types.js";

// ── config──
export const sessionConfigStateSchema = z.object({
  /** Session 接受并持久化的稀疏选择意图；provider/model/thought 仅为 UI effective 投影。 */
  modelSelection: modelSelectionSchema.optional(),
  /** Session 接受并持久化的结构化执行目标（直接模型或模型组）。 */
  executionTarget: executionTargetSchema.optional(),
  provider: z.string(),
  model: z.string(),
  thought: z.string(),
  // 思考档位是当前模型的能力，不是 workspace/UI 偏好。
  // default 仅用于兼容旧快照；新 agent 必须从 runtime 投影实际集合。
  thoughtLevels: z.array(z.string()).default([]),
  followupMode: z.enum(["queue", "guide"]),
  // additive（冻结面演进，同 meta 的裁决口径）：agent 协作模式（core CollaborationMode）。
  // 必须带 default 才不破坏旧快照/旧发送端的解析；投影经 SessionModeChanged 事件更新。
  mode: z.string().default("build"),
  planEnabled: z.boolean().optional(),
  /** 明确审批结果；草稿按 interactionId 消费一次，普通 mode 更新不重置它。 */
  permissionGrant: z.object({ interactionId: z.string().min(1) }).optional(),
  /** 最近工具转换的关联，供草稿定向同步；不新增可见历史事件。 */
  planTransition: z
    .object({
      toolCallId: z.string(),
      planEnabled: z.boolean(),
    })
    .optional(),
})
.superRefine((state, ctx) => {
  // executionTarget 与 modelSelection 同为可选独立字段，但必须互相一致：
  // 若二者同现，modelTarget.selection 必须等于 modelSelection，否则旧字段会
  // 以过期具体模型压过组/目标意图（P1 悬空一致性）。
  if (state.executionTarget?.kind === "model" && state.modelSelection) {
    const sel = state.executionTarget.selection;
    const ms = state.modelSelection;
    if (sel.providerId !== ms.providerId || sel.modelId !== ms.modelId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "executionTarget selection must match modelSelection when both are present",
        path: ["executionTarget"],
      });
    }
  }
});
export type SessionConfigState = z.infer<typeof sessionConfigStateSchema>;

export const sessionModelTransitionSchema = z.object({
  eventId: z.string().min(1),
  origin: z.literal("registryFallback"),
  from: z.object({
    provider: z.string(),
    model: z.string(),
  }),
  to: z.object({
    provider: z.string(),
    model: z.string(),
  }),
});
export type SessionModelTransition = z.infer<typeof sessionModelTransitionSchema>;
