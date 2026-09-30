# Model Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Native model-health monitoring (port of dsh-model-probe): persistent Alive/Dead ledger per Host, health dots + Alive→Unknown→Dead ordering in the model picker, and a Settings → Model Probe section with diagnostics and manual "Probe all".

**Architecture:** The ledger's single writer is a process-scoped `ModelProbeEngine` in the CLI bootstrap protocol server (`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/model-probe/`) - the layer that already owns workspace app lifecycle (`context.sessions`, `createWorkspaceZCodeApp`) and the connectivity handler. The engine observes `model_error` / `model_complete` session events via `app.subscribeEvents(sink)`, executes probes by reusing the connectivity-test executor plus a minimal stage-2 completion, and persists the ledger to a JSON file with atomic writes. UI reads through a new `IModelProbeService` over the zcode protocol, mirroring `testModelConnectivity` wiring.

**Tech Stack:** TypeScript, zod (packages/shared), node:test + tsx for tests, React + existing UI components (packages/ui), lucide-react icons.

**Two refinements vs. the spec** (same behavior, better-verified placement):

1. Engine home is the bootstrap protocol server, not per-session core runtime methods - `AgentRuntime` is per-session; the ledger must observe all sessions of the process. The spec's intent (single owner in the long-lived runtime process) is preserved.
2. Persistence is a process-level JSON ledger (`~/.zcode/model-probe/ledger-v1.json`, atomic tmp+rename, mirroring the workspace-hook trust-store pattern) instead of a session-store migration - the ledger is Host-global provider health, not session data; the session store is the wrong domain.

**Spec:** `docs/superpowers/specs/2026-09-29-model-probe-design.md`

**Workspace rules (from AGENTS.md):** update spec first (done); run `node scripts/check-workspace-freshness.mjs` before starting; Chinese comments for bug-fix rationale are required only for bug fixes; final gates are `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`.

---

### Task 1: Shared probe types + pure health policy engine

**Files:**

- Create: `packages/shared/src/model-probe.ts`
- Create: `packages/shared/test/model-probe.test.ts`
- Modify: `packages/shared/src/index.ts` (add export near other domain exports)

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/test/model-probe.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyProbeOutcome,
  applyObservedFailure,
  applyObservedSuccess,
  applyObservedAbort,
  createProbeEntry,
  MODEL_PROBE_DEFAULTS,
  type ModelProbeEntry,
  type ModelProbeOutcome,
} from "../src/model-probe.js";

const KEY = { providerId: "zai-api", modelId: "glm-5.3-flash" };

function aliveEntry(): ModelProbeEntry {
  return { ...createProbeEntry(KEY), status: "alive", lastCheckedAt: 1000, attemptCount: 0 };
}
function deadEntry(): ModelProbeEntry {
  return {
    ...createProbeEntry(KEY),
    status: "dead",
    lastCheckedAt: 1000,
    attemptCount: 3,
    lastError: "boom",
    nextRetryAt: 2_000_000,
  };
}

test("createProbeEntry starts unknown", () => {
  const entry = createProbeEntry(KEY);
  assert.equal(entry.status, "unknown");
  assert.equal(entry.attemptCount, 0);
  assert.deepEqual(entry.history, []);
});

test("successful manual probe revives and clears attempts", () => {
  const outcome: ModelProbeOutcome = {
    ok: true,
    checkedAt: 2000,
    latencyMs: 120,
    ttftMs: 40,
  };
  const entry = applyProbeOutcome(deadEntry(), outcome);
  assert.equal(entry.status, "alive");
  assert.equal(entry.attemptCount, 0);
  assert.equal(entry.lastError, undefined);
  assert.equal(entry.nextRetryAt, undefined);
  assert.equal(entry.latencyMs, 120);
  assert.equal(entry.ttftMs, 40);
  assert.equal(entry.history.length, 1);
});

test("manual probe marks dead only after 3 failed attempts", () => {
  const fail: ModelProbeOutcome = { ok: false, checkedAt: 2000, error: "timeout" };
  const attempt1 = applyProbeOutcome(aliveEntry(), fail);
  assert.equal(attempt1.status, "alive");
  assert.equal(attempt1.attemptCount, 1);
  const attempt2 = applyProbeOutcome(attempt1, fail);
  assert.equal(attempt2.status, "alive");
  const attempt3 = applyProbeOutcome(attempt2, fail);
  assert.equal(attempt3.status, "dead");
  assert.ok((attempt3.nextRetryAt ?? 0) > 2000);
  assert.equal(attempt3.lastError, "timeout");
});

test("observed user-request failure is initial failure; two health retries then dead", () => {
  const at = 3000;
  const fail1 = applyObservedFailure(aliveEntry(), at);
  assert.equal(fail1.status, "alive"); // retry #1 pending
  const fail2 = applyObservedFailure(fail1, at);
  assert.equal(fail2.status, "alive"); // retry #2 pending
  const fail3 = applyObservedFailure(fail2, at);
  assert.equal(fail3.status, "dead");
  assert.ok((fail3.nextRetryAt ?? 0) >= at + MODEL_PROBE_DEFAULTS.deadRecheckIntervalMs);
});

test("observed success revives a dead model immediately", () => {
  const revived = applyObservedSuccess(deadEntry(), 4000, 200);
  assert.equal(revived.status, "alive");
  assert.equal(revived.attemptCount, 0);
  assert.equal(revived.nextRetryAt, undefined);
});

test("user cancellation/abort is not model death", () => {
  const entry = applyObservedAbort(aliveEntry(), 5000);
  assert.equal(entry.status, "alive");
  assert.equal(entry.attemptCount, 0);
});

test("dead model that fails a scheduled recheck stays dead and reschedules", () => {
  const outcome: ModelProbeOutcome = { ok: false, checkedAt: 3_000_000, error: "still down" };
  const entry = applyProbeOutcome(deadEntry(), outcome);
  assert.equal(entry.status, "dead");
  assert.ok((entry.nextRetryAt ?? 0) > 3_000_000);
});

