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

test("outcome records carry the right provenance source", () => {
  // 观察类 wrapper 必须写入 observed-*，不能再被状态推断成 manual-probe。
  const failed = applyObservedFailure(aliveEntry(), 1000);
  assert.equal(failed.history.at(-1)?.source, "observed-failure");

  const succeeded = applyObservedSuccess(aliveEntry(), 1000, 42);
  assert.equal(succeeded.history.at(-1)?.source, "observed-success");

  // 公开 applyProbeOutcome 保持原有状态推断语义。
  const manual = applyProbeOutcome(aliveEntry(), { ok: true, checkedAt: 1000 });
  assert.equal(manual.history.at(-1)?.source, "manual-probe");

  const recheck = applyProbeOutcome(deadEntry(), {
    ok: false,
    checkedAt: 3_000_000,
    error: "down",
  });
  assert.equal(recheck.history.at(-1)?.source, "scheduled-recheck");
});
