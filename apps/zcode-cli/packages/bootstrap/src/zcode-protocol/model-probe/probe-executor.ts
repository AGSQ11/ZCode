// apps/zcode-cli/packages/bootstrap/src/zcode-protocol/model-probe/probe-executor.ts
// 探测执行器：为整个 workspace 复用单个 workspace app。
// 早期实现每次探测都 testProviderModelConnectivity/createWorkspaceZCodeApp，
// 没有活跃会话时每条模型都要新建完整 app（106 个模型 ≈ 100+ 次启动），全部撞 30s 超时。
// 这里把 app 惰性创建一次并缓存到 context dispose，探测只发最小 completion。
import type { ZCodeProtocolAgentServerContext } from "../server-types.js";
import type { ZCodeWorkspaceRef } from "@zcode/shared";
import type { ZCodeApp } from "../../app/types.js";
import type { ModelProbeProbeExecutor } from "./model-probe-engine.js";
import { createWorkspaceZCodeApp } from "../workspace-model-runtime.js";
import { createInMemorySessionEventStore } from "@zcode/contracts";

const PROBE_MAX_OUTPUT_TOKENS = 8;
const PROBE_PROMPT = "Reply with exactly OK.";

// 每个 context+workspaceKey 缓存一个探测 app；先等在建的那一个，避免并发重复建。
const probeAppCache = new WeakMap<
  ZCodeProtocolAgentServerContext,
  Map<string, Promise<ZCodeApp>>
>();

function findActiveApp(
  context: ZCodeProtocolAgentServerContext,
  workspace: ZCodeWorkspaceRef,
): ZCodeApp | undefined {
  return Array.from(context.sessions.values()).find(
    (record) => record.workspace.workspaceKey === workspace.workspaceKey,
  )?.app;
}

async function getProbeApp(
  context: ZCodeProtocolAgentServerContext,
  workspace: ZCodeWorkspaceRef,
): Promise<ZCodeApp> {
  // 优先复用该 workspace 已有会话的 app，不另起。
  const active = findActiveApp(context, workspace);
  if (active) return active;

  let perWorkspace = probeAppCache.get(context);
  if (!perWorkspace) {
    perWorkspace = new Map();
    probeAppCache.set(context, perWorkspace);
  }
  let pending = perWorkspace.get(workspace.workspaceKey);
  if (!pending) {
    pending = createWorkspaceZCodeApp(context, workspace, {
      env: context.deps.env,
      eventStore: createInMemorySessionEventStore(),
      runtimeConfig: { workingDirectory: workspace.workspacePath },
      sessionStore: context.deps.sessionStore,
      version: context.deps.version,
    });
    perWorkspace.set(workspace.workspaceKey, pending);
    // 建失败要清缓存，下一次探测能重试；成功则长期持有。
    pending.catch(() => perWorkspace.delete(workspace.workspaceKey));
  }
  return pending;
}

export function createWorkspaceProbeExecutor(
  context: ZCodeProtocolAgentServerContext,
  workspace: ZCodeWorkspaceRef,
): ModelProbeProbeExecutor {
  return async (input) => {
    const startedAt = Date.now();
    try {
      const app = await getProbeApp(context, workspace);
      // 先定档位再探测：先按注册表 option 的 defaultLevel 构造 selection，缺省再退最低档。
      // generateWorkspaceText 的 normalizeModelSelection 会把不在 values 里的档位整个剥离，
      // 导致裸 selection 撞 "Reasoning level is required"--所以档位必须来自该模型自己的 values。
      const option = app.listModels().find(
        (candidate) =>
          candidate.ref.providerId === input.providerId &&
          candidate.ref.modelId === input.modelId,
      );
      const reasoningLevel =
        option?.reasoning?.defaultLevel ?? option?.reasoning?.levels[0]?.value;
      const baseSelection = reasoningLevel
        ? { providerId: input.providerId, modelId: input.modelId, options: { reasoningLevel } }
        : { providerId: input.providerId, modelId: input.modelId };
      const selection = baseSelection as never;
      // 阶段 1：连通性（1-token 真实调用）作廉价门禁。
      await app.testModelConnectivity({ selection });
      // 阶段 2：DSH 式最小 completion 作为权威判定。
      await app.generateWorkspaceText(
        {
          selection,
          prompt: PROBE_PROMPT,
          querySource: "model_probe_health",
          maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS,
        },
        {},
      );
      return { ok: true, latencyMs: Date.now() - startedAt };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}