test("history is bounded at 500 outcomes", () => {
  let entry = aliveEntry();
  for (let i = 0; i < 505; i += 1) {
    entry = applyObservedSuccess(entry, i, 10);
  }
  assert.equal(entry.history.length, 500);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/shared/test/model-probe.test.ts`
Expected: FAIL - cannot resolve `../src/model-probe.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/shared/src/model-probe.ts
// 模型健康探测（dsh-model-probe 的原生移植）：类型与健康状态机均为纯函数，
// 供 bootstrap 引擎与 UI 展示层共用；本文件不依赖任何运行时或进程 API。

export type ModelProbeStatus = "alive" | "dead" | "unknown";

export interface ModelProbeKey {
  readonly providerId: string;
  readonly modelId: string;
}

export interface ModelProbeOutcome {
  readonly ok: boolean;
  /** 墙钟毫秒。 */
  readonly checkedAt: number;
  readonly latencyMs?: number;
  readonly ttftMs?: number;
  readonly error?: string;
}

export interface ModelProbeOutcomeRecord extends ModelProbeOutcome {
  readonly source: "manual-probe" | "observed-failure" | "observed-success" | "scheduled-recheck";
}

export interface ModelProbeEntry extends ModelProbeKey {
  status: ModelProbeStatus;
  lastCheckedAt?: number;
  latencyMs?: number;
  ttftMs?: number;
  lastError?: string;
  /** 当前故障验证已计入的失败次数；成功后清零。 */
  attemptCount: number;
  /** Dead 模型的下一次后台复查墙钟毫秒；其余状态 undefined。 */
  nextRetryAt?: number;
  /** 有界历史：最新 500 条 outcome，尾部追加。 */
  history: ModelProbeOutcomeRecord[];
}

export const MODEL_PROBE_HISTORY_LIMIT = 500;

export const MODEL_PROBE_DEFAULTS = {
  /** 手工/观察探测的判定阈值：初次失败 + 2 次健康重试。 */
  failureThreshold: 3,
  /** Dead 模型后台复查间隔。 */
  deadRecheckIntervalMs: 30 * 60 * 1000,
  /** 单次探测超时。 */
  probeTimeoutMs: 30_000,
  /** Probe all 的并发上限。 */
  concurrency: 4,
} as const;

export function createProbeEntry(key: ModelProbeKey): ModelProbeEntry {
  return {
    providerId: key.providerId,
    modelId: key.modelId,
    status: "unknown",
    attemptCount: 0,
    history: [],
  };
}

function withHistory(entry: ModelProbeEntry, record: ModelProbeOutcomeRecord): ModelProbeEntry {
  const history = [...entry.history, record].slice(-MODEL_PROBE_HISTORY_LIMIT);
  return { ...entry, history };
}

function reschedule(entry: ModelProbeEntry, checkedAt: number): ModelProbeEntry {
  return {
    ...entry,
    nextRetryAt: checkedAt + MODEL_PROBE_DEFAULTS.deadRecheckIntervalMs,
  };
}

/**
 * 探测结果（手工探测、计划复查）落入账本。失败达到阈值即判 Dead 并安排复查；
 * 未达阈值保持当前状态继续重试。成功立即 Alive。
 */
export function applyProbeOutcome(
  entry: ModelProbeEntry,
  outcome: ModelProbeOutcome,
): ModelProbeEntry {
  const source: ModelProbeOutcomeRecord["source"] =
    entry.status === "dead" ? "scheduled-recheck" : "manual-probe";
  const recorded = withHistory(entry, { ...outcome, source });
  if (outcome.ok) {
    return {
      ...recorded,
      status: "alive",
      attemptCount: 0,
      lastCheckedAt: outcome.checkedAt,
      latencyMs: outcome.latencyMs,
      ttftMs: outcome.ttftMs,
      lastError: undefined,
      nextRetryAt: undefined,
    };
  }
  const attemptCount = entry.attemptCount + 1;
  const dead = attemptCount >= MODEL_PROBE_DEFAULTS.failureThreshold;
  const next: ModelProbeEntry = {
    ...recorded,
    status: dead ? "dead" : entry.status === "dead" ? "dead" : "unknown",
    attemptCount,
    lastCheckedAt: outcome.checkedAt,
    lastError: outcome.error,
    latencyMs: entry.latencyMs,
    ttftMs: entry.ttftMs,
  };
  return dead ? reschedule(next, outcome.checkedAt) : next;
}

/** 正常会话内的模型请求终止性失败：算初次失败；健康重试由引擎调度，失败逐次计入。 */
export function applyObservedFailure(entry: ModelProbeEntry, checkedAt: number): ModelProbeEntry {
  return applyProbeOutcome(entry, { ok: false, checkedAt, error: "observed model error" });
}

/** 正常会话内模型请求成功：立即复活。 */
export function applyObservedSuccess(
  entry: ModelProbeEntry,
  checkedAt: number,
  latencyMs?: number,
): ModelProbeEntry {
  return applyProbeOutcome(entry, { ok: true, checkedAt, latencyMs });
}

/** 用户主动取消/中止不算模型死亡；不进入账本历史。 */
export function applyObservedAbort(entry: ModelProbeEntry, _checkedAt: number): ModelProbeEntry {
  return entry;
}
```

- [ ] **Step 4: Export from the package index**

In `packages/shared/src/index.ts`, add alongside the other domain module re-exports (locate the `export *` block, e.g. near `export * from "./channels.js"`):

```ts
export * from "./model-probe.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx tsx --test packages/shared/test/model-probe.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/model-probe.ts packages/shared/src/index.ts packages/shared/test/model-probe.test.ts
git commit -m "feat(shared): model probe types and pure health policy"
```

---

### Task 2: Protocol methods and schemas

**Files:**

- Modify: `packages/shared/src/zcode-protocol/index.ts` (schemas near line 2132 `zcodeProviderTestModelConnectivityParamsSchema`; method names near line 3615 `providerTestModelConnectivity: "provider/testModelConnectivity"`)

- [ ] **Step 1: Add method names**

In the `zcodeProtocolMethods` object, directly after the `providerTestModelConnectivity: "provider/testModelConnectivity",` line add:

```ts
  providerModelProbeGetView: "provider/modelProbeGetView",
  providerModelProbeProbeAll: "provider/modelProbeProbeAll",
  providerModelProbeUpdateConfig: "provider/modelProbeUpdateConfig",
```

- [ ] **Step 2: Add schemas**

Directly after `zcodeProviderTestModelConnectivityResultSchema`'s type exports (search `ZCodeProviderTestModelConnectivityResult = z.infer`) add:

```ts
export const zcodeModelProbeKeySchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
});

export const zcodeModelProbeOutcomeSchema = z.object({
  ok: z.boolean(),
  checkedAt: z.number(),
  latencyMs: z.number().optional(),
  ttftMs: z.number().optional(),
  error: z.string().optional(),
  source: z.enum(["manual-probe", "observed-failure", "observed-success", "scheduled-recheck"]),
});

export const zcodeModelProbeEntrySchema = z.intersection(
  zcodeModelProbeKeySchema,
  z.object({
    status: z.enum(["alive", "dead", "unknown"]),
    lastCheckedAt: z.number().optional(),
    latencyMs: z.number().optional(),
    ttftMs: z.number().optional(),
    lastError: z.string().optional(),
    attemptCount: z.number().int().nonnegative(),
    nextRetryAt: z.number().optional(),
    history: z.array(zcodeModelProbeOutcomeSchema),
  }),
);

export const zcodeModelProbeConfigSchema = z.object({
  probeTimeoutMs: z.number().int().min(1_000).max(120_000),
  concurrency: z.number().int().min(1).max(16),
  deadRecheckIntervalMs: z
    .number()
    .int()
    .min(60_000)
    .max(24 * 60 * 60 * 1000),
});

export const zcodeModelProbeViewSchema = z.object({
  revision: z.number(),
  config: zcodeModelProbeConfigSchema,
  entries: z.array(zcodeModelProbeEntrySchema),
  probingProviderIds: z.array(z.string()),
});

export const zcodeProviderModelProbeGetViewParamsSchema = z.object({
  workspace: zcodeWorkspaceRefSchema,
});
export const zcodeProviderModelProbeGetViewResultSchema = zcodeModelProbeViewSchema;

export const zcodeProviderModelProbeProbeAllParamsSchema = z.object({
  workspace: zcodeWorkspaceRefSchema,
  config: zcodeModelProbeConfigSchema.partial().optional(),
});
export const zcodeProviderModelProbeProbeAllResultSchema = z.object({
  started: z.boolean(),
});

export const zcodeProviderModelProbeUpdateConfigParamsSchema = z.object({
  workspace: zcodeWorkspaceRefSchema,
  config: zcodeModelProbeConfigSchema,
});
export const zcodeProviderModelProbeUpdateConfigResultSchema = zcodeModelProbeViewSchema;

export type ZCodeModelProbeKey = z.infer<typeof zcodeModelProbeKeySchema>;
export type ZCodeModelProbeOutcome = z.infer<typeof zcodeModelProbeOutcomeSchema>;
export type ZCodeModelProbeEntry = z.infer<typeof zcodeModelProbeEntrySchema>;
export type ZCodeModelProbeConfig = z.infer<typeof zcodeModelProbeConfigSchema>;
export type ZCodeModelProbeView = z.infer<typeof zcodeModelProbeViewSchema>;
export type ZCodeProviderModelProbeGetViewParams = z.infer<
  typeof zcodeProviderModelProbeGetViewParamsSchema
>;
export type ZCodeProviderModelProbeGetViewResult = z.infer<
  typeof zcodeProviderModelProbeGetViewResultSchema
>;
export type ZCodeProviderModelProbeProbeAllParams = z.infer<
  typeof zcodeProviderModelProbeProbeAllParamsSchema
