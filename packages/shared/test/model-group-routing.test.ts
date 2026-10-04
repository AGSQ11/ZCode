import assert from "node:assert/strict";
import test from "node:test";
import {
  compareRatios,
  computeBaseCooldownMs,
  computeEffectiveCooldownMs,
  computeRequestDeadlineMs,
  isDeadlineExceeded,
  rankCandidates,
  type MemberCandidate,
} from "../src/model-group-routing.js";
import type { ModelGroupMember } from "../src/model-group-types.js";

function makeMember(id: string, weight = 1, maxInFlight: number | null = null): ModelGroupMember {
  return {
    id,
    selection: { providerId: "p1", modelId: id },
    enabled: true,
    weight,
    maxInFlight,
  };
}

function makeCandidate(
  id: string,
  index: number,
  inFlight: number,
  attempts24h: number,
  weight = 1,
): MemberCandidate {
  return {
    member: makeMember(id, weight),
    index,
    connectionId: "conn-1",
    inFlight,
    attempts24h,
    coolingDown: false,
    capacityAvailable: true,
  };
}

test("G14: Ratio cross-multiplication comparison without floating point drift", () => {
  // 1/3 vs 1/3 -> 0
  assert.equal(compareRatios(1, 3, 1, 3), 0);
  // 1/3 vs 2/6 -> 0
  assert.equal(compareRatios(1, 3, 2, 6), 0);
  // 1/3 vs 1/2 -> -1
  assert.equal(compareRatios(1, 3, 1, 2), -1);
  // 2/3 vs 1/3 -> 1
  assert.equal(compareRatios(2, 3, 1, 3), 1);
  // Huge numbers
  assert.equal(compareRatios(1000000, 3, 1000000, 2), -1);
});

test("G20: Exponential backoff cooldown formula and Retry-After precedence", () => {
  // baseCooldownMs = min(60000, 5000 * 2^(min(n - 1, 4)))
  assert.equal(computeBaseCooldownMs(0), 0);
  assert.equal(computeBaseCooldownMs(1), 5000);  // 5000 * 2^0
  assert.equal(computeBaseCooldownMs(2), 10000); // 5000 * 2^1
  assert.equal(computeBaseCooldownMs(3), 20000); // 5000 * 2^2
  assert.equal(computeBaseCooldownMs(4), 40000); // 5000 * 2^3
  assert.equal(computeBaseCooldownMs(5), 60000); // min(60000, 5000 * 2^4 = 80000) = 60000
  assert.equal(computeBaseCooldownMs(10), 60000);

  // Effective cooldown takes max(base, valid Retry-After)
  assert.equal(computeEffectiveCooldownMs(1, 3000), 5000); // base (5000) > retryAfter (3000)
  assert.equal(computeEffectiveCooldownMs(1, 120000), 120000); // retryAfter (120000) > base (5000)
  assert.equal(computeEffectiveCooldownMs(5, 90000), 90000); // retryAfter can exceed 60000 if server says so
});

test("G11: Priority routing strategy - authoritative index order every time", () => {
  const c0 = makeCandidate("m0", 0, 0, 10);
  const c1 = makeCandidate("m1", 1, 0, 0);
  const c2 = makeCandidate("m2", 2, 0, 5);

  // Even if m1 has 0 attempts and cursor is 1, priority must pick index 0 first
  const ranked = rankCandidates([c2, c0, c1], "priority", 1, 3);
  assert.equal(ranked[0]?.member.id, "m0");
  assert.equal(ranked[1]?.member.id, "m1");
  assert.equal(ranked[2]?.member.id, "m2");
});

test("G12: Round robin routing strategy - scans cyclically from cursor", () => {
  const c0 = makeCandidate("m0", 0, 0, 0);
  const c1 = makeCandidate("m1", 1, 0, 0);
  const c2 = makeCandidate("m2", 2, 0, 0);

  // With cursor at index 1, order is m1, m2, m0
  const rankedFrom1 = rankCandidates([c0, c1, c2], "round_robin", 1, 3);
  assert.equal(rankedFrom1[0]?.member.id, "m1");
  assert.equal(rankedFrom1[1]?.member.id, "m2");
  assert.equal(rankedFrom1[2]?.member.id, "m0");

  // With cursor at index 2, order is m2, m0, m1
  const rankedFrom2 = rankCandidates([c0, c1, c2], "round_robin", 2, 3);
  assert.equal(rankedFrom2[0]?.member.id, "m2");
  assert.equal(rankedFrom2[1]?.member.id, "m0");
  assert.equal(rankedFrom2[2]?.member.id, "m1");
});

