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
  assert.equal(router.getAttempts24h("conn-1", "model-1"), 1);

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
