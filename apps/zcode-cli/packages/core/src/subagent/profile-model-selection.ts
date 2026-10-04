import {
  parseSubagentMarkdownGroupId,
  parseSubagentMarkdownSelection,
  type ModelSelection,
} from "@zcode/shared";

/** Host/Agent 共用正式 Markdown codec；Provider 迁移必须先在用户存储边界完成。 */
export function resolveProfileModelSelection(
  frontmatter: Record<string, unknown>,
): ModelSelection | undefined {
  return parseSubagentMarkdownSelection(frontmatter);
}

/** `model: group:<id>` 的模型组意图；与 resolveProfileModelSelection 互斥。 */
export function resolveProfileModelGroupId(
  frontmatter: Record<string, unknown>,
): string | undefined {
  return parseSubagentMarkdownGroupId(frontmatter);
}
