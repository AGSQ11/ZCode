import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createModelProbeLedgerStore,
  MODEL_PROBE_LEDGER_FILE,
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

test("stamps schema version and writes the ledger file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "model-probe-ledger-"));
  try {
    const store = createModelProbeLedgerStore({ dataDir: dir });
    const key = { workspaceKey: "ws-1", providerId: "p", modelId: "m" };
    await store.put(key, createProbeEntry({ providerId: "p", modelId: "m" }));
    const raw = JSON.parse(
      await readFile(join(dir, MODEL_PROBE_LEDGER_FILE), "utf8"),
    ) as ModelProbeLedgerFile;
    assert.equal(raw.schemaVersion, MODEL_PROBE_LEDGER_SCHEMA_VERSION);
    assert.ok(raw.workspaces["ws-1"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing file reads as empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "model-probe-ledger-"));
  try {
    const store = createModelProbeLedgerStore({ dataDir: dir });
    assert.deepEqual(await store.list("ws-1"), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("corrupt JSON file reads as empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "model-probe-ledger-"));
  try {
    await writeFile(join(dir, MODEL_PROBE_LEDGER_FILE), "{not json", "utf8");
    const store = createModelProbeLedgerStore({ dataDir: dir });
    assert.deepEqual(await store.list("ws-1"), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("schema version mismatch reads as empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "model-probe-ledger-"));
  try {
    await writeFile(
      join(dir, MODEL_PROBE_LEDGER_FILE),
      JSON.stringify({ schemaVersion: 999, workspaces: { "ws-1": {} } }),
      "utf8",
    );
    const store = createModelProbeLedgerStore({ dataDir: dir });
    assert.deepEqual(await store.list("ws-1"), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent cold-cache puts both persist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "model-probe-ledger-"));
  try {
    const store = createModelProbeLedgerStore({ dataDir: dir });
    const keyA = { workspaceKey: "ws-1", providerId: "p", modelId: "a" };
    const keyB = { workspaceKey: "ws-1", providerId: "p", modelId: "b" };
    // 故意不在两次 put 之间 await：冷缓存下两个并发写必须收敛到同一内存账本，
    // 否则各自独立读盘、后 flush 者覆盖先 flush 者，丢一条。
    await Promise.all([
      store.put(keyA, createProbeEntry(keyA)),
      store.put(keyB, createProbeEntry(keyB)),
    ]);
    const reloaded = createModelProbeLedgerStore({ dataDir: dir });
    assert.ok(await reloaded.get(keyA));
    assert.ok(await reloaded.get(keyB));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("flush merges buckets written by another process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "model-probe-ledger-"));
  try {
    // 第二个 store 实例模拟另一个窗口 Host 进程，先落盘一个本进程不持有的桶。
    const other = createModelProbeLedgerStore({ dataDir: dir });
    const otherKey = { workspaceKey: "ws-other", providerId: "q", modelId: "n" };
    await other.put(otherKey, createProbeEntry(otherKey));

    const store = createModelProbeLedgerStore({ dataDir: dir });
    // store 的冷读与 other 的写入时序不保证，但 flush 绕过缓存重读磁盘并合并，
    // 所以 other 的桶必须存活——这正是跨进程不互相覆盖的契约。
    const key = { workspaceKey: "ws-1", providerId: "p", modelId: "m" };
    await store.put(key, createProbeEntry(key));

    const reloaded = createModelProbeLedgerStore({ dataDir: dir });
    assert.ok(await reloaded.get(key), "own bucket persisted");
    assert.ok(await reloaded.get(otherKey), "other process bucket preserved");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("putMany round-trips", async () => {
  const dir = await mkdtemp(join(tmpdir(), "model-probe-ledger-"));
  try {
    const store = createModelProbeLedgerStore({ dataDir: dir });
    await store.putMany("ws-1", [
      createProbeEntry({ providerId: "p", modelId: "m-1" }),
      createProbeEntry({ providerId: "p", modelId: "m-2" }),
    ]);
    const reloaded = createModelProbeLedgerStore({ dataDir: dir });
    const entries = await reloaded.list("ws-1");
    assert.equal(entries.length, 2);
    const m2 = await reloaded.get({ workspaceKey: "ws-1", providerId: "p", modelId: "m-2" });
    assert.equal(m2?.status, "unknown");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