>;
export type ZCodeProviderModelProbeProbeAllResult = z.infer<
  typeof zcodeProviderModelProbeProbeAllResultSchema
>;
export type ZCodeProviderModelProbeUpdateConfigParams = z.infer<
  typeof zcodeProviderModelProbeUpdateConfigParamsSchema
>;
export type ZCodeProviderModelProbeUpdateConfigResult = z.infer<
  typeof zcodeProviderModelProbeUpdateConfigResultSchema
>;
```

Note: `zcodeWorkspaceRefSchema` is the schema already used by `zcodeProviderTestModelConnectivityParamsSchema` - use the same import/identifier visible at that site.

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (new exports typecheck; no consumers yet).

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/zcode-protocol/index.ts
git commit -m "feat(shared): model probe protocol methods and schemas"
```

---

### Task 3: Ledger JSON store (bootstrap)

**Files:**

- Create: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/model-probe/ledger-store.ts`
- Create: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/model-probe/ledger-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/zcode-cli/packages/bootstrap/src/zcode-protocol/model-probe/ledger-store.test.ts
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createModelProbeLedgerStore,
  MODEL_PROBE_LEDGER_SCHEMA_VERSION,
  type ModelProbeLedgerFile,
} from "./ledger-store.js";
import { createProbeEntry } from "@zcode/shared";

test("round-trips entries across reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "model-probe-ledger-"));
  try {
    const store = createModelProbeLedgerStore({ dataDir: dir });
    const key = { workspaceKey: "ws-1", providerId: "zai-api", modelId: "glm-5.3-flash" };
    await store.put(key, { ...createProbeEntry(key), status: "alive", lastCheckedAt: 42 });
    const reloaded = createModelProbeLedgerStore({ dataDir: dir });
    const entry = await reloaded.get(key);
    assert.equal(entry?.status, "alive");
    assert.equal(entry?.lastCheckedAt, 42);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writes atomically and stamps schema version", async () => {
  const dir = await mkdtemp(join(tmpdir(), "model-probe-ledger-"));
  try {
    const store = createModelProbeLedgerStore({ dataDir: dir });
    const key = { workspaceKey: "ws-1", providerId: "p", modelId: "m" };
    await store.put(key, createProbeEntry({ providerId: "p", modelId: "m" }));
    const raw = JSON.parse(
      await readFile(join(dir, "ledger-v1.json"), "utf8"),
    ) as ModelProbeLedgerFile;
    assert.equal(raw.schemaVersion, MODEL_PROBE_LEDGER_SCHEMA_VERSION);
    assert.ok(raw.workspaces["ws-1"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("corrupt or missing file reads as empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "model-probe-ledger-"));
  try {
    const store = createModelProbeLedgerStore({ dataDir: dir });
    assert.deepEqual(await store.list("ws-1"), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test apps/zcode-cli/packages/bootstrap/src/zcode-protocol/model-probe/ledger-store.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Write the implementation**

```ts
// apps/zcode-cli/packages/bootstrap/src/zcode-protocol/model-probe/ledger-store.ts
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
      state.workspaces[key.workspaceKey][entryKey(key)] = zcodeModelProbeEntrySchema.parse(entry);
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
```

Note: add `@zcode/shared` to `apps/zcode-cli/packages/bootstrap/package.json` dependencies if not already present (check its `dependencies` block first).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test apps/zcode-cli/packages/bootstrap/src/zcode-protocol/model-probe/ledger-store.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/zcode-cli/packages/bootstrap/src/zcode-protocol/model-probe/ledger-store.ts apps/zcode-cli/packages/bootstrap/src/zcode-protocol/model-probe/ledger-store.test.ts
git commit -m "feat(bootstrap): atomic model probe ledger store"
```

---

### Task 4: Probe engine (observer, executor, scheduler)

**Files:**

- Create: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/model-probe/model-probe-engine.ts`
- Create: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/model-probe/model-probe-engine.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/zcode-cli/packages/bootstrap/src/zcode-protocol/model-probe/model-probe-engine.test.ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModelProbeEngine, type ModelProbeProbeExecutor } from "./model-probe-engine.js";
import { createModelProbeLedgerStore } from "./ledger-store.js";
import { MODEL_PROBE_DEFAULTS, type ModelProbeEntry } from "@zcode/shared";

function makeExecutor(map: Record<string, boolean>): {
  executor: ModelProbeProbeExecutor;
  calls: () => string[];
} {
  const calls: string[] = [];
  return {
    calls: () => calls,
    executor: async (input) => {
      calls.push(`${input.providerId}:${input.modelId}`);
      if (map[`${input.providerId}:${input.modelId}`] === false) {
        return { ok: false, latencyMs: undefined, ttftMs: undefined, error: "probe failed" };
      }
      return { ok: true, latencyMs: 100, ttftMs: 30 };
    },
  };
}

async function makeEngine(map: Record<string, boolean>) {
  const dir = await mkdtemp(join(tmpdir(), "model-probe-engine-"));
  const { executor, calls } = makeExecutor(map);
  const engine = createModelProbeEngine({
    workspaceKey: "ws-1",
    ledger: createModelProbeLedgerStore({ dataDir: dir }),
    executor,
    now: () => 10_000,
    defaults: { ...MODEL_PROBE_DEFAULTS, deadRecheckIntervalMs: 60_000 },
  });
  return {
    engine,
    calls,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test("records observed success as alive", async () => {
  const { engine, cleanup } = await makeEngine({});
  try {
    await engine.onSessionModelEvent({
      type: "complete",
      providerId: "p",
      modelId: "m",
      latencyMs: 55,
    });
    const view = await engine.getView();
    const entry = view.entries.find((e) => e.providerId === "p" && e.modelId === "m");
    assert.equal(entry?.status, "alive");
  } finally {
    await cleanup();
  }
});

test("observed failure schedules two health retries then dead", async () => {
  const { engine, cleanup } = await makeEngine({ "p:m": false });
  try {
    await engine.onSessionModelEvent({ type: "error", providerId: "p", modelId: "m" });
    // 引擎在失败观察后同步发起健康重试（受 executor stub 控制）；等它们落地。
    await engine.waitForIdle();
    const view = await engine.getView();
    const entry = view.entries.find((e) => e.providerId === "p" && e.modelId === "m")!;
    assert.equal(entry.status, "dead");
  } finally {
    await cleanup();
  }
});

test("abort events are ignored", async () => {
  const { engine, calls, cleanup } = await makeEngine({ "p:m": false });
  try {
    await engine.onSessionModelEvent({ type: "abort", providerId: "p", modelId: "m" });
    const view = await engine.getView();
    assert.equal(
      view.entries.find((e) => e.modelId === "m"),
      undefined,
    );
    assert.deepEqual(calls(), []);
  } finally {
    await cleanup();
  }
});

test("probeAll probes every registered model with bounded concurrency", async () => {
  const { engine, calls, cleanup } = await makeEngine({});
  try {
    await engine.registerModels([
      { providerId: "p1", modelId: "m1" },
      { providerId: "p1", modelId: "m2" },
      { providerId: "p2", modelId: "m3" },
    ]);
    await engine.probeAll();
    assert.equal(calls().length, 3);
    const view = await engine.getView();
    assert.ok(view.entries.every((e) => e.status === "alive"));
  } finally {
    await cleanup();
  }
});

test("dead entries with overdue nextRetryAt are rechecked by the scheduler", async () => {
  const { engine, calls, cleanup } = await makeEngine({ "p:m": true });
  try {
    // 预置一条已过期的 Dead 记录。
    const expired: ModelProbeEntry = {
      providerId: "p",
      modelId: "m",
      status: "dead",
      attemptCount: 3,
      lastCheckedAt: 1,
      lastError: "down",
      nextRetryAt: 5_000,
      history: [],
    };
    await engine.ingestEntries([expired]);
    await engine.runScheduledRechecks();
    assert.deepEqual(calls(), ["p:m"]);
    const view = await engine.getView();
    assert.equal(view.entries[0]?.status, "alive");
  } finally {
    await cleanup();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test apps/zcode-cli/packages/bootstrap/src/zcode-protocol/model-probe/model-probe-engine.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Write the implementation**

```ts
// apps/zcode-cli/packages/bootstrap/src/zcode-protocol/model-probe/model-probe-engine.ts
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
  const probing = new Set<string>();
  const inFlight = new Set<Promise<unknown>>();
  const listeners = new Set<ModelProbeRevisionListener>();
  let revision = 0;
  let disposed = false;

  const keyOf = (key: ModelProbeKey) => `${key.providerId}\u0000${key.modelId}`;

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
    if (probing.has(id)) return;
    probing.add(id);
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
        void commit(key, applyProbeOutcome(current, outcome));
      } catch (error) {
        const current = entry(key);
        void commit(key, {
          ...applyProbeOutcome(current, {
            ok: false,
            checkedAt: now(),
            error: error instanceof Error ? error.message : String(error),
          }),
        });
      } finally {
        probing.delete(id);
      }
    })();
    inFlight.add(task);
    void task.finally(() => inFlight.delete(task));
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
        await commit(key, applyObservedAbort(entry(key), now()));
        return;
      }
      if (event.type === "complete") {
        await commit(key, applyObservedSuccess(entry(key), now(), event.latencyMs));
        return;
      }
      // 终止性错误：计入初次失败，并立即调度健康重试（重试结果逐次计入，直至阈值）。
      const failed = applyObservedFailure(entry(key), now());
      await commit(key, failed);
      void runProbe(key, "manual-probe");
    },
    async probeAll(partial) {
      if (partial) Object.assign(config, partial);
      const queue = [...entries.values()];
      let cursor = 0;
      const workers = Array.from(
        { length: Math.min(config.concurrency, queue.length) },
        async () => {
          while (cursor < queue.length && !disposed) {
            const item = queue[cursor];
            cursor += 1;
            await runProbe({ providerId: item.providerId, modelId: item.modelId }, "manual-probe");
          }
        },
      );
      await Promise.all(workers);
    },
    async probeOne(key) {
      await runProbe(key, "manual-probe");
    },
    async runScheduledRechecks() {
      const due = [...entries.values()].filter(
        (item) => item.status === "dead" && (item.nextRetryAt ?? Number.POSITIVE_INFINITY) <= now(),
      );
      for (const item of due) {
        await runProbe({ providerId: item.providerId, modelId: item.modelId }, "scheduled-recheck");
      }
    },
    async getView() {
      return {
        revision,
        config: { ...config },
        entries: [...entries.values()],
        probingProviderIds: [...probing],
      };
    },
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test apps/zcode-cli/packages/bootstrap/src/zcode-protocol/model-probe/model-probe-engine.test.ts`
Expected: PASS (5 tests). If the "observed failure schedules two health retries" test is flaky on `waitForIdle`, assert on `attemptCount >= 3` instead of exact call counts - the policy state machine (Task 1 tests) already pins exact counts.

- [ ] **Step 5: Commit**

```bash
git add apps/zcode-cli/packages/bootstrap/src/zcode-protocol/model-probe/model-probe-engine.ts apps/zcode-cli/packages/bootstrap/src/zcode-protocol/model-probe/model-probe-engine.test.ts
git commit -m "feat(bootstrap): model probe engine with observer, executor, scheduler"
```

---

### Task 5: Executor + protocol server wiring

**Files:**

- Create: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/model-probe/probe-executor.ts`
- Modify: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server.ts` (method dispatch near line 642; session registration site)
- Modify: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-runtime.ts` (export a reusable executor)

