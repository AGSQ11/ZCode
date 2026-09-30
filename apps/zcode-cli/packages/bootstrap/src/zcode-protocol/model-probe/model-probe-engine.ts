// 健康状态唯一所有者：观察正常会话的模型成败、执行手工/计划探测、维护复查调度。
// UI 与 services 只读；账本写入只发生在本模块。
import {
  applyObservedAbort,
  applyObservedFailure,
  applyObservedSuccess,
  applyProbeOutcome,
  MODEL_PROBE_DEFAULTS,
  createProbeEntry,
  type ModelProbeEntry,
  type ModelProbeKey,
  type ZCodeModelProbeConfig,
  type ZCodeModelProbeView,
} from "@zcode/shared";
import type { ModelProbeLedgerStore, ModelProbeStoreKey } from "./ledger-store.js";

export interface ModelProbeProbeInput extends ModelProbeKey {}

export interface ModelProbeProbeResult {
  ok: boolean;
  latencyMs?: number;
  ttftMs?: number;
  error?: string;
}

/** 引擎执行一次探测的端口；实现复用 workspace app 的连通性 + 最小 completion 链。 */
export type ModelProbeProbeExecutor = (
  input: ModelProbeProbeInput,
) => Promise<ModelProbeProbeResult>;

export type ModelProbeSessionModelEventType = "complete" | "error" | "abort";

export type ModelProbeRevisionListener = (view: ZCodeModelProbeView) => void;

export interface ModelProbeEngine {
  registerModels(models: readonly ModelProbeKey[]): Promise<void>;
  /** 注册表变化时清理已消失的模型条目。 */
  pruneTo(models: readonly ModelProbeKey[]): Promise<void>;
  ingestEntries(entries: readonly ModelProbeEntry[]): Promise<void>;
  onSessionModelEvent(input: {
    type: ModelProbeSessionModelEventType;
    providerId: string;
    modelId: string;
    latencyMs?: number;
  }): Promise<void>;
  probeAll(config?: Partial<ZCodeModelProbeConfig>): Promise<void>;
  probeOne(key: ModelProbeKey): Promise<void>;
  runScheduledRechecks(): Promise<void>;
  getView(): Promise<ZCodeModelProbeView>;
  getConfig(): ZCodeModelProbeConfig;
  updateConfig(config: ZCodeModelProbeConfig): Promise<void>;
  waitForIdle(): Promise<void>;
  onDidChange(listener: ModelProbeRevisionListener): () => void;
  dispose(): void;
}

