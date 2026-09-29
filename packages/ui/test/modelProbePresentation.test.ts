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

test("dots map status to tailwind class", () => {
  assert.equal(modelProbeDotClass("alive"), "bg-emerald-500");
  assert.equal(modelProbeDotClass("dead"), "bg-red-500");
  assert.equal(modelProbeDotClass("unknown"), null);
});

test("groups are tiered alive→unknown→dead, alphabetical within tier", () => {
  const groups: ModelSelectGroup[] = [
    {
      key: "provider-1",
      label: "Provider 1",
      items: [
        item("z-p:m-zeta", "Zeta"),
        item("z-p:m-alpha", "Alpha"),
      ],
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
