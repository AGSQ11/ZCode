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
