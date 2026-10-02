/* oxlint-disable eslint(no-control-regex) */
import { z } from "zod";
import { modelSelectionSchema, type ModelSelection } from "./model-selection.js";

// ============================================================================
// Execution Target Schemas (Section 3 of Specification)
// ============================================================================

export const modelExecutionTargetSchema = z
  .object({
    kind: z.literal("model"),
    selection: modelSelectionSchema,
  })
  .strict();

export const groupExecutionTargetSchema = z
  .object({
    kind: z.literal("group"),
    groupId: z.string().trim().min(1),
  })
  .strict();

export const executionTargetSchema = z.discriminatedUnion("kind", [
  modelExecutionTargetSchema,
  groupExecutionTargetSchema,
]);

export type ExecutionTarget = z.infer<typeof executionTargetSchema>;
export type ModelExecutionTarget = z.infer<typeof modelExecutionTargetSchema>;
export type GroupExecutionTarget = z.infer<typeof groupExecutionTargetSchema>;

// Helper for migrating legacy ModelSelection to ExecutionTarget
export function migrateModelSelectionToExecutionTarget(
  selection: ModelSelection | undefined | null,
): ExecutionTarget | undefined {
  if (!selection) return undefined;
  return {
    kind: "model",
    selection,
  };
}

// ============================================================================
// Model Group Configuration Schemas (Section 4 of Specification)
// ============================================================================

export const WORKLOAD_LEVELS = ["light", "medium", "heavy", "custom"] as const;
export const workloadLevelSchema = z.enum(WORKLOAD_LEVELS);
export type WorkloadLevel = (typeof WORKLOAD_LEVELS)[number];

export const ROUTING_STRATEGIES = [
  "round_robin",
  "balanced",
  "least_used",
  "priority",
] as const;
export const routingStrategySchema = z.enum(ROUTING_STRATEGIES);
export type RoutingStrategy = (typeof ROUTING_STRATEGIES)[number];

export const GROUP_AFFINITIES = ["turn", "request"] as const;
export const groupAffinitySchema = z.enum(GROUP_AFFINITIES);
export type GroupAffinity = (typeof GROUP_AFFINITIES)[number];

export const modelGroupMemberSchema = z
  .object({
    id: z.string().trim().min(1), // generated UUID
    selection: modelSelectionSchema,
    enabled: z.boolean(),
    weight: z.number().int().min(1).max(100),
    maxInFlight: z.number().int().min(1).max(64).nullable(),
  })
  .strict();

export type ModelGroupMember = z.infer<typeof modelGroupMemberSchema>;

export const modelGroupFailoverSchema = z
  .object({
    enabled: z.boolean(),
    maxMemberAttempts: z.number().int().min(1).max(32),
    requestDeadlineMs: z.number().int().min(1000).max(1800000),
  })
  .strict();

export type ModelGroupFailover = z.infer<typeof modelGroupFailoverSchema>;

export function normalizeGroupName(name: string): string {
  return name.trim().normalize("NFC");
}

export function validateGroupName(name: string): boolean {
  const normalized = normalizeGroupName(name);
  if (normalized.length === 0 || normalized.length > 80) return false;
  // Reject control characters (0x00 to 0x1F and 0x7F to 0x9F)
  return !/[\u0000-\u001F\u007F-\u009F]/u.test(normalized);
}

