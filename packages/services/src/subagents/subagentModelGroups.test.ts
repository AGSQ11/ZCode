import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSubagentMarkdown, serializeSubagentMarkdown } from "./subagentMarkdown.js";
import { createSubagentsService } from "./subagentsService.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function createService() {
  const homeDir = await mkdtemp(join(tmpdir(), "subagent-groups-"));
  cleanup.push(() => rm(homeDir, { recursive: true, force: true }));
  return { homeDir, service: createSubagentsService({ homeDir, isDesktopRuntime: true }) };
}

async function builtIn(service: ReturnType<typeof createSubagentsService>, name: string) {
  const result = await service.list({ workspacePath: "/nonexistent-workspace" });
  return result.agents.find((agent) => agent.name === name && agent.source === "built-in");
}

describe("subagent model group overrides", () => {
  const modelA = { providerId: "p", modelId: "a" };

  it("keeps built-in model and group overrides mutually exclusive", async () => {
    const { service } = await createService();

    await service.setBuiltInModelOverride({ agentName: "Explore", modelSelection: modelA });
    await service.setBuiltInModelOverride({ agentName: "Explore", modelGroupId: "g1" });
    let explore = await builtIn(service, "Explore");
    expect(explore?.modelGroupId).toBe("g1");
    expect(explore?.modelGroupIdOverride).toBe("g1");
    expect(explore?.modelSelection).toBeUndefined();

    await service.setBuiltInModelOverride({ agentName: "Explore", modelSelection: modelA });
    explore = await builtIn(service, "Explore");
    expect(explore?.modelSelection).toEqual(modelA);
    expect(explore?.modelGroupId).toBeUndefined();

    await service.setBuiltInModelOverride({ agentName: "Explore" });
    explore = await builtIn(service, "Explore");
    expect(explore?.modelSelection).toBeUndefined();
    expect(explore?.modelGroupId).toBeUndefined();
  });

  it("round-trips a group intent through custom agent markdown", () => {
    const content = serializeSubagentMarkdown({
      name: "grouped",
      description: "uses a group",
      systemPrompt: "body",
      modelGroupId: "g1",
      // 互斥：组意图存在时单模型不能写入 Markdown。
      modelSelection: modelA,
    });
    expect(content).toContain("group:g1");
    expect(content).not.toContain("thoughtLevel");
    const { agent } = parseSubagentMarkdown({ content, path: "/x/grouped.md", scope: "user" });
    expect(agent?.modelGroupId).toBe("g1");
    expect(agent?.modelSelection).toBeUndefined();
  });
});
