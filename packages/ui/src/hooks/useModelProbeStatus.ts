import { useEffect, useMemo, useState } from "react";
import type { ModelProbeStatus, ZCodeModelProbeView } from "@zcode/shared";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";

export type ModelProbeStatusMap = Map<string, ModelProbeStatus>;

export const modelProbeStatusKey = (providerId: string, modelId: string): string =>
  `${providerId}:${modelId}`;

/**
 * 订阅当前 workspace 目标 Host 的健康账本视图，返回 providerId:modelId → status。
 * 视图带 revision；轮询重读只发生在 Host View 读取失败后的有界重试，事件面未接入前
 * 以 revision 变化触发重读（引擎每次状态迁移都会 revision+1）。
 */
export function useModelProbeStatus(
  workspacePath: string | null | undefined,
  remoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): { statusMap: ModelProbeStatusMap; revision: number } {
  const resolution = useWorkspaceServicesResolution(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
  );
  const service = resolution.services.modelProbeService;
  const [view, setView] = useState<ZCodeModelProbeView | null>(null);
  const hasTarget = Boolean(workspacePath?.trim() || workspaceIdentity?.trim());

  useEffect(() => {
    if (!service || !hasTarget) {
      setView(null);
      return;
    }
    let cancelled = false;
    let latestRevision = -1;
    const read = (): void => {
      void service.getView().then(
        (candidate) => {
          if (cancelled || candidate.revision < latestRevision) return;
          latestRevision = candidate.revision;
          setView(candidate);
        },
        (error: unknown) => {
          logger.warn("[model-probe] Host View 读取失败", { error });
        },
      );
    };
    read();
    // 引擎 revision 每次 commit 递增；尚未有推送事件面时按 revision 轮询（1s 退避上限）。
    const timer = setInterval(read, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [service, hasTarget]);

  const statusMap = useMemo<ModelProbeStatusMap>(() => {
    const map: ModelProbeStatusMap = new Map();
    if (!view) return map;
    for (const entry of view.entries) {
      map.set(modelProbeStatusKey(entry.providerId, entry.modelId), entry.status);
    }
    return map;
  }, [view]);

  return { statusMap, revision: view?.revision ?? -1 };
}