export const modelGroupSchema = z
  .object({
    id: z.string().trim().min(1),
    revision: z.number().int().positive(),
    name: z
      .string()
      .refine(validateGroupName, "Group name must be 1..80 NFC characters with no control characters"),
    description: z
      .string()
      .max(500, "Description cannot exceed 500 characters")
      .refine(
        (val) => !/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/u.test(val),
        "Description cannot contain control characters except newlines",
      ),
    enabled: z.boolean(),
    workloadLevel: workloadLevelSchema,
    strategy: routingStrategySchema,
    affinity: groupAffinitySchema,
    members: z.array(modelGroupMemberSchema).max(32, "Maximum 32 members per group"),
    failover: modelGroupFailoverSchema,
  })
  .strict()
  .superRefine((group, ctx) => {
    // An enabled group must contain at least one enabled member
    if (group.enabled) {
      const hasEnabledMember = group.members.some((m) => m.enabled);
      if (!hasEnabledMember) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "An enabled group must contain at least one enabled member",
          path: ["members"],
        });
      }
    }
    // Reject duplicate (providerId, modelId, reasoningLevel) tuples within group
    const seen = new Set<string>();
    for (let i = 0; i < group.members.length; i++) {
      const m = group.members[i];
      if (!m) continue;
      const key = `${m.selection.providerId}\u0000${m.selection.modelId}\u0000${m.selection.options?.reasoningLevel ?? ""}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate member selection tuple: (${m.selection.providerId}, ${m.selection.modelId}, ${m.selection.options?.reasoningLevel ?? "none"})`,
          path: ["members", i],
        });
      }
      seen.add(key);
    }
  });

export type ModelGroup = z.infer<typeof modelGroupSchema>;

export const CURRENT_MODEL_GROUPS_SCHEMA_VERSION = 1 as const;

export const modelGroupsConfigSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_MODEL_GROUPS_SCHEMA_VERSION),
    revision: z.number().int().nonnegative(),
    groups: z.array(modelGroupSchema).max(100, "Maximum 100 groups"),
    defaultTarget: executionTargetSchema.optional(),
    workloadDefaults: z
      .object({
        light: z.string().trim().min(1).optional(),
        medium: z.string().trim().min(1).optional(),
        heavy: z.string().trim().min(1).optional(),
        custom: z.string().trim().min(1).optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    // Unique group names (case-insensitive after NFC normalization)
    const nameMap = new Map<string, string>();
    for (let i = 0; i < cfg.groups.length; i++) {
      const g = cfg.groups[i];
      if (!g) continue;
      const normalizedName = normalizeGroupName(g.name).toLowerCase();
      if (nameMap.has(normalizedName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate group name: "${g.name}" matches existing group "${nameMap.get(normalizedName)}"`,
          path: ["groups", i, "name"],
        });
      } else {
        nameMap.set(normalizedName, g.name);
      }
    }

    // Default target group reference validation
    if (cfg.defaultTarget && cfg.defaultTarget.kind === "group") {
      const targetGroupId = cfg.defaultTarget.groupId;
      const targetGroup = cfg.groups.find((g) => g.id === targetGroupId);
      if (!targetGroup) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `defaultTarget references non-existent groupId: ${targetGroupId}`,
          path: ["defaultTarget", "groupId"],
        });
      }
    }

    // Workload defaults validation: must point to a group of the same workload level
    const groupById = new Map(cfg.groups.map((g) => [g.id, g]));
    for (const level of WORKLOAD_LEVELS) {
      const groupId = cfg.workloadDefaults[level];
      if (groupId) {
        const group = groupById.get(groupId);
        if (!group) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `workloadDefaults.${level} references non-existent groupId: ${groupId}`,
            path: ["workloadDefaults", level],
          });
        } else if (group.workloadLevel !== level) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `workloadDefaults.${level} references group with mismatched workloadLevel: ${group.workloadLevel}`,
            path: ["workloadDefaults", level],
          });
        }
      }
    }
  });

export type ModelGroupsConfig = z.infer<typeof modelGroupsConfigSchema>;

export const DEFAULT_MODEL_GROUP_MEMBER: Omit<ModelGroupMember, "id" | "selection"> = {
  enabled: true,
  weight: 1,
  maxInFlight: null,
};

export const DEFAULT_MODEL_GROUP: Omit<ModelGroup, "id" | "revision" | "name" | "members"> = {
  description: "",
  enabled: true,
  workloadLevel: "custom",
  strategy: "round_robin",
  affinity: "turn",
  failover: {
    enabled: true,
    maxMemberAttempts: 32,
    requestDeadlineMs: 600000,
  },
};

export const DEFAULT_MODEL_GROUPS_CONFIG: ModelGroupsConfig = {
  schemaVersion: CURRENT_MODEL_GROUPS_SCHEMA_VERSION,
  revision: 0,
  groups: [],
  workloadDefaults: {},
};
