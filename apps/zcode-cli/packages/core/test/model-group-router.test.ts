import assert from "node:assert/strict";
import test from "node:test";
import { ModelGroupRouter } from "../src/runtime/model-group-router.js";
import type { ModelGroup } from "@zcode/shared/model-group-types";

function createTestGroup(strategy: "round_robin" | "priority" | "balanced" | "least_used" = "round_robin"): ModelGroup {
  return {
    id: "group-1",
    revision: 1,
    name: "Test Group",
    description: "",
    enabled: true,
    workloadLevel: "medium",
    strategy,
    affinity: "turn",
    members: [
      {
        id: "m1",
        selection: { providerId: "p1", modelId: "model-1" },
        enabled: true,
        weight: 1,
        maxInFlight: 2,
      },
      {
        id: "m2",
        selection: { providerId: "p1", modelId: "model-2" },
        enabled: true,
        weight: 1,
        maxInFlight: 2,
      },
    ],
    failover: {
      enabled: true,
      maxMemberAttempts: 2,
      requestDeadlineMs: 30000,
    },
  };
}

test("G10 & G19: ModelGroupRouter reservation lease and inFlight accounting", async () => {
  let currentTime = 100000;
  const router = new ModelGroupRouter({
    authorityScope: "auth-1",
    getGroupsConfig: async () => undefined,
    validateMemberConnection: async (sel) => ({ valid: true, connectionId: "conn-1" }),
    now: () => currentTime,
  });

  const group = createTestGroup("priority");
  const res1 = await router.selectAndReserve(group, new Set());
  assert.ok(res1.routedAttempt);
  assert.equal(res1.routedAttempt.member.id, "m1");

  const metrics1 = router.getEndpointMetrics("conn-1", "model-1");
  assert.equal(metrics1.inFlight, 1);
  // P1-3: attempts24h 不在预留时自增，仅在物理派发时由 markDispatched() 自增。
  assert.equal(router.getAttempts24h("conn-1", "model-1"), 0);

  // Second reservation on m1 (maxInFlight is 2)
  const res2 = await router.selectAndReserve(group, new Set());
  assert.ok(res2.routedAttempt);
  assert.equal(res2.routedAttempt.member.id, "m1");
  assert.equal(metrics1.inFlight, 2);

  // Third reservation: m1 hit maxInFlight=2, so priority router falls through to m2
  const res3 = await router.selectAndReserve(group, new Set());
  assert.ok(res3.routedAttempt);
  assert.equal(res3.routedAttempt.member.id, "m2");

  // Release res1 with success
  res1.routedAttempt.reservation.release("success");
  assert.equal(metrics1.inFlight, 1);
  assert.equal(metrics1.consecutiveFailures, 0);
  assert.equal(metrics1.cooldownUntil, null);

  res2.routedAttempt.reservation.release("success");
  res3.routedAttempt.reservation.release("success");
  assert.equal(metrics1.inFlight, 0);
});

