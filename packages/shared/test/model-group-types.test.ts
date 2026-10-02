import assert from "node:assert/strict";
import test from "node:test";
import {
  executionTargetSchema,
  modelGroupsConfigSchema,
  modelGroupSchema,
  migrateModelSelectionToExecutionTarget,
  normalizeGroupName,
  validateGroupName,
  DEFAULT_MODEL_GROUPS_CONFIG,
  DEFAULT_MODEL_GROUP,
  DEFAULT_MODEL_GROUP_MEMBER,
  type ModelGroupsConfig,
} from "../src/model-group-types.js";

test("G03: ExecutionTarget schema validation", () => {
  const modelTarget = {
    kind: "model",
    selection: { providerId: "p1", modelId: "m1" },
  };
  assert.deepEqual(executionTargetSchema.parse(modelTarget), modelTarget);

  const groupTarget = {
    kind: "group",
    groupId: "group-uuid-1",
  };
  assert.deepEqual(executionTargetSchema.parse(groupTarget), groupTarget);

  assert.throws(() => executionTargetSchema.parse({ kind: "invalid" }));
  assert.throws(() => executionTargetSchema.parse({ kind: "group", groupId: "" }));
});

test("G50: migrateModelSelectionToExecutionTarget works seamlessly", () => {
  assert.equal(migrateModelSelectionToExecutionTarget(null), undefined);
  assert.equal(migrateModelSelectionToExecutionTarget(undefined), undefined);

  const legacy = { providerId: "openai", modelId: "gpt-4o" };
  const target = migrateModelSelectionToExecutionTarget(legacy);
  assert.deepEqual(target, { kind: "model", selection: legacy });
});

test("G03 & G04: ModelGroup validation and duplicate detection", () => {
  const validGroup = {
    id: "g1",
    revision: 1,
    name: "Heavy Models",
    description: "High capability models",
    enabled: true,
    workloadLevel: "heavy",
    strategy: "priority",
    affinity: "turn",
    members: [
      {
        id: "m1",
        selection: { providerId: "p1", modelId: "m1" },
        enabled: true,
        weight: 1,
        maxInFlight: null,
      },
    ],
    failover: {
      enabled: true,
      maxMemberAttempts: 3,
      requestDeadlineMs: 60000,
    },
  };
  assert.deepEqual(modelGroupSchema.parse(validGroup), validGroup);

  // G03: Empty group can only be saved disabled
  const emptyEnabledGroup = { ...validGroup, members: [] };
  assert.throws(() => modelGroupSchema.parse(emptyEnabledGroup));

  const emptyDisabledGroup = { ...validGroup, enabled: false, members: [] };
  assert.ok(modelGroupSchema.parse(emptyDisabledGroup));

  // G04: Duplicate tuples in same group rejected
  const dupTupleGroup = {
    ...validGroup,
    members: [
      {
        id: "m1",
        selection: { providerId: "p1", modelId: "m1" },
        enabled: true,
        weight: 1,
        maxInFlight: null,
      },
      {
        id: "m2",
        selection: { providerId: "p1", modelId: "m1" },
        enabled: true,
        weight: 1,
        maxInFlight: null,
      },
    ],
  };
  assert.throws(() => modelGroupSchema.parse(dupTupleGroup));

  // G04: Same model with different reasoning allowed
  const diffReasoningGroup = {
    ...validGroup,
    members: [
      {
        id: "m1",
        selection: { providerId: "p1", modelId: "m1", options: { reasoningLevel: "low" } },
        enabled: true,
        weight: 1,
        maxInFlight: null,
      },
      {
        id: "m2",
        selection: { providerId: "p1", modelId: "m1", options: { reasoningLevel: "high" } },
        enabled: true,
        weight: 1,
        maxInFlight: null,
      },
    ],
  };
  assert.ok(modelGroupSchema.parse(diffReasoningGroup));
});

test("G03: Name normalization and uniqueness across groups", () => {
  assert.equal(validateGroupName("  "), false);
  assert.equal(validateGroupName("Valid Name"), true);
  assert.equal(validateGroupName("Bad\u0000Control"), false);

  const config: ModelGroupsConfig = {
    schemaVersion: 1,
    revision: 1,
    groups: [
      {
        id: "g1",
        revision: 1,
        name: "Fast Models",
        description: "",
        enabled: false,
        workloadLevel: "light",
        strategy: "round_robin",
        affinity: "turn",
        members: [],
        failover: { enabled: true, maxMemberAttempts: 1, requestDeadlineMs: 5000 },
      },
      {
        id: "g2",
        revision: 1,
        name: "  fast models  ", // case-insensitive + trim duplicate
        description: "",
        enabled: false,
        workloadLevel: "light",
        strategy: "round_robin",
        affinity: "turn",
        members: [],
        failover: { enabled: true, maxMemberAttempts: 1, requestDeadlineMs: 5000 },
      },
    ],
    workloadDefaults: {},
  };
  assert.throws(() => modelGroupsConfigSchema.parse(config));
});

test("G49: Workload defaults point to groups with same workload level", () => {
  const configWithMismatchedDefault = {
    schemaVersion: 1,
    revision: 1,
    groups: [
      {
        id: "g1",
        revision: 1,
        name: "Group 1",
        description: "",
        enabled: false,
        workloadLevel: "light",
        strategy: "round_robin",
        affinity: "turn",
        members: [],
        failover: { enabled: true, maxMemberAttempts: 1, requestDeadlineMs: 5000 },
      },
    ],
    workloadDefaults: {
      heavy: "g1", // Mismatch: g1 is light, not heavy
    },
  };
  assert.throws(() => modelGroupsConfigSchema.parse(configWithMismatchedDefault));

  const configWithValidDefault = {
    ...configWithMismatchedDefault,
    workloadDefaults: {
      light: "g1",
    },
  };
  assert.ok(modelGroupsConfigSchema.parse(configWithValidDefault));
});
