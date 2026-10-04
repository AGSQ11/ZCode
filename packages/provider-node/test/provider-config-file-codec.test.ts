import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeProviderConfigFile,
  encodeProviderConfigFile,
} from "../src/provider-config-file-codec.js";
import { ProviderConfigMap, ModelConfigRules } from "@zcode/provider";

test("G01 & G02: Provider config codec decodes legacy config with defaultModelSelection into ExecutionTarget", () => {
  const legacyConfig = {
    schemaVersion: 1,
    config: {
      providerOrder: ["provider-a"],
      providerConfigRules: {
        providerRules: [],
      },
      modelConfigRules: {
        providerModelRules: [],
        manualProviderModelRules: [],
      },
      defaultModelSelection: {
        providerId: "provider-a",
        modelId: "model-1",
      },
    },
  };

  const decoded = decodeProviderConfigFile(legacyConfig);
  assert.equal(decoded.defaultModelSelection?.providerId, "provider-a");
  assert.equal(decoded.defaultModelSelection?.modelId, "model-1");
  assert.deepEqual(decoded.defaultTarget, {
    kind: "model",
    selection: {
      providerId: "provider-a",
      modelId: "model-1",
    },
  });
  assert.equal(decoded.modelGroups, undefined);
});

test("G01 & G02: Provider config codec preserves modelGroups and group defaultTarget", () => {
  const update = {
    providers: ProviderConfigMap.empty(),
    models: ModelConfigRules.empty(),
    providerOrder: ["p1"],
    defaultTarget: {
      kind: "group" as const,
      groupId: "group-1",
    },
    modelGroups: {
      schemaVersion: 1 as const,
      revision: 1,
      groups: [
        {
          id: "group-1",
          revision: 1,
          name: "Fast Models",
          description: "Fast routing group",
          enabled: true,
          workloadLevel: "light" as const,
          strategy: "round_robin" as const,
          affinity: "turn" as const,
          members: [
            {
              id: "m1",
              selection: { providerId: "p1", modelId: "fast-1" },
              enabled: true,
              weight: 1,
              maxInFlight: null,
            },
          ],
          failover: {
            enabled: true,
            maxMemberAttempts: 2,
            requestDeadlineMs: 30000,
          },
        },
      ],
      workloadDefaults: {
        light: "group-1",
      },
    },
  };

  const encoded = encodeProviderConfigFile(update);
  assert.equal(encoded.schemaVersion, 1);
  assert.deepEqual(encoded.config.defaultTarget, { kind: "group", groupId: "group-1" });
  assert.equal(encoded.config.modelGroups.groups.length, 1);

  const decoded = decodeProviderConfigFile(encoded);
  assert.deepEqual(decoded.defaultTarget, { kind: "group", groupId: "group-1" });
  assert.equal(decoded.modelGroups?.groups.length, 1);
  assert.equal(decoded.modelGroups?.groups[0]?.name, "Fast Models");
  assert.equal(decoded.modelGroups?.workloadDefaults.light, "group-1");
});