test("G20 & G21: Circuit breaker cooldown and half-open state recovery", async () => {
  let currentTime = 100000;
  const router = new ModelGroupRouter({
    authorityScope: "auth-1",
    getGroupsConfig: async () => undefined,
    validateMemberConnection: async (sel) => ({ valid: true, connectionId: "conn-1" }),
    now: () => currentTime,
  });

  const group = createTestGroup("priority");
  const res1 = await router.selectAndReserve(group, new Set());
  assert.ok(res1.routedAttempt);

  // Fail attempt 1 transiently: consecutiveFailures=1 -> base cooldown 5000ms
  res1.routedAttempt.reservation.release("transient_failure");
  const metrics = router.getEndpointMetrics("conn-1", "model-1");
  assert.equal(metrics.consecutiveFailures, 1);
  assert.equal(metrics.cooldownUntil, 105000);

  // During cooldown: m1 rejected, falls back to m2
  const resCooldown = await router.selectAndReserve(group, new Set());
  assert.ok(resCooldown.routedAttempt);
  assert.equal(resCooldown.routedAttempt.member.id, "m2");
  resCooldown.routedAttempt.reservation.release("success");

  // Advance time past cooldown
  currentTime = 106000;
  // Next reservation gets m1 as half-open probe
  const resProbe = await router.selectAndReserve(group, new Set());
  assert.ok(resProbe.routedAttempt);
  assert.equal(resProbe.routedAttempt.member.id, "m1");
  assert.equal(resProbe.routedAttempt.reservation.isHalfOpen, true);

  // While half-open is in-flight, second call skips m1
  const resWhileProbe = await router.selectAndReserve(group, new Set());
  assert.ok(resWhileProbe.routedAttempt);
  assert.equal(resWhileProbe.routedAttempt.member.id, "m2");
  resWhileProbe.routedAttempt.reservation.release("success");

  // Probe succeeds -> circuit closes!
  resProbe.routedAttempt.reservation.release("success");
  assert.equal(metrics.consecutiveFailures, 0);
  assert.equal(metrics.cooldownUntil, null);
  assert.equal(metrics.isHalfOpen, false);
});

test("P1-3: attempts24h increments only on markDispatched, not at reservation", async () => {
  let currentTime = 100000;
  const router = new ModelGroupRouter({
    authorityScope: "auth-1",
    getGroupsConfig: async () => undefined,
    validateMemberConnection: async (sel) => ({ valid: true, connectionId: "conn-1" }),
    now: () => currentTime,
  });

  const group = createTestGroup("round_robin");

  // Reservation alone must not count an attempt (skip/cancel before execution).
  const res1 = await router.selectAndReserve(group, new Set());
  assert.ok(res1.routedAttempt);
  const modelId1 = res1.routedAttempt.member.selection.modelId;
  assert.equal(router.getAttempts24h("conn-1", modelId1), 0);

  // markDispatched counts exactly once; a second call is a no-op (idempotent).
  res1.routedAttempt.reservation.markDispatched();
  assert.equal(router.getAttempts24h("conn-1", modelId1), 1);
  res1.routedAttempt.reservation.markDispatched();
  assert.equal(router.getAttempts24h("conn-1", modelId1), 1);

  // Releasing without dispatch leaves attempts24h unchanged (cancel before execution).
  res1.routedAttempt.reservation.release("cancelled");
  assert.equal(router.getAttempts24h("conn-1", modelId1), 1);

  // A fresh reservation that is cancelled before dispatch never increments.
  const res2 = await router.selectAndReserve(group, new Set());
  assert.ok(res2.routedAttempt);
  const modelId2 = res2.routedAttempt.member.selection.modelId;
  res2.routedAttempt.reservation.release("cancelled");
  assert.equal(router.getAttempts24h("conn-1", modelId2), 0);
});

test("P1-2: reservePinnedMember never moves the group cursor", async () => {
  let currentTime = 100000;
  const router = new ModelGroupRouter({
    authorityScope: "auth-1",
    getGroupsConfig: async () => undefined,
    validateMemberConnection: async (sel) => ({ valid: true, connectionId: "conn-1" }),
    now: () => currentTime,
  });

  const group = createTestGroup("round_robin");
  const m1 = group.members[0]!;
  const m2 = group.members[1]!;

  // Strategy reservation #1: cursor 0 -> picks m1, advances cursor to 1.
  const first = await router.selectAndReserve(group, new Set());
  assert.ok(first.routedAttempt);
  assert.equal(first.routedAttempt.member.id, "m1");
  assert.equal(router.getGroupCursor(group.id), 1);
  first.routedAttempt.reservation.release("success");

  // Pin reuse on m1: must reserve successfully but leave the cursor at 1.
  const pinned = await router.reservePinnedMember(group, m1);
  assert.ok(pinned.routedAttempt);
  assert.equal(pinned.routedAttempt.member.id, "m1");
  assert.equal(router.getGroupCursor(group.id), 1);
  pinned.routedAttempt.reservation.release("success");

  // Reusing the pin several times must still not corrupt the cursor.
  for (let i = 0; i < 3; i++) {
    const again = await router.reservePinnedMember(group, m1);
    assert.ok(again.routedAttempt);
    assert.equal(router.getGroupCursor(group.id), 1);
    again.routedAttempt.reservation.release("success");
  }

  // Next strategy reservation must pick up where the cursor actually is: m2 (index 1),
  // and advance the cursor back to 0. If the pin had reset the cursor to 0, this
  // reservation would have picked m1 again.
  const next = await router.selectAndReserve(group, new Set());
  assert.ok(next.routedAttempt);
  assert.equal(next.routedAttempt.member.id, "m2");
  assert.equal(router.getGroupCursor(group.id), 0);
  next.routedAttempt.reservation.release("success");
});

