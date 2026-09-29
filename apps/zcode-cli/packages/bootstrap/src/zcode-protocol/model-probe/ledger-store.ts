// 健康账本持久化：Host 进程级 JSON 文件，原子 tmp+rename 写入（与 trust-store 同模式，
// 含其 rename 有界重试——Windows 上杀毒/索引器可能短暂占用目标文件导致 EPERM/EBUSY/EACCES）。
// 账本是 Host 全局的 provider 健康事实，不进 session-store（会话库是错误的领域）。
// 跨进程边界：默认路径被多个窗口 Host 进程共享。flush 写入前重读磁盘并按 workspace 桶合并
// （merge-at-write）：本进程未持有的磁盘桶原样保留，本进程持有的桶整体覆盖同名磁盘桶。
// 这把并发 Host 的丢写窗口缩小到“两次 flush 之间的毫秒级”，而不是归零——同一 key 仍是
// 后写者胜；不引入文件锁（代价与收益不匹配，账本条目可从探测重建）。
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
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

// Windows 短暂文件占用时 rename 会抛 EPERM/EBUSY/EACCES；有界退避重试后仍失败则交给
// 既有错误路径（scheduleFlush 的 catch + logger.warn），不在这里吞掉再无限重试。
const RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800];

function isRetryableRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (!isRetryableRenameError(error) || attempt >= RENAME_RETRY_DELAYS_MS.length) {
        throw error;
      }
      await delay(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

function emptyLedger(): ModelProbeLedgerFile {
  return { schemaVersion: MODEL_PROBE_LEDGER_SCHEMA_VERSION, workspaces: {} };
}

function parseLedger(text: string): ModelProbeLedgerFile {
  try {
    const raw = JSON.parse(text) as Partial<ModelProbeLedgerFile> | null;
    // 修复依据：仅 truthy 判断会放行数组/字符串等非对象 workspaces，后续按桶写入会
    // 静默变形；这里要求纯对象形状，不符则整文件视为空账本。
    if (
      raw?.schemaVersion === MODEL_PROBE_LEDGER_SCHEMA_VERSION &&
      raw.workspaces !== null &&
      typeof raw.workspaces === "object" &&
      !Array.isArray(raw.workspaces)
    ) {
      return {
        schemaVersion: raw.schemaVersion,
        workspaces: raw.workspaces as ModelProbeLedgerFile["workspaces"],
      };
    }
  } catch {
    // 损坏文件按空账本处理（读取契约）。
  }
  return emptyLedger();
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
  /** 结构型日志接口：生产由引擎接线传 createServiceLogger；测试可注入 stub。 */
  logger?: { warn(message: string, meta?: unknown): void };
}): ModelProbeLedgerStore {
  const dataDir = options.dataDir ?? join(homedir(), ".zcode", "model-probe");
  const filePath = join(dataDir, MODEL_PROBE_LEDGER_FILE);
  const logger = options.logger;
  let cache: ModelProbeLedgerFile | undefined;
  // 冷缓存去重：并发的首个读写共享同一个 in-flight load，收敛到同一个缓存对象。
  let reading: Promise<ModelProbeLedgerFile> | undefined;
  let writeChain: Promise<void> = Promise.resolve();

  async function loadOnce(): Promise<ModelProbeLedgerFile> {
    try {
      return parseLedger(await readFile(filePath, "utf8"));
    } catch {
      // 文件不存在或不可读按空账本处理（读取契约）。
      return emptyLedger();
    }
  }

  function read(): Promise<ModelProbeLedgerFile> {
    if (cache) return Promise.resolve(cache);
    reading ??= loadOnce();
    return reading.then((loaded) => {
      // 多个并发 read 收敛到首个落定的对象，保证随后的变更互不丢失。
      cache ??= loaded;
      return cache;
    });
  }

  async function flush(state: ModelProbeLedgerFile): Promise<void> {
    await mkdir(dataDir, { recursive: true });
    // 绕过内存缓存重读磁盘：合并其他窗口 Host 进程写入的桶，避免整文件覆盖对方数据。
    // 读失败（如首次写入前文件不存在）按空盘处理。
    const onDisk = parseLedger(
      await readFile(filePath, "utf8").catch(() => ""),
    );
    const merged = emptyLedger();
    Object.assign(merged.workspaces, onDisk.workspaces);
    // 本进程持有的桶整体胜出：内存缓存是全量视图，磁盘同名桶可能来自本进程更早的写。
    Object.assign(merged.workspaces, state.workspaces);
    const tmp = `${filePath}.${process.pid}.tmp`;
    // mode 0o600：账本含 provider/模型与错误信息，属用户级敏感数据，不放宽默认权限。
    await writeFile(tmp, JSON.stringify(merged), { encoding: "utf8", mode: 0o600 });
    await renameWithRetry(tmp, filePath);
  }

  function scheduleFlush(state: ModelProbeLedgerFile): Promise<void> {
    // 串行化写路径：同一时刻只有一个 flush 在链上，避免 tmp 文件互相覆盖。
    // 失败降级为“仅内存”并上报 logger（账本可从探测重建，不因此崩 Host）。
    writeChain = writeChain
      .then(() => flush(state))
      .catch((error: unknown) => {
        logger?.warn("model probe ledger flush failed", { error });
      });
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
