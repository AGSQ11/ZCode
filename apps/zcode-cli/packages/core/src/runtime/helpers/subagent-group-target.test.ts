import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_GROUP,
  DEFAULT_MODEL_GROUP_MEMBER,
  DEFAULT_MODEL_GROUPS_CONFIG,
  type ModelGroupsConfig,
} from "@zcode/shared/model-group-types";
import { resolveSubagentGroupIntent, resolveSubagentGroupLaunch } from "./subagent-group-target.js";
import { normalizeAgentProfiles, parseAgentProfileFromMarkdown } from "../../subagent/profile.js";

const modelA = { providerId: "p", modelId: "a" };
const modelB = { providerId: "p", modelId: "b" };

function groupsConfig(overrides: { enabled?: boolean; memberEnabled?: boolean } = {}): ModelGroupsConfig {
  return {
    ...DEFAULT_MODEL_GROUPS_CONFIG,
    groups: [
      {
        ...DEFAULT_MODEL_GROUP,
        id: "g1",
        revision: 1,
        name: "Group 1",
        enabled: overrides.enabled ?? true,
        members: [
          { ...DEFAULT_MODEL_GROUP_MEMBER, id: "m-a", selection: modelA, enabled: overrides.memberEnabled ?? true },
          { ...DEFAULT_MODEL_GROUP_MEMBER, id: "m-b", selection: modelB, enabled: true },
        ],
      },
    ],
  };
}

describe("resolveSubagentGroupIntent", () => {
  const parentGroup = { kind: "group" as const, groupId: "parent-g" };

  it("inherits the parent group when the profile has no model intent", () => {
    // 回归：父会话为组时 sessionModelSelection 为空，旧路径以 selection-missing 拒绝启动。
    expect(resolveSubagentGroupIntent({ parentTarget: parentGroup })).toBe("parent-g");
  });

  it("prefers the profile group over the parent target", () => {
    expect(resolveSubagentGroupIntent({ profileGroupId: "g1", parentTarget: parentGroup })).toBe("g1");
    expect(
      resolveSubagentGroupIntent({
        profileGroupId: "g1",
        parentTarget: { kind: "model", selection: modelA },
      }),
    ).toBe("g1");
  });

  it("keeps explicit single-model intents on the model path", () => {
    expect(resolveSubagentGroupIntent({ profileSelection: modelA, parentTarget: parentGroup })).toBeUndefined();
    expect(
      resolveSubagentGroupIntent({ overrideSelection: modelA, profileGroupId: "g1", parentTarget: parentGroup }),
    ).toBeUndefined();
    expect(resolveSubagentGroupIntent({ parentTarget: { kind: "model", selection: modelA } })).toBeUndefined();
  });
});

describe("resolveSubagentGroupLaunch", () => {
  it("uses the parent's routed member as the representative when it belongs to the group", () => {
    const launch = resolveSubagentGroupLaunch({
      groupId: "g1",
      groupsConfig: groupsConfig(),
      routerAvailable: true,
      activeParentSelection: modelB,
    });
    expect(launch.group.id).toBe("g1");
    expect(launch.representativeSelection).toEqual(modelB);
  });

  it("falls back to the first enabled member", () => {
    expect(
      resolveSubagentGroupLaunch({ groupId: "g1", groupsConfig: groupsConfig(), routerAvailable: true })
        .representativeSelection,
    ).toEqual(modelA);
    expect(
      resolveSubagentGroupLaunch({
        groupId: "g1",
        groupsConfig: groupsConfig({ memberEnabled: false }),
        routerAvailable: true,
        activeParentSelection: modelA,
      }).representativeSelection,
    ).toEqual(modelB);
  });

  it.each([
    ["missing group", { groupId: "nope", groupsConfig: groupsConfig(), routerAvailable: true }],
    ["disabled group", { groupId: "g1", groupsConfig: groupsConfig({ enabled: false }), routerAvailable: true }],
    ["no router", { groupId: "g1", groupsConfig: groupsConfig(), routerAvailable: false }],
    ["no config", { groupId: "g1", groupsConfig: undefined, routerAvailable: true }],
  ])("rejects %s without falling back to another model", (_label, input) => {
    expect(() => resolveSubagentGroupLaunch(input)).toThrow(/reason=group-unavailable/);
  });
});

describe("subagent profiles with model groups", () => {
  it("parses `model: group:<id>` as a group intent with no single model", () => {
    const { profile } = parseAgentProfileFromMarkdown({
      content: "---\nname: grouped\ndescription: uses a group\nmodel: group:g1\n---\nbody",
      source: "user",
    });
    expect(profile?.modelGroupId).toBe("g1");
    expect(profile?.modelSelection).toBeUndefined();
  });

  it("applies built-in group overrides with priority over model overrides", () => {
    const profiles = normalizeAgentProfiles([], {
      builtInModelSelectionOverrides: { Explore: modelA, "general-purpose": modelB },
      builtInModelGroupOverrides: { Explore: "g1" },
    });
    const explore = profiles.find((profile) => profile.name === "Explore");
    const general = profiles.find((profile) => profile.name === "general-purpose");
    expect(explore?.modelGroupId).toBe("g1");
    expect(explore?.modelSelection).toBeUndefined();
    expect(general?.modelSelection).toEqual(modelB);
    expect(general?.modelGroupId).toBeUndefined();
  });
});