export function createModelProbeEngine(deps: {
  workspaceKey: string;
  ledger: ModelProbeLedgerStore;
  executor: ModelProbeProbeExecutor;
  now?: () => number;
  defaults?: ZCodeModelProbeConfig;
}): ModelProbeEngine {
  const now = deps.now ?? Date.now;
  const config: ZCodeModelProbeConfig = {
    probeTimeoutMs: deps.defaults?.probeTimeoutMs ?? MODEL_PROBE_DEFAULTS.probeTimeoutMs,
    concurrency: deps.defaults?.concurrency ?? MODEL_PROBE_DEFAULTS.concurrency,
    deadRecheckIntervalMs:
      deps.defaults?.deadRecheckIntervalMs ?? MODEL_PROBE_DEFAULTS.deadRecheckIntervalMs,
  };
  const entries = new Map<string, ModelProbeEntry>();
  // 同一 key 的在途探测共享同一个任务：并发调度方（probeAll / 健康重试链）await 到真实落地，
  // 而不是拿到"已被去重跳过"的假完成。
  const probing = new Map<string, Promise<void>>();
  const inFlight = new Set<Promise<unknown>>();
  const listeners = new Set<ModelProbeRevisionListener>();
  let revision = 0;
  let disposed = false;

  const keyOf = (key: ModelProbeKey) => `${key.providerId}\u0000${key.modelId}`;

  async function getView(): Promise<ZCodeModelProbeView> {
    return {
      revision,
      config: { ...config },
      // 引擎内部条目是 readonly（含 readonly history）；协议视图是可变副本。
      entries: [...entries.values()].map((item) => ({ ...item, history: [...item.history] })),
      probingProviderIds: [...probing.keys()],
    };
  }

  function entry(key: ModelProbeKey): ModelProbeEntry {
    const existing = entries.get(keyOf(key));
    if (existing) return existing;
    const created = createProbeEntry(key);
    entries.set(keyOf(key), created);
    return created;
  }

  async function commit(key: ModelProbeKey, next: ModelProbeEntry): Promise<void> {
    entries.set(keyOf(key), next);
    revision += 1;
    const view = await getView();
    for (const listener of listeners) listener(view);
    const storeKey: ModelProbeStoreKey = {
      workspaceKey: deps.workspaceKey,
      providerId: key.providerId,
      modelId: key.modelId,
    };
    await deps.ledger.put(storeKey, next);
  }

  async function runProbe(
    key: ModelProbeKey,
    source: "manual-probe" | "scheduled-recheck",
  ): Promise<void> {
    if (disposed) return;
    const id = keyOf(key);
    const existing = probing.get(id);
    if (existing) return existing;

    const task = (async () => {
      try {
        const timeout = AbortSignal.timeout(config.probeTimeoutMs);
        const result = await Promise.race([
          deps.executor(key),
          new Promise<ModelProbeProbeResult>((resolve) => {
            timeout.addEventListener("abort", () =>
              resolve({ ok: false, error: "probe timed out" }),
            );
          }),
        ]);
        const current = entry(key);
        const outcome = result.ok
          ? {
              ok: true,
              checkedAt: now(),
              latencyMs: result.latencyMs,
              ttftMs: result.ttftMs,
            }
          : { ok: false, checkedAt: now(), error: result.error ?? "probe failed" };
        await commit(key, applyProbeOutcome(current, outcome));
      } catch (error) {
        const current = entry(key);
        await commit(
          key,
          applyProbeOutcome(current, {
            ok: false,
            checkedAt: now(),
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      } finally {
        probing.delete(id);
      }
    })();

    probing.set(id, task);
    inFlight.add(task);
    void task.finally(() => inFlight.delete(task));
    return task;
  }

  return {
    async registerModels(models) {
      for (const model of models) entry(model);
      revision += 1;
      await deps.ledger.putMany(
        deps.workspaceKey,
        models.map((model) => entry(model)),
      );
    },
    async pruneTo(models) {
      const keep = new Set(models.map(keyOf));
      for (const [id, entryValue] of entries) {
        if (!keep.has(id)) entries.delete(id);
      }
      revision += 1;
      await deps.ledger.putMany(deps.workspaceKey, [...entries.values()]);
    },
    async ingestEntries(ingested) {
      for (const item of ingested) {
        if (!entries.has(keyOf(item))) entries.set(keyOf(item), item);
      }
    },
    async onSessionModelEvent(event) {
      if (disposed) return;
      const key = { providerId: event.providerId, modelId: event.modelId };
      if (event.type === "abort") {
        // 用户主动取消/中止不算模型死亡；仅当已有条目时保持原状，且不创建新条目。
        if (entries.has(keyOf(key))) {
          await commit(key, applyObservedAbort(entry(key), now()));
        }
        return;
      }
      if (event.type === "complete") {
        await commit(key, applyObservedSuccess(entry(key), now(), event.latencyMs));
        return;
      }
      // 终止性错误：计入初次失败，并立即调度健康重试（重试结果逐次计入，直至阈值）。
      const failed = applyObservedFailure(entry(key), now());
      await commit(key, failed);
      const retryLoop = (async () => {
        while (!disposed) {
          const current = entries.get(keyOf(key));
          if (!current || current.status === "dead") break;
          await runProbe(key, "manual-probe");
        }
      })();
      inFlight.add(retryLoop);
      void retryLoop.finally(() => inFlight.delete(retryLoop));
    },
    async probeAll(partial) {
      if (partial) Object.assign(config, partial);
      const queue = [...entries.values()];
      let cursor = 0;
      const workers = Array.from({ length: Math.min(config.concurrency, queue.length) }, async () => {
        while (cursor < queue.length && !disposed) {
          const item = queue[cursor];
          cursor += 1;
          const key = { providerId: item.providerId, modelId: item.modelId };
          // DSH 手工探测策略：一次动作内最多 3 次尝试（初次 + 2 重试）才判 Dead。
          // 之前 probeAll 每个模型只探一次，一次瞬时超时就留 attemptCount=1 且永不收敛。
          let attempts = 0;
          while (!disposed && attempts < MODEL_PROBE_DEFAULTS.failureThreshold) {
            attempts += 1;
            await runProbe(key, "manual-probe");
            const latest = entries.get(keyOf(key));
            if (latest?.status === "alive") break;
          }
        }
      });
      await Promise.all(workers);
    },
    async probeOne(key) {
      await runProbe(key, "manual-probe");
    },
    async runScheduledRechecks() {
      const due = [...entries.values()].filter(
        (item) =>
          item.status === "dead" &&
          (item.nextRetryAt ?? Number.POSITIVE_INFINITY) <= now(),
      );
      for (const item of due) {
        await runProbe({ providerId: item.providerId, modelId: item.modelId }, "scheduled-recheck");
      }
    },
    getView,
    getConfig() {
      return { ...config };
    },
    async updateConfig(next) {
      Object.assign(config, next);
      revision += 1;
      const view = await getView();
      for (const listener of listeners) listener(view);
    },
    async waitForIdle() {
      await Promise.allSettled([...inFlight]);
    },
    onDidChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}
