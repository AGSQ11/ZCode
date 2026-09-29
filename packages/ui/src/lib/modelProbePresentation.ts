// 健康展示纯函数：圆点配色 + 组内 Alive → Unknown → Dead 分层排序。
// 分层只在 provider 组内部生效：全局跨组重排会破坏 provider 分组语义。
import type { ModelProbeStatus } from "@zcode/shared";
import type { ModelSelectGroup } from "@/lib/modelSelectionGroups.js";

export const MODEL_PROBE_TIER_ORDER: Record<ModelProbeStatus, number> = {
  alive: 0,
  unknown: 1,
  dead: 2,
};

export function modelProbeDotClass(status: ModelProbeStatus | undefined): string | null {
  if (status === "alive") return "bg-emerald-500";
  if (status === "dead") return "bg-red-500";
  return null;
}

export function sortModelProbeGroups<
  T extends { items: Array<{ key: string; value: string; name: string }> },
>(groups: readonly T[], statusMap: ReadonlyMap<string, ModelProbeStatus>): T[] {
  return groups.map((group) => ({
    ...group,
    items: [...group.items].sort((a, b) => {
      const tierA = MODEL_PROBE_TIER_ORDER[statusMap.get(a.key) ?? "unknown"];
      const tierB = MODEL_PROBE_TIER_ORDER[statusMap.get(b.key) ?? "unknown"];
      if (tierA !== tierB) return tierA - tierB;
      return a.name.localeCompare(b.name);
    }),
  }));
}

export type { ModelSelectGroup };