test("G13: Least used routing strategy - lowest attempts24h, ties broken by cursor", () => {
  const c0 = makeCandidate("m0", 0, 0, 15);
  const c1 = makeCandidate("m1", 1, 0, 5);
  const c2 = makeCandidate("m2", 2, 0, 5);

  // m1 and m2 both have 5 attempts. Cursor at 2 means m2 wins tie
  const rankedCursor2 = rankCandidates([c0, c1, c2], "least_used", 2, 3);
  assert.equal(rankedCursor2[0]?.member.id, "m2");
  assert.equal(rankedCursor2[1]?.member.id, "m1");
  assert.equal(rankedCursor2[2]?.member.id, "m0");

  // Cursor at 1 means m1 wins tie
  const rankedCursor1 = rankCandidates([c0, c1, c2], "least_used", 1, 3);
  assert.equal(rankedCursor1[0]?.member.id, "m1");
  assert.equal(rankedCursor1[1]?.member.id, "m2");
  assert.equal(rankedCursor1[2]?.member.id, "m0");
});

test("G14: Balanced routing strategy - weighted inFlight first, weighted attempts24h second", () => {
  // m0: weight 1, inFlight 1 -> ratio 1/1
  // m1: weight 2, inFlight 1 -> ratio 1/2 (lower inFlight ratio wins!)
  // m2: weight 1, inFlight 2 -> ratio 2/1
  const c0 = makeCandidate("m0", 0, 1, 10, 1);
  const c1 = makeCandidate("m1", 1, 1, 100, 2);
  const c2 = makeCandidate("m2", 2, 2, 0, 1);

  const ranked = rankCandidates([c0, c1, c2], "balanced", 0, 3);
  assert.equal(ranked[0]?.member.id, "m1"); // 1/2 < 1/1 < 2/1
  assert.equal(ranked[1]?.member.id, "m0");
  assert.equal(ranked[2]?.member.id, "m2");

  // Tied inFlight: secondary sort on attempts24h / weight
  const c3 = makeCandidate("m3", 0, 0, 10, 1); // 0 inFlight, 10/1 attempts
  const c4 = makeCandidate("m4", 1, 0, 15, 2); // 0 inFlight, 15/2 = 7.5 attempts (lower!)
  const rankedTiedInFlight = rankCandidates([c3, c4], "balanced", 0, 2);
  assert.equal(rankedTiedInFlight[0]?.member.id, "m4");
  assert.equal(rankedTiedInFlight[1]?.member.id, "m3");
});

test("P2-4: computeRequestDeadlineMs adds budget onto a monotonic start", () => {
  // Normal case: absolute deadline = start + budget.
  assert.equal(computeRequestDeadlineMs(1000, 30000), 31000);
  assert.equal(computeRequestDeadlineMs(0, 600000), 600000);

  // Zero/negative/non-finite budgets degenerate to "no remaining budget".
  assert.equal(computeRequestDeadlineMs(1000, 0), 1000);
  assert.equal(computeRequestDeadlineMs(1000, -5), 1000);
  assert.equal(computeRequestDeadlineMs(1000, NaN), 1000);
  assert.equal(computeRequestDeadlineMs(1000, Infinity), 1000);

  // Non-finite or negative start is clamped to 0.
  assert.equal(computeRequestDeadlineMs(NaN, 100), 100);
  assert.equal(computeRequestDeadlineMs(-50, 100), 100);

  // Safe-integer aware: overflow near Number.MAX_SAFE_INTEGER saturates instead
  // of wrapping into a past timestamp (which would falsely time out instantly).
  assert.equal(
    computeRequestDeadlineMs(Number.MAX_SAFE_INTEGER - 10, 1000),
    Number.MAX_SAFE_INTEGER,
  );
  assert.equal(
    computeRequestDeadlineMs(Number.MAX_SAFE_INTEGER, 1),
    Number.MAX_SAFE_INTEGER,
  );

  // Fractional inputs are floored to integer milliseconds.
  assert.equal(computeRequestDeadlineMs(100.9, 50.9), 150);
});

test("P2-4: isDeadlineExceeded compares a monotonic now against the deadline", () => {
  const deadline = computeRequestDeadlineMs(1000, 30000); // 31000

  assert.equal(isDeadlineExceeded(1000, deadline), false);
  assert.equal(isDeadlineExceeded(30999, deadline), false);
  // Reaching the deadline counts as exceeded (spec §9: GROUP_DEADLINE_EXCEEDED).
  assert.equal(isDeadlineExceeded(31000, deadline), true);
  assert.equal(isDeadlineExceeded(32000, deadline), true);

  // Non-finite or negative inputs never report exceeded (ambiguous comparison).
  assert.equal(isDeadlineExceeded(NaN, deadline), false);
  assert.equal(isDeadlineExceeded(Infinity, deadline), false);
  assert.equal(isDeadlineExceeded(32000, NaN), false);
  assert.equal(isDeadlineExceeded(-1, deadline), false);
  assert.equal(isDeadlineExceeded(32000, -1), false);

  // A saturated deadline is never exceeded within the safe-integer range.
  const saturated = computeRequestDeadlineMs(Number.MAX_SAFE_INTEGER - 10, 1000);
  assert.equal(isDeadlineExceeded(Number.MAX_SAFE_INTEGER - 1, saturated), false);
});
