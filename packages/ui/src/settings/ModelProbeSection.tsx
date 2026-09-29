import { useMemo, useState } from "react";
import { Activity, RefreshCwIcon } from "lucide-react";
import type { ZCodeModelProbeEntry, ModelProbeStatus } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useModelProbeView } from "@/hooks/useModelProbeView.js";
import { modelProbeDotClass } from "@/lib/modelProbePresentation.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

type ModelProbeTab = ModelProbeStatus;

const TAB_ORDER: readonly ModelProbeTab[] = ["alive", "dead", "unknown"];

export function ModelProbeSection(props: { workspacePath: string; workspaceIdentity?: string }) {
  const { intl } = useZCodeIntl();
  const { view, loading, error, reload, probeAll } = useModelProbeView(
    props.workspacePath,
    props.workspaceIdentity,
  );
  const [tab, setTab] = useState<ModelProbeTab>("alive");
  const [probing, setProbing] = useState(false);

  const rows = useMemo(() => {
    const entries = view?.entries ?? [];
    return entries.filter((entry) => entry.status === tab);
  }, [view, tab]);

  const handleProbeAll = async (): Promise<void> => {
    // probeAll 经 workspace services 解析的 modelProbeService 发起；
    // 引擎并发与超时由 Host 端 config 决定，UI 只传可选覆盖。
    setProbing(true);
    try {
      await probeAll();
      reload();
    } finally {
      setProbing(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4" />
          <h2 className="text-base font-semibold">
            {intl.formatMessage({ id: "settings.modelProbe.title" })}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void reload()} disabled={loading}>
            <RefreshCwIcon className="h-3.5 w-3.5" />
            {intl.formatMessage({ id: "settings.modelProbe.refresh" })}
          </Button>
          <Button size="sm" onClick={() => void handleProbeAll()} disabled={probing}>
            {probing
              ? intl.formatMessage({ id: "settings.modelProbe.probing" })
              : intl.formatMessage({ id: "settings.modelProbe.probeAll" })}
          </Button>
        </div>
      </div>
      {error ? (
        <p className="text-sm text-red-500">
          {intl.formatMessage({ id: "settings.modelProbe.readError" })}
        </p>
      ) : null}
      <div className="flex gap-1" role="tablist">
        {TAB_ORDER.map((candidate) => (
          <button
            key={candidate}
            role="tab"
            aria-selected={tab === candidate}
            onClick={() => setTab(candidate)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm",
              tab === candidate ? "bg-primary text-primary-foreground" : "hover:bg-muted",
            )}
          >
            {intl.formatMessage({ id: `settings.modelProbe.tab.${candidate}` })}
            <span className="ml-1.5 text-xs opacity-70">
              {(view?.entries ?? []).filter((entry) => entry.status === candidate).length}
            </span>
          </button>
        ))}
      </div>
      <div className="overflow-hidden rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase opacity-70">
            <tr>
              <th className="px-3 py-2">
                {intl.formatMessage({ id: "settings.modelProbe.column.model" })}
              </th>
              <th className="px-3 py-2">
                {intl.formatMessage({ id: "settings.modelProbe.column.provider" })}
              </th>
              <th className="px-3 py-2">
                {intl.formatMessage({ id: "settings.modelProbe.column.latency" })}
              </th>
              <th className="px-3 py-2">
                {intl.formatMessage({ id: "settings.modelProbe.column.lastResult" })}
              </th>
              <th className="px-3 py-2">
                {intl.formatMessage({ id: "settings.modelProbe.column.attempts" })}
              </th>
              <th className="px-3 py-2">
                {intl.formatMessage({ id: "settings.modelProbe.column.nextRetry" })}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center opacity-60">
                  {intl.formatMessage({ id: "settings.modelProbe.empty" })}
                </td>
              </tr>
            ) : (
              rows.map((entry) => <ModelProbeRow key={`${entry.providerId}:${entry.modelId}`} entry={entry} />)
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ModelProbeRow({ entry }: { entry: ZCodeModelProbeEntry }) {
  const { intl } = useZCodeIntl();
  const dot = modelProbeDotClass(entry.status);
  return (
    <tr className="border-t">
      <td className="px-3 py-2">
        <span className="mr-2 inline-flex items-center gap-1.5">
          {dot ? <span aria-hidden className={cn("inline-block h-2 w-2 rounded-full", dot)} /> : null}
        </span>
        {entry.modelId}
      </td>
      <td className="px-3 py-2 opacity-80">{entry.providerId}</td>
      <td className="px-3 py-2">{entry.latencyMs != null ? `${entry.latencyMs} ms` : "-"}</td>
      <td className="max-w-[280px] truncate px-3 py-2" title={entry.lastError}>
        {entry.status === "alive"
          ? intl.formatMessage({ id: "settings.modelProbe.result.ok" })
          : (entry.lastError ?? "-")}
      </td>
      <td className="px-3 py-2">{entry.attemptCount}</td>
      <td className="px-3 py-2">
        {entry.nextRetryAt != null ? new Date(entry.nextRetryAt).toLocaleTimeString() : "-"}
      </td>
    </tr>
  );
}
