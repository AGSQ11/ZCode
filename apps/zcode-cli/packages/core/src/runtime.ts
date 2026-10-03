export { AgentRuntime } from "./runtime/agent-runtime.js";
// ModelGroupRouter 是 bootstrap 注入 AgentRuntime deps 的值级依赖；经 core
// 公开入口导出，bootstrap 才能用公共路径实例化，不引用 runtime 内部文件。
export { ModelGroupRouter } from "./runtime/model-group-router.js";
export type {
  ModelGroupRouterOptions,
  ReservationLease,
  RoutedAttempt,
  CandidateRejection,
} from "./runtime/model-group-router.js";
export type {
  WorkspaceGenerateTextInput,
  WorkspaceGenerateTextResult,
} from "./runtime/methods/workspace-generate-text.js";
export type { StartSavedWorkflowRunResult } from "./runtime/methods/dynamic-workflow-run-start.js";
export type {
  AmendWorkflowRunSettingsInput,
  AmendWorkflowRunSettingsResult,
} from "./runtime/methods/dynamic-workflow-run-settings.js";
export type {
  ActiveTurnInfo,
  AgentRuntimeConfig,
  AgentRuntimeDeps,
  ConversationRewindResult,
  ExecuteTurnOptions,
  ModelExecutionContext,
  PromptAdmissionOptions,
  PromptAdmissionReceipt,
  PermissionDecisionResult,
  ProviderRuntimeHeadersPort,
  ResumeSessionOptions,
  ResumeSessionResult,
  StopActiveForegroundExecutionOptions,
  StopActiveForegroundExecutionResult,
  TurnResult,
  WorkspaceCheckpointSummary,
  WorkspaceFileRewindApplyResult,
  WorkspaceFileRewindPreview,
  WorkspaceForkResult,
  WorkspaceRewindRestoredFile,
  WorkspaceRewindResult,
} from "./runtime/types.js";

import type { AgentRuntime } from "./runtime/agent-runtime.js";
import type { AgentRuntimeConfig } from "./runtime/types.js";

export interface RuntimeFactory {
  create(config: AgentRuntimeConfig): Promise<AgentRuntime>;
}
