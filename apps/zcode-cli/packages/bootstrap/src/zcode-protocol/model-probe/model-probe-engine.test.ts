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
    assert.equal(view.entries.find((e) => e.modelId === "m"), undefined);
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
