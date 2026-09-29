// 健康账本持久化：Host 进程级 JSON 文件，原子 tmp+rename 写入（与 trust-store 同模式）。
// 账本是 Host 全局的 provider 健康事实，不进 session-store（会话库是错误的领域）。
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  zcodeModelProbeEntrySchema,
  type ModelProbeEntry,
  type ModelProbeKey,
} from "@zcode/shared";

export const MODEL_PROBE_LEDGER_SCHEMA_VERSION = 1;
export const MODEL_PROBE_LEDGER_FILE = "ledger-v1.json";

export interface ModelProbeLedgerFile {
  schemaVersion: number;
  workspaces: Record<string, Record<string, ModelProbeEntry>>;
}

export interface ModelProbeStoreKey extends ModelProbeKey {
  readonly workspaceKey: string;
}

function entryKey(key: ModelProbeStoreKey): string {
  return `${key.providerId}\u0000${key.modelId}`;
}

export interface ModelProbeLedgerStore {
  get(key: ModelProbeStoreKey): Promise<ModelProbeEntry | undefined>;
  list(workspaceKey: string): Promise<ModelProbeEntry[]>;
  put(key: ModelProbeStoreKey, entry: ModelProbeEntry): Promise<void>;
  putMany(workspaceKey: string, entries: readonly ModelProbeEntry[]): Promise<void>;
}

export function createModelProbeLedgerStore(options: {
  /** 测试注入临时目录；生产按 Host 数据目录解析。 */
  dataDir?: string;
}): ModelProbeLedgerStore {
  const dataDir = options.dataDir ?? join(homedir(), ".zcode", "model-probe");
  const filePath = join(dataDir, MODEL_PROBE_LEDGER_FILE);
  let cache: ModelProbeLedgerFile | undefined;
  let writeChain: Promise<void> = Promise.resolve();

  async function read(): Promise<ModelProbeLedgerFile> {
    if (cache) return cache;
    try {
      const raw = JSON.parse(await readFile(filePath, "utf8")) as ModelProbeLedgerFile;
      cache =
        raw?.schemaVersion === MODEL_PROBE_LEDGER_SCHEMA_VERSION && raw.workspaces
          ? { schemaVersion: raw.schemaVersion, workspaces: raw.workspaces }
          : { schemaVersion: MODEL_PROBE_LEDGER_SCHEMA_VERSION, workspaces: {} };
    } catch {
      cache = { schemaVersion: MODEL_PROBE_LEDGER_SCHEMA_VERSION, workspaces: {} };
    }
    return cache;
  }

  async function flush(state: ModelProbeLedgerFile): Promise<void> {
    await mkdir(dataDir, { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state), "utf8");
    await rename(tmp, filePath);
  }

  function scheduleFlush(state: ModelProbeLedgerFile): Promise<void> {
    // 串行化写路径：同一时刻只有一个 flush 在链上，避免 tmp 文件互相覆盖。
    writeChain = writeChain.then(() => flush(state)).catch(() => {});
    return writeChain;
  }

  return {
    async get(key) {
      const state = await read();
      return state.workspaces[key.workspaceKey]?.[entryKey(key)];
    },
    async list(workspaceKey) {
      const state = await read();
      return Object.values(state.workspaces[workspaceKey] ?? {});
    },
    async put(key, entry) {
      const state = await read();
      state.workspaces[key.workspaceKey] ??= {};
      state.workspaces[key.workspaceKey][entryKey(key)] =
        zcodeModelProbeEntrySchema.parse(entry);
      await scheduleFlush(state);
    },
    async putMany(workspaceKey, entries) {
      const state = await read();
      state.workspaces[workspaceKey] ??= {};
      for (const entry of entries) {
        state.workspaces[workspaceKey][
          entryKey({ workspaceKey, providerId: entry.providerId, modelId: entry.modelId })
        ] = zcodeModelProbeEntrySchema.parse(entry);
      }
      await scheduleFlush(state);
    },
  };
}