test("P1-2: reservePinnedMember enforces the same eligibility gates as selectAndReserve", async () => {
  let currentTime = 100000;
  const router = new ModelGroupRouter({
    authorityScope: "auth-1",
    getGroupsConfig: async () => undefined,
    validateMemberConnection: async (sel) => ({ valid: true, connectionId: "conn-1" }),
    now: () => currentTime,
  });

  const group = createTestGroup("round_robin");
  const m1 = group.members[0]!;

  // Trip the circuit on m1's endpoint via a strategy reservation.
  const first = await router.selectAndReserve(group, new Set());
  assert.ok(first.routedAttempt);
  assert.equal(first.routedAttempt.member.id, "m1");
  first.routedAttempt.reservation.release("transient_failure");

  const metrics = router.getEndpointMetrics("conn-1", "model-1");
  assert.equal(metrics.cooldownUntil, 105000);

  // Pin reuse during cooldown is rejected with circuit_cooling_down and allCoolingDown.
  const duringCooldown = await router.reservePinnedMember(group, m1);
  assert.equal(duringCooldown.routedAttempt, undefined);
  assert.equal(duringCooldown.allCoolingDown, true);
  assert.equal(duringCooldown.rejections[0]?.reason, "circuit_cooling_down");

  // After cooldown expiry the pin becomes the half-open probe, exactly like the
  // strategy path, and a concurrent second pin is rejected while the probe is in flight.
  currentTime = 106000;
  const probe = await router.reservePinnedMember(group, m1);
  assert.ok(probe.routedAttempt);
  assert.equal(probe.routedAttempt.reservation.isHalfOpen, true);
  assert.equal(metrics.isHalfOpen, true);

  const secondProbe = await router.reservePinnedMember(group, m1);
  assert.equal(secondProbe.routedAttempt, undefined);
  assert.equal(secondProbe.rejections[0]?.reason, "circuit_half_open_in_flight");

  // Probe success closes the circuit; inFlight and member capacity are released.
  probe.routedAttempt.reservation.release("success");
  assert.equal(metrics.consecutiveFailures, 0);
  assert.equal(metrics.cooldownUntil, null);
  assert.equal(metrics.isHalfOpen, false);
  assert.equal(metrics.inFlight, 0);

  // Member maxInFlight is enforced on the pin path as well (maxInFlight = 2).
  const p1 = await router.reservePinnedMember(group, m1);
  const p2 = await router.reservePinnedMember(group, m1);
  assert.ok(p1.routedAttempt);
  assert.ok(p2.routedAttempt);
  const p3 = await router.reservePinnedMember(group, m1);
  assert.equal(p3.routedAttempt, undefined);
  assert.equal(p3.allBusy, true);
  assert.equal(p3.rejections[0]?.reason, "member_max_in_flight_exceeded");
  p1.routedAttempt.reservation.release("success");
  p2.routedAttempt.reservation.release("success");
});