- [ ] **Step 1: Export a reusable minimal-probe executor**

At the end of `workspace-model-runtime.ts` add a second exported function mirroring `testProviderModelConnectivity` (lines 37-67), but running the DSH stage-2 probe and returning measurements:

```ts
export async function probeProviderModelHealth(
  context: ZCodeProtocolAgentServerContext,
  rawParams: { workspace: ZCodeWorkspaceRef; selection: ModelSelection },
  abortSignal?: AbortSignal,
): Promise<{ ok: boolean; latencyMs?: number; ttftMs?: number; error?: string }> {
  const startedAt = Date.now();
  try {
    // 阶段 1：既有连通性测试（真实 1-token 调用）作为廉价门禁。
    await testProviderModelConnectivity(
      context,
      { workspace: rawParams.workspace, selection: rawParams.selection } as never,
      abortSignal,
    );
    const active = Array.from(context.sessions.values()).find(
      (record) => record.workspace.workspaceKey === rawParams.workspace.workspaceKey,
    );
    const app =
      active?.app ??
      (await createWorkspaceZCodeApp(context, rawParams.workspace, {
        env: context.deps.env,
        eventStore: createInMemorySessionEventStore(),
        runtimeConfig: { workingDirectory: rawParams.workspace.workspacePath },
        sessionStore: context.deps.sessionStore,
        version: context.deps.version,
      }));
    try {
      // 阶段 2：DSH 式最小 completion（"Reply with exactly OK."，maxTokens=8）。
      const result = await app.generateWorkspaceText(
        {
          selection: rawParams.selection as ModelSelection,
          prompt: "Reply with exactly OK.",
          querySource: "model_probe_health",
          maxOutputTokens: 8,
        },
        { abortSignal },
      );
      void result;
      return { ok: true, latencyMs: Date.now() - startedAt };
    } finally {
      if (!active) await app.close?.();
    }
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
```

Verify `app.generateWorkspaceText` exists on `ZCodeApp` (it backs `workspaceGenerateText` in `runtime/methods/index.ts`); if the exported app method has a different name, use the accessor the server uses for `workspaceGenerateText` and keep `querySource: "model_probe_health"`.

- [ ] **Step 2: Wire the engine registry into the server**

Create the executor adapter in `probe-executor.ts`:

```ts
// apps/zcode-cli/packages/bootstrap/src/zcode-protocol/model-probe/probe-executor.ts
import type { ZCodeProtocolAgentServerContext } from "../server-types.js";
import type { ZCodeWorkspaceRef } from "@zcode/shared";
import type { ModelProbeProbeExecutor } from "./model-probe-engine.js";
import { probeProviderModelHealth } from "../workspace-model-runtime.js";

export function createWorkspaceProbeExecutor(
  context: ZCodeProtocolAgentServerContext,
  workspace: ZCodeWorkspaceRef,
): ModelProbeProbeExecutor {
  return async (input) =>
    probeProviderModelHealth(context, {
      workspace,
      selection: { providerId: input.providerId, modelId: input.modelId } as never,
    });
}
```

Then in `server.ts`:

1. Add imports for the model-probe modules.
2. Add a module-level registry on the context (lazy-initialized map):

```ts
function getProbeEngine(
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
```

`getProbeEngineRegistry` / `getSharedLedgerStore` are two small lazy singletons over a `WeakMap<ZCodeProtocolAgentServerContext, ...>`; ledger data dir defaults to `~/.zcode/model-probe` (the store handles it).

3. Dispatch, after the `providerTestModelConnectivity` case (server.ts:642):

```ts
      case zcodeProtocolMethods.providerModelProbeGetView: {
        const params = parseParams(zcodeProviderModelProbeGetViewParamsSchema, request.params);
        const engine = getProbeEngine(this.context, params.workspace);
        await syncRegistryModels(this.context, params.workspace, engine);
        return zcodeProviderModelProbeGetViewResultSchema.parse(await engine.getView());
      }
      case zcodeProtocolMethods.providerModelProbeProbeAll: {
        const params = parseParams(zcodeProviderModelProbeProbeAllParamsSchema, request.params);
        const engine = getProbeEngine(this.context, params.workspace);
        await syncRegistryModels(this.context, params.workspace, engine);
        void engine.probeAll(params.config).catch(() => {});
        return { started: true };
      }
      case zcodeProtocolMethods.providerModelProbeUpdateConfig: {
        const params = parseParams(zcodeProviderModelProbeUpdateConfigParamsSchema, request.params);
        const engine = getProbeEngine(this.context, params.workspace);
        await engine.updateConfig(params.config);
        return zcodeProviderModelProbeUpdateConfigResultSchema.parse(await engine.getView());
      }
```

