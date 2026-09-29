// 健康状态观察与协议处理：引擎按 workspaceKey 复用，会话事件 feeding 探针账本。
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { createInMemorySessionEventStore } from "@zcode/contracts";
import type { ZCodeWorkspaceRef } from "@zcode/shared";
import {
  createModelProbeEngine,
  type ModelProbeEngine,
} from "./model-probe-engine.js";
import { createModelProbeLedgerStore } from "./ledger-store.js";
import { createWorkspaceProbeExecutor } from "./probe-executor.js";
import { createWorkspaceZCodeApp } from "../workspace-model-runtime.js";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "../server-types.js";

const probeEngineRegistry = new WeakMap<
  ZCodeProtocolAgentServerContext,
  Map<string, ModelProbeEngine>
>();
const probeLedgerStoreRegistry = new WeakMap<
  ZCodeProtocolAgentServerContext,
  ReturnType<typeof createModelProbeLedgerStore>
>();

function getProbeEngineRegistry(
  context: ZCodeProtocolAgentServerContext,
): Map<string, ModelProbeEngine> {
  let registry = probeEngineRegistry.get(context);
  if (!registry) {
    registry = new Map();
    probeEngineRegistry.set(context, registry);
  }
  return registry;
}

function getSharedLedgerStore(context: ZCodeProtocolAgentServerContext) {
  let store = probeLedgerStoreRegistry.get(context);
  if (!store) {
    store = createModelProbeLedgerStore({
      logger: context.logger?.child({ module: "model-probe.ledger" }),
    });
    probeLedgerStoreRegistry.set(context, store);
  }
  return store;
}

export function getProbeEngine(
  context: ZCodeProtocolAgentServerContext,
  workspace: ZCodeWorkspaceRef,
): ModelProbeEngine {
  const registry = getProbeEngineRegistry(context);
  let engine = registry.get(workspace.workspaceKey);
  if (!engine) {
    engine = createModelProbeEngine({
      workspaceKey: workspace.workspaceKey,
      ledger: getSharedLedgerStore(context),
      executor: createWorkspaceProbeExecutor(context, workspace),
    });
    registry.set(workspace.workspaceKey, engine);
  }
  return engine;
}

export async function syncRegistryModels(
  context: ZCodeProtocolAgentServerContext,
  workspace: ZCodeWorkspaceRef,
  engine: ModelProbeEngine,
): Promise<void> {
  await context.deps.refreshProviderRegistry?.("model-probe");
  const active = Array.from(context.sessions.values()).find(
    (record) => record.workspace.workspaceKey === workspace.workspaceKey,
  );
  const app =
    active?.app ??
    (await createWorkspaceZCodeApp(context, workspace, {
      env: context.deps.env,
      eventStore: createInMemorySessionEventStore(),
      runtimeConfig: { workingDirectory: workspace.workspacePath },
      sessionStore: context.deps.sessionStore,
      version: context.deps.version,
    }));
  try {
    const view = app.providerRegistry.getView();
    const models = view.providers.flatMap((provider) =>
      provider.models
        .filter((model) => model.enabled)
        .map((model) => ({ providerId: provider.providerId, modelId: model.modelId })),
    );
    engine.pruneTo(models);
    await engine.registerModels(models);
  } finally {
    if (!active) await app.close?.();
  }
}

function readModelSelectionFromEvent(
  event: SessionEvent,
): { providerId: string; modelId: string } | null {
  const payload = event.payload as Record<string, unknown>;
  if (event.type === SessionEventType.ModelSelected) {
    const selection = (payload as { modelSelection?: { providerId?: string; modelId?: string } })
      .modelSelection;
    if (selection?.providerId && selection?.modelId) {
      return { providerId: selection.providerId, modelId: selection.modelId };
    }
    return null;
  }
  if (event.type === SessionEventType.ModelComplete) {
    const complete = payload as { modelSelection?: { providerId?: string; modelId?: string } };
    if (complete.modelSelection?.providerId && complete.modelSelection?.modelId) {
      return {
        providerId: complete.modelSelection.providerId,
        modelId: complete.modelSelection.modelId,
      };
    }
    return null;
  }
  if (event.type === SessionEventType.ModelError) {
    const error = (payload as { error?: { attribution?: { providerId?: string; modelId?: string } } })
      .error;
    const attribution = error?.attribution;
    if (attribution?.providerId && attribution?.modelId) {
      return { providerId: attribution.providerId, modelId: attribution.modelId };
    }
    return null;
  }
  return null;
}

export function detachModelProbeSink(record: ZCodeProtocolSessionRecord): void {
  record.modelProbeSinkDispose?.();
  record.modelProbeSinkDispose = undefined;
}

export function attachModelProbeSink(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
): void {
  const engine = getProbeEngine(context, record.workspace);
  const dispose = record.app.runtime.subscribeEvents({
    onSessionEvent: (event) => {
      if (event.type !== SessionEventType.ModelError && event.type !== SessionEventType.ModelComplete)
        return;
      const selection = readModelSelectionFromEvent(event);
      if (!selection) return;
      const latencyMs =
        event.type === SessionEventType.ModelComplete &&
        typeof (event.payload as { latencyMs?: unknown })?.latencyMs === "number"
          ? (event.payload as { latencyMs: number }).latencyMs
          : undefined;
      void engine
        .onSessionModelEvent({
          type: event.type === SessionEventType.ModelError ? "error" : "complete",
          providerId: selection.providerId,
          modelId: selection.modelId,
          ...(latencyMs !== undefined ? { latencyMs } : {}),
        })
        .catch(() => {});
    },
  });
  record.modelProbeSinkDispose = dispose;
}
