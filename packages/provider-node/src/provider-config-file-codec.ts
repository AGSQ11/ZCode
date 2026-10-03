import { z } from "zod";
import { modelSelectionSchema } from "@zcode/shared/model-selection";
import {
  executionTargetSchema,
  modelGroupsConfigSchema,
  migrateModelSelectionToExecutionTarget,
} from "@zcode/shared/model-group-types";
import { completeModelConfigDataSchema, modelConfigDataSchema } from "@zcode/shared/model-config";
import {
  parsePersonalModelConfigRules,
  parsePersonalProviderConfigMap,
  extractManualModelConfig,
  manualModelConfigSchema,
  type ProviderConfigLayerUpdate,
} from "@zcode/provider";

const CURRENT_SCHEMA_VERSION = 1 as const;

type ProviderConfigFileMigration = (input: unknown) => unknown;

const migrations: ReadonlyMap<number, ProviderConfigFileMigration> = new Map();

const storedProviderConfigSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    config: z
      .object({
        providerOrder: z.array(z.string().min(1)).optional(),
        providerConfigRules: z.unknown(),
        modelConfigRules: z.unknown(),
        defaultModelSelection: modelSelectionSchema.optional(),
        defaultTarget: executionTargetSchema.optional(),
        modelGroups: modelGroupsConfigSchema.optional(),
      })
      .strict(),
  })
  .strict();

export class UnsupportedProviderConfigVersionError extends Error {
  readonly version: number | null;

  constructor(message: string, version: number | null) {
    super(message);
    this.name = "UnsupportedProviderConfigVersionError";
    this.version = version;
  }
}

export function decodeProviderConfigFile(input: unknown): ProviderConfigLayerUpdate {
  let candidate = input;
  let version = readSchemaVersion(candidate);
  if (version === null) {
    throw new UnsupportedProviderConfigVersionError("Provider Config 缺少 schemaVersion", null);
  }
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new UnsupportedProviderConfigVersionError(
      `Provider Config schemaVersion ${version} 高于当前支持的 ${CURRENT_SCHEMA_VERSION}`,
      version,
    );
  }
  while (version < CURRENT_SCHEMA_VERSION) {
    const migration = migrations.get(version);
    if (!migration) {
      throw new UnsupportedProviderConfigVersionError(
        `缺少 Provider Config schemaVersion ${version} 到 ${version + 1} 的迁移器`,
        version,
      );
    }
    candidate = migration(candidate);
    const nextVersion = requireSchemaVersion(candidate);
    if (nextVersion !== version + 1) {
      throw new Error(
        `Provider Config 迁移器必须从 schemaVersion ${version} 迁移到 ${version + 1}`,
      );
    }
    version = nextVersion;
  }
  const parsed = storedProviderConfigSchema.parse(candidate);
  const defaultTarget =
    parsed.config.defaultTarget ??
    migrateModelSelectionToExecutionTarget(parsed.config.defaultModelSelection);
  return Object.freeze({
    providers: parsePersonalProviderConfigMap(parsed.config.providerConfigRules),
    models: parsePersonalModelConfigRules(
      normalizeLegacyManualRules(parsed.config.modelConfigRules),
    ),
    providerOrder: parsed.config.providerOrder,
    ...(parsed.config.defaultModelSelection === undefined
      ? {}
      : { defaultModelSelection: parsed.config.defaultModelSelection }),
    ...(defaultTarget === undefined ? {} : { defaultTarget }),
    ...(parsed.config.modelGroups === undefined
      ? {}
      : { modelGroups: parsed.config.modelGroups }),
  });
}

const legacyCompleteManualSchema = completeModelConfigDataSchema.extend({
  enabled: modelConfigDataSchema.shape.enabled,
});

// 旧编辑器曾把 MFJS 当作手动必填项；隐藏后仅在文件边界识别旧合法形状，
// 提取现行可编辑字段，避免整个个人配置加载失败或继续冻结系统能力。
const legacyEditableManualSchema = manualModelConfigSchema.extend({
  properties: manualModelConfigSchema.shape.properties.extend({
    requiresMfjsToolSchema:
      completeModelConfigDataSchema.shape.properties.shape.requiresMfjsToolSchema,
  }),
});

function normalizeLegacyManualRules(input: unknown): unknown {
  if (!isRecord(input) || !Array.isArray(input.manualProviderModelRules)) return input;
  return {
    ...input,
    manualProviderModelRules: input.manualProviderModelRules.map((rule: unknown) => {
      if (!isRecord(rule) || manualModelConfigSchema.safeParse(rule.config).success) return rule;
      // 仅识别旧完整形状，不把未知/损坏配置通过删字段伪装成成功；公共写入入口仍严格拒绝隐藏叶子。
      const legacy = z
        .union([legacyCompleteManualSchema, legacyEditableManualSchema])
        .safeParse(rule.config);
      return legacy.success ? { ...rule, config: extractManualModelConfig(legacy.data) } : rule;
    }),
  };
}

export function encodeProviderConfigFile(update: ProviderConfigLayerUpdate) {
  // defaultTarget 是权威执行目标；legacy defaultModelSelection 只作向后兼容投影。
  // 让显式 defaultModelSelection 优先会让 target=model B 与 legacy=model A 共存
  // 于同一文件，旧读者按 A 路由、新读者按 B 路由（悬空一致性）。统一从
  // defaultTarget 推导 legacy 值，只有 target 缺失时才保留旧字段原值。
  const legacyDefault =
    update.defaultTarget?.kind === "model"
      ? update.defaultTarget.selection
      : update.defaultModelSelection;

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    config: {
      ...(update.providerOrder === undefined ? {} : { providerOrder: update.providerOrder }),
      providerConfigRules: { providerRules: update.providers.toJSON() },
      modelConfigRules: update.models.toPersonalJSON(),
      ...(legacyDefault === undefined ? {} : { defaultModelSelection: legacyDefault }),
      ...(update.defaultTarget === undefined ? {} : { defaultTarget: update.defaultTarget }),
      ...(update.modelGroups === undefined ? {} : { modelGroups: update.modelGroups }),
    },
  };
}

function readSchemaVersion(input: unknown): number | null {
  if (!isRecord(input) || !("schemaVersion" in input)) return null;
  const version = input.schemaVersion;
  if (!Number.isInteger(version) || (version as number) < 0) {
    throw new UnsupportedProviderConfigVersionError(
      "Provider Config schemaVersion 必须是非负整数",
      null,
    );
  }
  return version as number;
}

function requireSchemaVersion(input: unknown): number {
  const version = readSchemaVersion(input);
  if (version === null) {
    throw new UnsupportedProviderConfigVersionError(
      "Provider Config 迁移器必须产生版本化文件",
      null,
    );
  }
  return version;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
