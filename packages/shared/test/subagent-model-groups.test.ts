import assert from "node:assert/strict";
import test from "node:test";
import {
  formatSubagentMarkdownGroup,
  parseSubagentMarkdownGroupId,
  parseSubagentMarkdownSelection,
} from "../src/subagent-markdown-selection.js";
import {
  parseBuiltInSubagentModelGroupOverrides,
  parsePluginSubagentModelGroupOverrides,
} from "../src/subagents-types.js";

test("subagent markdown group intent round-trips and excludes model selection", () => {
  const model = formatSubagentMarkdownGroup(" g-123 ");
  assert.equal(model, "group:g-123");
  assert.equal(parseSubagentMarkdownGroupId({ model }), "g-123");
  // 组意图不能再被 Picker 解析成单模型，否则同一字段会产生两个互相矛盾的意图。
  assert.equal(parseSubagentMarkdownSelection({ model }), undefined);
});

test("subagent markdown group parser ignores models, inherit and empty group ids", () => {
  assert.equal(parseSubagentMarkdownGroupId({ model: "openai/gpt-5" }), undefined);
  assert.equal(parseSubagentMarkdownGroupId({ model: "inherit" }), undefined);
  assert.equal(parseSubagentMarkdownGroupId({ model: "group:  " }), undefined);
  assert.equal(parseSubagentMarkdownGroupId({}), undefined);
  assert.deepEqual(parseSubagentMarkdownSelection({ model: "openai/gpt-5" }), {
    providerId: "openai",
    modelId: "gpt-5",
  });
});

test("group override readers keep only valid keys and non-empty ids", () => {
  assert.deepEqual(
    parseBuiltInSubagentModelGroupOverrides({
      Explore: " g1 ",
      "general-purpose": "",
      custom: "g2",
    }),
    { Explore: "g1" },
  );
  assert.deepEqual(
    parsePluginSubagentModelGroupOverrides({
      "plugin:a@m:x": "g1",
      "user:user:x": "g2",
      "plugin:b@m:y": 7,
    }),
    { "plugin:a@m:x": "g1" },
  );
  assert.deepEqual(parseBuiltInSubagentModelGroupOverrides(["g"]), {});
});