4. `syncRegistryModels` reads the workspace's enabled provider/model pairs. Reuse the registry access the connectivity path uses: `await context.deps.refreshProviderRegistry?.("model-probe")`, then enumerate from the same source `createProviderSettingsView` consumes (`snapshot.registry` / provider config). Concretely: call `createWorkspaceZCodeApp(context, workspace, ...)` only if no active session, use its provider settings view (`app` exposes provider settings via the facade - mirror how `getView()` providers/models are listed in `providerFacadeServices.ts`), collect `{ providerId, modelId }` for every enabled model, then `engine.pruneTo(models)` + `engine.registerModels(models)`.

5. Error observation: attach a sink to each session app so normal chat traffic feeds the engine. Locate where session records are registered (`rg -n "sessions.set" apps/zcode-cli/packages/bootstrap/src`) and after registration add:

```ts
attachModelProbeSink(context, record);
```

with (in `model-probe/` index file or server.ts):

```ts
export function attachModelProbeSink(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
): void {
  const engine = getProbeEngine(context, record.workspace);
  const dispose = record.app.subscribeEvents({
    onSessionEvent: (event) => {
      if (event.type !== "model_error" && event.type !== "model_complete") return;
      const selection = readModelSelectionFromEvent(event);
      if (!selection) return;
      const latencyMs =
        event.type === "model_complete" &&
        typeof (event.payload as { latencyMs?: unknown })?.latencyMs === "number"
          ? (event.payload as { latencyMs: number }).latencyMs
          : undefined;
      void engine
        .onSessionModelEvent({
          type: event.type === "model_error" ? "error" : "complete",
          providerId: selection.providerId,
          modelId: selection.modelId,
          ...(latencyMs !== undefined ? { latencyMs } : {}),
        })
        .catch(() => {});
    },
  });
  record.modelProbeSinkDispose = dispose;
}
```

Read `model_selected`/`model_error` payload shapes from `apps/zcode-cli/packages/contracts/src/events/session.events.ts` to write `readModelSelectionFromEvent` (the events carry provider/model in their payloads; the exact field names are defined there - implement the reader against those types, returning `{ providerId, modelId } | null`). Add the optional `modelProbeSinkDispose?: () => void` field to `ZCodeProtocolSessionRecord` in `server-types.ts` and call it wherever session records are disposed (search `sessions.delete`).

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. Fix payload-shape mismatches surfaced here - the event payload types are authoritative.

- [ ] **Step 4: Commit**

```bash
git add apps/zcode-cli/packages/bootstrap/src/zcode-protocol/model-probe/probe-executor.ts apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server.ts apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-types.ts apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-runtime.ts
git commit -m "feat(bootstrap): model probe protocol handlers and session observation"
```

---

### Task 6: Services facade

**Files:**

- Create: `packages/services/src/model-probe/modelProbeService.ts`
- Modify: `packages/services/src/zcode-agent/zcodeAgent.ts` (interface methods after `testModelConnectivity`, line ~690)
- Modify: `packages/services/src/zcode-agent/zcodeAgentService.ts` (implementation after `testModelConnectivity`, line ~4412)
- Modify: `packages/services/src/accessor.ts` (add `readonly modelProbeService: IModelProbeService;` after `modelSelectionService`)
- Modify: `packages/services/src/index.ts` and `packages/services/src/node.ts` (export + wire into the service bundle where `modelSelectionService` is constructed)
- Modify: wherever the services bundle is assembled (search `createModelSelectionService(` usages) to construct and register the new service

- [ ] **Step 1: Interface + descriptor**

```ts
// packages/services/src/model-probe/modelProbeService.ts
import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import type { ZCodeModelProbeConfig, ZCodeModelProbeView } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type { ZCodeAgentModelProbeTarget } from "../zcode-agent/zcodeAgent.js";

export interface IModelProbeService {
  readonly onDidChange: Event<ZCodeModelProbeView>;
  getView(): Promise<ZCodeModelProbeView>;
  probeAll(config?: Partial<ZCodeModelProbeConfig>): Promise<void>;
  updateConfig(config: ZCodeModelProbeConfig): Promise<ZCodeModelProbeView>;
}

export const IModelProbeService = createServiceDescriptor<IModelProbeService>(
  ServiceChannels.ModelProbe,
);

export interface ModelProbeServiceDeps {
  /** 按 workspace 目标解析 zcodeAgent 客户端并发起协议调用（与 testModelConnectivity 同构）。 */
  request: <T>(method: string, params: unknown, parse: (value: unknown) => T) => Promise<T>;
  target: ZCodeAgentModelProbeTarget;
}

export function createModelProbeService(deps: ModelProbeServiceDeps): IModelProbeService {
  return {
    onDidChange: (listener) => ({ dispose: () => void listener }),
    // View 订阅通过 UI hook 侧轮询 getView（revision 比较）实现；
    // 协议通知面后续可加 providerModelProbeChanged，首版不引入。
    async getView() {
      return deps.request(
        "provider/modelProbeGetView",
        { workspace: deps.target },
        (value) => value as ZCodeModelProbeView,
      );
    },
    async probeAll(config) {
      await deps.request(
        "provider/modelProbeProbeAll",
        { workspace: deps.target, ...(config ? { config } : {}) },
        (value) => value as { started: boolean },
      );
    },
    async updateConfig(next) {
      return deps.request(
        "provider/modelProbeUpdateConfig",
        { workspace: deps.target, config: next },
        (value) => value as ZCodeModelProbeView,
      );
    },
  };
}
```

Note: if the repo has an established pattern for service change events over the zcode protocol (search for an existing notification, e.g. how provider settings view changes reach the UI), mirror that instead of revision-polling; otherwise the revision-compare in the hook is the first-version contract.

- [ ] **Step 2: zcodeAgent interface + service implementation**

In `zcodeAgent.ts` after the `testModelConnectivity` declaration add:

```ts
export interface ZCodeAgentModelProbeTarget extends ZCodeAgentWorkspaceTarget {}

export interface ZCodeAgentModelProbeGetViewParams extends ZCodeAgentWorkspaceTarget {}
export interface ZCodeAgentModelProbeProbeAllParams extends ZCodeAgentWorkspaceTarget {
  config?: Partial<ZCodeModelProbeConfig>;
}
export interface ZCodeAgentModelProbeUpdateConfigParams extends ZCodeAgentWorkspaceTarget {
  config: ZCodeModelProbeConfig;
}
```

and on the `ZCodeAgent` interface:

```ts
  modelProbeGetView(
    params: ZCodeAgentModelProbeGetViewParams,
  ): Promise<ZCodeProviderModelProbeGetViewResult>;
  modelProbeProbeAll(
    params: ZCodeAgentModelProbeProbeAllParams,
  ): Promise<ZCodeProviderModelProbeProbeAllResult>;
  modelProbeUpdateConfig(
    params: ZCodeAgentModelProbeUpdateConfigParams,
  ): Promise<ZCodeProviderModelProbeUpdateConfigResult>;
```

In `zcodeAgentService.ts` after the `testModelConnectivity` implementation add (mirroring its shape):

