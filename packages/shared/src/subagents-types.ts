import type { ZCodeProvider } from "./zcode-task-types-core.js";
import { modelSelectionSchema, type ModelSelection } from "./model-selection.js";

export type AgentScope = "built-in" | "workspace" | "user";

export type AgentSource = "built-in" | "user" | "plugin";

export type BuiltInSubagentName = "general-purpose" | "Explore";

export type BuiltInSubagentModelSelectionOverrides = Partial<
  Record<BuiltInSubagentName, ModelSelection>
>;

export type PluginSubagentModelSelectionOverrides = Readonly<Record<string, ModelSelection>>;

/** 内置 subagent 的模型组覆盖（组 id）；与同名 ModelSelection 覆盖互斥，并存时组优先。 */
export type BuiltInSubagentModelGroupOverrides = Partial<Record<BuiltInSubagentName, string>>;

/** 插件 subagent 的模型组覆盖（键为 createPluginAgentStateId，值为组 id）。 */
export type PluginSubagentModelGroupOverrides = Readonly<Record<string, string>>;

function parseGroupIdRecord(
  value: unknown,
  acceptKey: (key: string) => boolean,
): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, candidate]) => {
      const groupId = typeof candidate === "string" ? candidate.trim() : "";
      return acceptKey(key) && groupId ? [[key, groupId]] : [];
    }),
  );
}

const BUILT_IN_SUBAGENT_NAMES: ReadonlySet<string> = new Set(["general-purpose", "Explore"]);

/** 正式 reader：只接受内置名称到非空组 id 的映射，损坏值逐项丢弃。 */
export function parseBuiltInSubagentModelGroupOverrides(
  value: unknown,
): BuiltInSubagentModelGroupOverrides {
  return parseGroupIdRecord(value, (key) => BUILT_IN_SUBAGENT_NAMES.has(key));
}

/** 正式 reader：只接受 plugin: 身份到非空组 id 的映射，损坏值逐项丢弃。 */
export function parsePluginSubagentModelGroupOverrides(
  value: unknown,
): PluginSubagentModelGroupOverrides {
  return parseGroupIdRecord(value, (key) => key.startsWith("plugin:"));
}

/** 正式 reader 只接受结构化覆盖，不在读取时解释旧双 map 或重新匹配 Provider。 */
export function parsePluginSubagentModelSelectionOverrides(
  value: unknown,
): PluginSubagentModelSelectionOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([id, candidate]) => {
      const selection = modelSelectionSchema.safeParse(candidate);
      return id.startsWith("plugin:") && selection.success ? [[id, selection.data]] : [];
    }),
  );
}

export type AgentPermissionMode = "auto" | "plan";

export type AgentColor =
  | "red"
  | "blue"
  | "green"
  | "yellow"
  | "purple"
  | "orange"
  | "pink"
  | "cyan";

export type SubagentsListMode = "allRuntimeScopes" | "settingsUserOnly";

export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  color?: AgentColor;
  modelSelection?: ModelSelection;
  defaultModelSelection?: ModelSelection;
  modelSelectionOverride?: ModelSelection;
  /** 生效的模型组意图；存在时 modelSelection 为空（两者互斥）。 */
  modelGroupId?: string;
  /** 插件 agent 自身 Markdown 声明的组（未被覆盖前的默认值）。 */
  defaultModelGroupId?: string;
  /** 用户在设置页写入的组覆盖（内置/插件 agent）。 */
  modelGroupIdOverride?: string;
  tools?: string[];
  disallowedTools?: string[];
  injectAgentsMd?: boolean;
  skills?: string[];
  permissionMode?: AgentPermissionMode;
  maxTurns?: number;
  background?: boolean;
  mcpServers?: unknown[];
  path: string;
  scope: AgentScope;
  source: AgentSource;
  enabled: boolean;
  readOnly?: boolean;
  projectPath?: string;
  pluginId?: string;
  pluginName?: string;
  diagnostics?: AgentDiagnostic[];
}

export interface AgentDiagnostic {
  code: string;
  message: string;
  path?: string;
}

export interface AgentsCapability {
  userScopeAvailable: boolean;
  userScopeReason?: "desktop_only";
}

export interface AgentsListResult {
  agents: AgentSummary[];
  userAgents: AgentSummary[];
  pluginAgents: AgentSummary[];
  capability: AgentsCapability;
  diagnostics?: AgentDiagnostic[];
}

/** Agent 配置，用于创建/更新 agent */
export interface SubAgentConfig {
  name: string;
  description: string;
  systemPrompt: string;
  color?: AgentColor;
  modelSelection?: ModelSelection;
  /** 模型组意图；与 modelSelection 互斥，写入 Markdown 为 `model: group:<id>`。 */
  modelGroupId?: string;
  tools?: string[];
  disallowedTools?: string[];
  injectAgentsMd?: boolean;
  skills?: string[];
  permissionMode?: AgentPermissionMode;
  maxTurns?: number;
  background?: boolean;
  mcpServers?: unknown[];
}

/** Agent 创建参数 */
export interface AgentCreateParams {
  config: SubAgentConfig;
  provider: ZCodeProvider;
  scope?: "user" | "workspace";
  workspacePath?: string;
  workspaceIdentity?: string;
}

/** Agent 更新参数 */
export interface AgentUpdateParams {
  agentId: string;
  config: SubAgentConfig;
  oldFilePath?: string;
  provider: ZCodeProvider;
  scope?: "user" | "workspace";
  workspacePath?: string;
  workspaceIdentity?: string;
}

/** Agent 删除参数 */
export interface AgentDeleteParams {
  agentId: string;
  filePath: string;
}

/** modelSelection 与 modelGroupId 至多给一个；都缺省表示清除覆盖、回到继承。 */
export interface BuiltInSubagentModelOverrideParams {
  agentName: BuiltInSubagentName;
  modelSelection?: ModelSelection;
  modelGroupId?: string;
}

export interface PluginSubagentModelOverrideParams {
  agentId: string;
  modelSelection?: ModelSelection;
  modelGroupId?: string;
}

/**
 * 插件 subagent 的稳定 id：`plugin:<pluginId>:<裸名小写>`。
 * pluginId 为 `<name>@<marketplace>`，不含版本，插件升级后 id 不变，覆盖随之保留。
 * services 与 CLI bootstrap 都用它做 agents-state.json 的键，必须共用一处实现。
 */
export function createPluginAgentStateId(pluginId: string, agentName: string): string {
  return `plugin:${pluginId}:${agentName.trim().toLowerCase()}`;
}

export function createAgentStateId(input: {
  name: string;
  scope: AgentScope;
  source: AgentSource;
}): string {
  return `${input.source}:${input.scope}:${input.name.trim().toLowerCase()}`;
}
