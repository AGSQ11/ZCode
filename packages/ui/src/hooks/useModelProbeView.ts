import { useEffect, useState } from "react";
import type { ZCodeModelProbeConfig, ZCodeModelProbeView } from "@zcode/shared";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";

export interface ModelProbeViewRead {
  view: ZCodeModelProbeView | null;
  loading: boolean;
  error: Error | null;
  reload(): void;
  probeAll(config?: Partial<ZCodeModelProbeConfig>): Promise<void>;
}

export function useModelProbeView(
  workspacePath: string | null | undefined,
  workspaceIdentity?: string | null,
): ModelProbeViewRead {
  const resolution = useWorkspaceServicesResolution(workspacePath, null, workspaceIdentity);
  const service = resolution.services.modelProbeService;
  const hasTarget = Boolean(workspacePath?.trim() || workspaceIdentity?.trim());
  const [state, setState] = useState<{
    view: ZCodeModelProbeView | null;
    loading: boolean;
    error: Error | null;
  }>({ view: null, loading: hasTarget, error: null });
  const [reloadVersion, setReloadVersion] = useState(0);

  useEffect(() => {
    if (!service || !hasTarget) {
      setState({ view: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    let latestProbing = false;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    const read = (): void => {
      void service.getView().then(
        (view) => {
          if (!cancelled) {
            latestProbing = (view.probingProviderIds.length ?? 0) > 0;
            setState({ view, loading: false, error: null });
          }
        },
        (error: unknown) => {
          if (!cancelled) {
            setState({
              view: null,
              loading: false,
              error: error instanceof Error ? error : new Error(String(error)),
            });
          }
        },
      );
    };
    read();
    // 探测进行中短轮询刷新进度；静止状态慢轮询兜底（引擎无推送事件面）。
    const interval = () => (latestProbing ? 1000 : 5000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (): void => {
      timer = setTimeout(() => {
        read();
        schedule();
      }, interval());
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [service, hasTarget, reloadVersion]);

  return {
    ...state,
    reload: () => setReloadVersion((value) => value + 1),
    probeAll: (config?: Partial<ZCodeModelProbeConfig>) =>
      service?.probeAll(config) ?? Promise.resolve(),
  };
}