```ts
    async modelProbeGetView(params: ZCodeAgentModelProbeGetViewParams) {
      const client = await getClient(params);
      return client.request(
        zcodeProtocolMethods.providerModelProbeGetView,
        { workspace: buildWorkspaceRef(params) },
        zcodeProviderModelProbeGetViewResultSchema,
        { signal: params.signal },
      );
    },

    async modelProbeProbeAll(params: ZCodeAgentModelProbeProbeAllParams) {
      const client = await getClient(params);
      return client.request(
        zcodeProtocolMethods.providerModelProbeProbeAll,
        {
          workspace: buildWorkspaceRef(params),
          ...(params.config ? { config: params.config } : {}),
        },
        zcodeProviderModelProbeProbeAllResultSchema,
        { signal: params.signal },
      );
    },

    async modelProbeUpdateConfig(params: ZCodeAgentModelProbeUpdateConfigParams) {
      const client = await getClient(params);
      return client.request(
        zcodeProtocolMethods.providerModelProbeUpdateConfig,
        { workspace: buildWorkspaceRef(params), config: params.config },
        zcodeProviderModelProbeUpdateConfigResultSchema,
        { signal: params.signal },
      );
    },
```

- [ ] **Step 3: Register in accessor + bundle**

`accessor.ts`: after `readonly modelSelectionService: IModelSelectionService;` add:

```ts
  /** Host 进程内模型健康账本的只读视图与探测命令面。 */
  readonly modelProbeService: IModelProbeService;
```

Then find where the services bundle is constructed (search `modelSelectionService:` in `packages/services/src/node.ts` and any workspace-services factory) and construct `createModelProbeService` with the same workspace target resolution used for the zcode agent service. If the bundle is assembled per-host in `packages/services/src/node.ts`, follow the exact pattern of a sibling service there.

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/services/src/model-probe packages/services/src/zcode-agent packages/services/src/accessor.ts packages/services/src/index.ts packages/services/src/node.ts
git commit -m "feat(services): model probe service facade over zcode protocol"
```

---

### Task 7: UI hooks

**Files:**

- Create: `packages/ui/src/hooks/useModelProbeStatus.ts`
- Create: `packages/ui/src/hooks/useModelProbeView.ts`

- [ ] **Step 1: Status hook for the picker**

```ts
// packages/ui/src/hooks/useModelProbeStatus.ts
import { useEffect, useMemo, useState } from "react";
import type { ZCodeModelProbeView } from "@zcode/shared";
import type { ModelProbeStatus } from "@zcode/shared";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";

export type ModelProbeStatusMap = Map<string, ModelProbeStatus>;

export const modelProbeStatusKey = (providerId: string, modelId: string): string =>
  `${providerId}:${modelId}`;

/**
 * 订阅当前 workspace 目标 Host 的健康账本视图，返回 providerId:modelId → status。
 * 视图带 revision；轮询重读只发生在 Host View 读取失败后的有界重试，事件面未接入前
 * 以 revision 变化触发重读（引擎每次状态迁移都会 revision+1）。
 */
