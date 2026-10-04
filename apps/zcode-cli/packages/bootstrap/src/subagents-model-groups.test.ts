import { describe, expect, it } from "vitest";
import type { AgentProfile } from "@zcode/core";
import { applyPluginModelIntentOverride } from "./subagents.js";

const base: AgentProfile = {
  name: "plugin:p:agent",
  description: "d",
  source: "user",
  systemPrompt: "",
};
const modelA = { providerId: "p", modelId: "a" };

describe("applyPluginModelIntentOverride", () => {
  it("keeps the markdown intent when no override exists", () => {
    const profile = { ...base, modelGroupId: "md-group" };
    expect(applyPluginModelIntentOverride(profile, undefined, undefined)).toBe(profile);
  });

  it("replaces a markdown model with a group override", () => {
    const result = applyPluginModelIntentOverride({ ...base, modelSelection: modelA }, undefined, "g1");
    expect(result.modelGroupId).toBe("g1");
    expect(result.modelSelection).toBeUndefined();
  });

  it("replaces a markdown group with a model override", () => {
    const result = applyPluginModelIntentOverride({ ...base, modelGroupId: "md-group" }, modelA, undefined);
    expect(result.modelSelection).toEqual(modelA);
    expect(result.modelGroupId).toBeUndefined();
  });

  it("prefers the group when a hand-edited state holds both overrides", () => {
    const result = applyPluginModelIntentOverride(base, modelA, "g1");
    expect(result.modelGroupId).toBe("g1");
    expect(result.modelSelection).toBeUndefined();
  });
});