export function useModelProbeStatus(
  workspacePath: string | null | undefined,
  remoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): { statusMap: ModelProbeStatusMap; revision: number } {
  const resolution = useWorkspaceServicesResolution(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
  );
  const service = resolution.services.modelProbeService;
  const [view, setView] = useState<ZCodeModelProbeView | null>(null);
  const hasTarget = Boolean(workspacePath?.trim() || workspaceIdentity?.trim());

  useEffect(() => {
    if (!service || !hasTarget) {
      setView(null);
      return;
    }
    let cancelled = false;
    let latestRevision = -1;
    const read = (): void => {
      void service.getView().then(
        (candidate) => {
          if (cancelled || candidate.revision < latestRevision) return;
          latestRevision = candidate.revision;
          setView(candidate);
        },
        (error: unknown) => {
          logger.warn("[model-probe] Host View 读取失败", { error });
        },
      );
    };
    read();
    // 引擎 revision 每次 commit 递增；尚未有推送事件面时按 revision 轮询（1s 退避上限）。
    const timer = setInterval(read, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [service, hasTarget]);

  const statusMap = useMemo<ModelProbeStatusMap>(() => {
    const map: ModelProbeStatusMap = new Map();
    if (!view) return map;
    for (const entry of view.entries) {
      map.set(modelProbeStatusKey(entry.providerId, entry.modelId), entry.status);
    }
    return map;
  }, [view]);

  return { statusMap, revision: view?.revision ?? -1 };
}
```

(Import `useModelSelectionServiceView` only if actually used - the first version polls; drop that import if unused so lint stays clean.)

- [ ] **Step 2: Full-view hook for settings**

```ts
// packages/ui/src/hooks/useModelProbeView.ts
import { useEffect, useState } from "react";
import type { ZCodeModelProbeView } from "@zcode/shared";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";

export interface ModelProbeViewRead {
  view: ZCodeModelProbeView | null;
  loading: boolean;
  error: Error | null;
  reload(): void;
}

export function useModelProbeView(
  workspacePath: string | null | undefined,
  workspaceIdentity?: string | null,
): ModelProbeViewRead {
  const resolution = useWorkspaceServicesResolution(workspacePath, null, workspaceIdentity);
  const service = resolution.services.modelProbeService;
  const hasTarget = Boolean(workspacePath?.trim() || workspaceIdentity?.trim());
  const [state, setState] = useState<{
    view: ZCodeModelProbeView | null;
    loading: boolean;
    error: Error | null;
  }>({ view: null, loading: hasTarget, error: null });
  const [reloadVersion, setReloadVersion] = useState(0);

  useEffect(() => {
    if (!service || !hasTarget) {
      setState({ view: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    const read = (): void => {
      void service.getView().then(
        (view) => {
          if (!cancelled) setState({ view, loading: false, error: null });
        },
        (error: unknown) => {
          if (!cancelled) {
            setState({
              view: null,
              loading: false,
              error: error instanceof Error ? error : new Error(String(error)),
            });
          }
        },
      );
    };
    read();
    const timer = setInterval(read, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [service, hasTarget, reloadVersion]);

  return {
    ...state,
    reload: () => setReloadVersion((value) => value + 1),
    probeAll: (config?: Partial<ZCodeModelProbeConfig>) =>
      service?.probeAll(config) ?? Promise.resolve(),
  };
}
```

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/hooks/useModelProbeStatus.ts packages/ui/src/hooks/useModelProbeView.ts
git commit -m "feat(ui): model probe status and view hooks"
```

---

### Task 8: Picker presentation + ModelConfigSelect integration

**Files:**

- Create: `packages/ui/src/lib/modelProbePresentation.ts`
- Create: `packages/ui/test/modelProbePresentation.test.ts`
- Modify: `packages/ui/src/ModelConfigSelect.tsx` (row rendering + group ordering)

- [ ] **Step 1: Pure presentation helpers + failing test**

```ts
// packages/ui/test/modelProbePresentation.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  MODEL_PROBE_TIER_ORDER,
  modelProbeDotClass,
  sortModelProbeGroups,
} from "../src/lib/modelProbePresentation.js";
import type { ModelSelectGroup } from "../src/lib/modelSelectionGroups.js";

function item(key: string, name: string) {
  return { key, value: key, name };
}

test("dots map status to tailwind classes", () => {
  assert.equal(modelProbeDotClass("alive"), "bg-emerald-500");
  assert.equal(modelProbeDotClass("dead"), "bg-red-500");
  assert.equal(modelProbeDotClass("unknown"), null);
});

test("groups are tiered alive→unknown→dead, alphabetical within tier", () => {
  const groups: ModelSelectGroup[] = [
    {
      key: "provider-1",
      label: "Provider 1",
      items: [item("z-p:m-zeta", "Zeta"), item("z-p:m-alpha", "Alpha")],
    },
  ];
  const statusMap = new Map([
    ["z-p:m-zeta", "dead" as const],
    ["z-p:m-alpha", "alive" as const],
  ]);
  const sorted = sortModelProbeGroups(groups, statusMap);
  assert.deepEqual(
    sorted[0].items.map((entry) => entry.name),
    ["Alpha", "Zeta"],
  );
  assert.deepEqual(
    sorted[0].items.map((entry) => MODEL_PROBE_TIER_ORDER[statusMap.get(entry.key) ?? "unknown"]),
    [0, 2],
  );
});
```

Run: `npx tsx --test packages/ui/test/modelProbePresentation.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 2: Implement the helpers**

```ts
// packages/ui/src/lib/modelProbePresentation.ts
// 健康展示纯函数：圆点配色 + 组内 Alive → Unknown → Dead 分层排序。
// 分层只在 provider 组内部生效：全局跨组重排会破坏 provider 分组语义。
import type { ModelProbeStatus } from "@zcode/shared";
import type { ModelSelectGroup } from "@/lib/modelSelectionGroups.js";

export const MODEL_PROBE_TIER_ORDER: Record<ModelProbeStatus, number> = {
  alive: 0,
  unknown: 1,
  dead: 2,
};

export function modelProbeDotClass(status: ModelProbeStatus | undefined): string | null {
  if (status === "alive") return "bg-emerald-500";
  if (status === "dead") return "bg-red-500";
  return null;
}

export function sortModelProbeGroups<T extends { items: Array<{ key: string; name: string }> }>(
  groups: readonly T[],
  statusMap: ReadonlyMap<string, ModelProbeStatus>,
): T[] {
  return groups.map((group) => ({
    ...group,
    items: [...group.items].sort((a, b) => {
      const tierA = MODEL_PROBE_TIER_ORDER[statusMap.get(a.key) ?? "unknown"];
      const tierB = MODEL_PROBE_TIER_ORDER[statusMap.get(b.key) ?? "unknown"];
      if (tierA !== tierB) return tierA - tierB;
      return a.name.localeCompare(b.name);
    }),
  }));
}
```

Verify the `ModelSelectGroup` item type name in `packages/ui/src/lib/modelSelectionGroups.ts` and adjust the generic constraint to the real shape (item key field is whatever `ModelConfigSelect` uses to build the `key`); the dot lookup key must match `modelProbeStatusKey(entry.providerId, entry.modelId)` from Task 7.

- [ ] **Step 3: Run tests to verify they pass**

Run: `npx tsx --test packages/ui/test/modelProbePresentation.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 4: Integrate into ModelConfigSelect**

In `packages/ui/src/ModelConfigSelect.tsx`:

1. The component (or its parent session pane) already has `workspacePath` context; call `useModelProbeStatus(workspacePath, remoteSessionId, workspaceIdentity)` at the point where the model groups are built (same level that composes `useModelSelectionView`), and thread `statusMap` down as a prop to the group rendering.
2. Where each model row is rendered (find the item row JSX - rows show the model `name`), add before the label:

```tsx
{
  (() => {
    const dot = modelProbeDotClass(statusMap.get(item.key));
    return dot ? (
      <span
        aria-hidden
        className={cn("inline-block h-2 w-2 shrink-0 rounded-full", dot)}
        data-testid={testId(TID_CHAT_MODEL_SELECT_ITEM, "health-dot")}
      />
    ) : null;
  })();
}
```

3. Apply `sortModelProbeGroups(groups, statusMap)` at the point where groups are passed into the menu (the `groupModelsByProvider` / selection-group composition site in `lib/modelSelectionGroups.ts`'s consumer).
4. Do not filter items; Dead stays selectable.

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/lib/modelProbePresentation.ts packages/ui/test/modelProbePresentation.test.ts packages/ui/src/ModelConfigSelect.tsx
git commit -m "feat(ui): health dots and tiered ordering in model selection"
```

---

### Task 9: Settings section registration

**Files:**

- Modify: `packages/ui/src/lib/settingsNavigation.ts` (add `"modelProbe"` to `SettingsSectionId` union, line ~4)
- Modify: `packages/ui/src/settings/settingsPageConfig.ts` (new section after `modelProvider`, line ~75)

- [ ] **Step 1: Add the section id**

In `settingsNavigation.ts`, extend the `SettingsSectionId` union with `"modelProbe"` (place after `"modelProvider"`).

- [ ] **Step 2: Register in settingsPageConfig**

In `settingsPageConfig.ts`, after the `modelProvider` entry (line 71-75) add:

```ts
  {
    id: "modelProbe",
    icon: Activity,
    titleId: "settings.modelProbe.title",
    groupId: "basics",
  },
```

and add `Activity` to the `lucide-react` import at the top of the file.

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (the section renders nothing until Task 10 wires the content; a title key missing is an i18n runtime issue, added next task).

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/lib/settingsNavigation.ts packages/ui/src/settings/settingsPageConfig.ts
git commit -m "feat(ui): register model probe settings section"
```

---

### Task 10: ModelProbeSection UI + i18n

**Files:**

- Create: `packages/ui/src/settings/ModelProbeSection.tsx`
- Modify: `packages/ui/src/SettingsPage.tsx` (render switch, after the `modelProvider` branch at line ~1812)
- Modify: `packages/ui/src/i18n/locales/en-US.ts` and `zh-CN.ts`

- [ ] **Step 1: The section component**

```tsx
// packages/ui/src/settings/ModelProbeSection.tsx
import { useMemo, useState } from "react";
import { Activity, RefreshCwIcon } from "lucide-react";
import type { ZCodeModelProbeEntry, ZCodeModelProbeStatus } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useModelProbeView } from "@/hooks/useModelProbeView.js";
import { modelProbeDotClass } from "@/lib/modelProbePresentation.js";
import { useTranslation } from "@/i18n/useTranslation.js";

type ModelProbeTab = ZCodeModelProbeStatus;

const TAB_ORDER: readonly ModelProbeTab[] = ["alive", "dead", "unknown"];

export function ModelProbeSection(props: { workspacePath: string; workspaceIdentity?: string }) {
  const { t } = useTranslation();
  const { view, loading, error, reload, probeAll } = useModelProbeView(
    props.workspacePath,
    props.workspaceIdentity,
  );
  const [tab, setTab] = useState<ModelProbeTab>("alive");
  const [probing, setProbing] = useState(false);

  const rows = useMemo(() => {
    const entries = view?.entries ?? [];
    return entries.filter((entry) => entry.status === tab);
  }, [view, tab]);

  const handleProbeAll = async (): Promise<void> => {
    // probeAll 经 workspace services 解析的 modelProbeService 发起；
    // 引擎并发与超时由 Host 端 config 决定，UI 只传可选覆盖。
    setProbing(true);
    try {
      await probeAll();
      reload();
    } finally {
      setProbing(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4" />
          <h2 className="text-base font-semibold">{t("settings.modelProbe.title")}</h2>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void reload()} disabled={loading}>
            <RefreshCwIcon className="h-3.5 w-3.5" />
            {t("settings.modelProbe.refresh")}
          </Button>
          <Button size="sm" onClick={() => void handleProbeAll()} disabled={probing}>
            {probing ? t("settings.modelProbe.probing") : t("settings.modelProbe.probeAll")}
          </Button>
        </div>
      </div>
      {error ? <p className="text-sm text-red-500">{t("settings.modelProbe.readError")}</p> : null}
      <div className="flex gap-1" role="tablist">
        {TAB_ORDER.map((candidate) => (
          <button
            key={candidate}
            role="tab"
            aria-selected={tab === candidate}
            onClick={() => setTab(candidate)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm",
              tab === candidate ? "bg-primary text-primary-foreground" : "hover:bg-muted",
            )}
          >
            {t(`settings.modelProbe.tab.${candidate}`)}
            <span className="ml-1.5 text-xs opacity-70">
              {(view?.entries ?? []).filter((entry) => entry.status === candidate).length}
            </span>
          </button>
        ))}
      </div>
      <div className="overflow-hidden rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase opacity-70">
            <tr>
              <th className="px-3 py-2">{t("settings.modelProbe.column.model")}</th>
              <th className="px-3 py-2">{t("settings.modelProbe.column.provider")}</th>
              <th className="px-3 py-2">{t("settings.modelProbe.column.latency")}</th>
              <th className="px-3 py-2">{t("settings.modelProbe.column.lastResult")}</th>
              <th className="px-3 py-2">{t("settings.modelProbe.column.attempts")}</th>
              <th className="px-3 py-2">{t("settings.modelProbe.column.nextRetry")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center opacity-60">
                  {t("settings.modelProbe.empty")}
                </td>
              </tr>
            ) : (
              rows.map((entry) => (
                <ModelProbeRow key={`${entry.providerId}:${entry.modelId}`} entry={entry} />
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ModelProbeRow({ entry }: { entry: ZCodeModelProbeEntry }) {
  const { t } = useTranslation();
  const dot = modelProbeDotClass(entry.status);
  return (
    <tr className="border-t">
      <td className="px-3 py-2">
        <span className="mr-2 inline-flex items-center gap-1.5">
          {dot ? (
            <span aria-hidden className={cn("inline-block h-2 w-2 rounded-full", dot)} />
          ) : null}
        </span>
        {entry.modelId}
      </td>
      <td className="px-3 py-2 opacity-80">{entry.providerId}</td>
      <td className="px-3 py-2">{entry.latencyMs != null ? `${entry.latencyMs} ms` : "-"}</td>
      <td className="max-w-[280px] truncate px-3 py-2" title={entry.lastError}>
        {entry.status === "alive" ? t("settings.modelProbe.result.ok") : (entry.lastError ?? "-")}
      </td>
      <td className="px-3 py-2">{entry.attemptCount}</td>
      <td className="px-3 py-2">
        {entry.nextRetryAt != null ? new Date(entry.nextRetryAt).toLocaleTimeString() : "-"}
      </td>
    </tr>
  );
}
```

Note: the section calls `probeAll()` from `useModelProbeView`'s return value (Task 7 already exposes it). The TTFT column: add once the executor reports `ttftMs`; first version renders latency only if `ttftMs` is undefined.

- [ ] **Step 2: Wire into SettingsPage**

In `packages/ui/src/SettingsPage.tsx`, after the `activeSection === "modelProvider"` ternary branch (line ~1812-1827), add:

```tsx
                        ) : activeSection === "modelProbe" ? (
                          <ServiceProvider services={localHostServices}>
                            {/* 健康账本是 Host 全局事实；远端 workspace 激活时仍读本机 Host。 */}
                            <ModelProbeSection
                              workspacePath={activeWorkspacePath ?? captionWorkspacePath ?? ""}
                              workspaceIdentity={activeWorkspaceIdentity}
                            />
                          </ServiceProvider>
```

with the import `import { ModelProbeSection } from "@/settings/ModelProbeSection.js";` beside the `ModelProviderSection` import (line 57).

- [ ] **Step 3: i18n keys**

Add to `en-US.ts` (settings namespace, near `modelProviderTitle`):

```ts
  "settings.modelProbe.title": "Model Probe",
  "settings.modelProbe.refresh": "Refresh",
  "settings.modelProbe.probeAll": "Probe all",
  "settings.modelProbe.probing": "Probing...",
  "settings.modelProbe.readError": "Failed to read model health.",
  "settings.modelProbe.tab.alive": "Alive",
  "settings.modelProbe.tab.dead": "Dead",
  "settings.modelProbe.tab.unknown": "Unknown",
  "settings.modelProbe.column.model": "Model",
  "settings.modelProbe.column.provider": "Provider",
  "settings.modelProbe.column.latency": "Latency",
  "settings.modelProbe.column.lastResult": "Last result",
  "settings.modelProbe.column.attempts": "Attempts",
  "settings.modelProbe.column.nextRetry": "Next retry",
  "settings.modelProbe.result.ok": "OK",
  "settings.modelProbe.empty": "No models in this state yet.",
```

And matching `zh-CN.ts` entries:

```ts
  "settings.modelProbe.title": "模型探测",
  "settings.modelProbe.refresh": "刷新",
  "settings.modelProbe.probeAll": "全部探测",
  "settings.modelProbe.probing": "探测中...",
  "settings.modelProbe.readError": "读取模型健康状态失败。",
  "settings.modelProbe.tab.alive": "存活",
  "settings.modelProbe.tab.dead": "失效",
  "settings.modelProbe.tab.unknown": "未探测",
  "settings.modelProbe.column.model": "模型",
  "settings.modelProbe.column.provider": "提供方",
  "settings.modelProbe.column.latency": "延迟",
  "settings.modelProbe.column.lastResult": "最近结果",
  "settings.modelProbe.column.attempts": "尝试次数",
  "settings.modelProbe.column.nextRetry": "下次复查",
  "settings.modelProbe.result.ok": "正常",
  "settings.modelProbe.empty": "该状态下暂无模型。",
```

Match the exact file/namespace structure used by existing `settings.*` keys in both locale files (they may be nested objects rather than flat keys - mirror the existing shape).

- [ ] **Step 4: Typecheck + lint + manual smoke**

Run: `pnpm typecheck && pnpm lint`
Then `pnpm dev:desktop`, open Settings → Model Probe: tabs render, "Probe all" dispatches, dots appear in the composer model picker.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/settings/ModelProbeSection.tsx packages/ui/src/SettingsPage.tsx packages/ui/src/hooks/useModelProbeView.ts packages/ui/src/i18n/locales/en-US.ts packages/ui/src/i18n/locales/zh-CN.ts
git commit -m "feat(ui): settings model probe section with i18n"
```

---

### Task 11: Final verification + spec cross-check

**Files:** none new; verification only.

- [ ] **Step 1: Full gates**

```bash
node scripts/check-workspace-freshness.mjs
pnpm typecheck
pnpm lint
pnpm architecture:check --changed
```

Expected: all PASS. If architecture check flags a new boundary violation (e.g. ui importing from bootstrap), fix the dependency direction - UI touches only `@zcode/shared` types + services descriptors.

- [ ] **Step 2: Cross-check against the spec**

Verify each spec section maps to a task: §3 architecture → Tasks 3-6; §4 engine → Tasks 1, 3, 4, 5; §5 protocol/services/hooks → Tasks 2, 6, 7; §6 picker → Task 8; §7 settings → Tasks 9-10; §8 edge behavior → Tasks 1 (zod rejects invalid config), 3 (atomic writes, corrupt-file tolerance), 5 (registry sync + prune); §9 event order → Tasks 1 + 4 tests; §10 testing → Tasks 1, 3, 4, 8 tests + gates. Update the spec file in-place for the two documented refinements (engine home = bootstrap server; JSON ledger instead of session-store migration) so the spec matches reality.

- [ ] **Step 3: Commit any spec updates**

```bash
git add docs/superpowers/specs/2026-09-29-model-probe-design.md
git commit -m "docs: align model probe spec with implemented architecture"
```

---

## Notes for implementers

- **Testing invocation:** repo has no global test script; per-file tests run with `npx tsx --test <file>` (tsx is available). packages/services and packages/ui have `test/` dirs with `node:test` precedent; packages/shared and the bootstrap package get their first `test/` files in this plan.
- **Payload shapes:** the exact `model_error` / `model_complete` payload field names in Task 5 must be read from `apps/zcode-cli/packages/contracts/src/events/session.events.ts` (search `ModelError:` and `ModelComplete:` payload interfaces). The `readModelSelectionFromEvent` helper's correctness is gated by the typecheck against those types.
- **Cancellation filter:** the `model_error` event must be checked for cancellation before counting as failure - the contracts file defines how user-initiated aborts surface (an abort flag or a distinct payload field). If aborts arrive as a separate event type, Task 4's "abort" branch handles it; if they arrive inside `model_error` payloads, `readModelSelectionFromEvent` must return null for them.
- **Do not** write ledger state from UI or services - all writes go through the engine in the Host process.
