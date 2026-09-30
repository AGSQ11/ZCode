import { useMemo, useState } from "react";
import { RefreshCwIcon, RadarIcon } from "lucide-react";
import type { ModelProbeEntry, ModelProbeStatus } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { cn } from "@/components/lib/utils.js";
import { useModelProbeView } from "@/hooks/useModelProbeView.js";
import { modelProbeDotClass } from "@/lib/modelProbePresentation.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { SettingsSegmentedTabs } from "@/settings/SettingsSegmentedTabs.js";

type ModelProbeTab = ModelProbeStatus;

const TAB_ORDER: readonly ModelProbeTab[] = ["alive", "dead", "unknown"];

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}

export function ModelProbeSection(props: { workspacePath: string; workspaceIdentity?: string }) {
  const { intl } = useZCodeIntl();
  const { view, loading, error, reload, probeAll, probing } = useModelProbeView(
    props.workspacePath,
    props.workspaceIdentity,
  );
  const [tab, setTab] = useState<ModelProbeTab>("alive");

  const entries = useMemo(() => view?.entries ?? [], [view]);
  const countByStatus = useMemo(() => {
    const counts: Record<ModelProbeTab, number> = { alive: 0, dead: 0, unknown: 0 };
    for (const entry of entries) counts[entry.status] += 1;
    return counts;
  }, [entries]);
  const rows = useMemo(() => entries.filter((entry) => entry.status === tab), [entries, tab]);

  return (
    <div className="space-y-6">
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.modelProbe.overview.label" })}
          description={intl.formatMessage({ id: "settings.modelProbe.overview.description" })}
          control={
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => reload()}
                disabled={loading}
                aria-label={intl.formatMessage({ id: "settings.modelProbe.refresh" })}
              >
                {loading ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <RefreshCwIcon className="size-3.5" />
                )}
              </Button>
              <Button size="sm" onClick={() => void probeAll()} disabled={probing}>
                {probing ? <Spinner className="size-3.5" /> : <RadarIcon className="size-3.5" />}
                {probing
                  ? intl.formatMessage({ id: "settings.modelProbe.probing" })
                  : intl.formatMessage({ id: "settings.modelProbe.probeAll" })}
              </Button>
            </div>
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.modelProbe.deadRecheck.label" })}
          description={intl.formatMessage({ id: "settings.modelProbe.deadRecheck.description" })}
          control={
            <span className="text-ui-base text-foreground-subtle">
              {view?.config.deadRecheckIntervalMs != null
                ? `${Math.round(view.config.deadRecheckIntervalMs / 60_000)} ${intl.formatMessage({ id: "settings.modelProbe.minutes" })}`
                : "-"}
            </span>
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.modelProbe.concurrency.label" })}
          description={intl.formatMessage({ id: "settings.modelProbe.concurrency.description" })}
          control={
            <span className="text-ui-base text-foreground-subtle">
              {view?.config.concurrency ?? "-"}
            </span>
          }
        />
      </SettingsGroupCard>

      {error ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProbe.readError" })}
        </div>
      ) : (
        <>
          <SettingsSegmentedTabs
            items={TAB_ORDER.map((candidate) => ({
              value: candidate,
              label: `${intl.formatMessage({ id: `settings.modelProbe.tab.${candidate}` })} · ${countByStatus[candidate]}`,
            }))}
            value={tab}
            onValueChange={setTab}
          />
          <SettingsGroupCard>
            {rows.length === 0 ? (
              <div className="px-4 py-10 text-center text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "settings.modelProbe.empty" })}
              </div>
            ) : (
              <table className="w-full text-ui-base">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-foreground-subtle">
                    <th className="px-4 py-2.5 font-medium">
                      {intl.formatMessage({ id: "settings.modelProbe.column.model" })}
                    </th>
                    <th className="px-4 py-2.5 font-medium">
                      {intl.formatMessage({ id: "settings.modelProbe.column.provider" })}
                    </th>
                    <th className="px-4 py-2.5 font-medium">
                      {intl.formatMessage({ id: "settings.modelProbe.column.latency" })}
                    </th>
                    <th className="px-4 py-2.5 font-medium">
                      {intl.formatMessage({ id: "settings.modelProbe.column.lastResult" })}
                    </th>
                    <th className="px-4 py-2.5 text-right font-medium">
                      {intl.formatMessage({ id: "settings.modelProbe.column.attempts" })}
                    </th>
                    <th className="px-4 py-2.5 text-right font-medium">
                      {intl.formatMessage({ id: "settings.modelProbe.column.nextRetry" })}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((entry) => (
                    <ModelProbeRow key={`${entry.providerId}:${entry.modelId}`} entry={entry} />
                  ))}
                </tbody>
              </table>
            )}
          </SettingsGroupCard>
        </>
      )}
    </div>
  );
}

function ModelProbeRow({ entry }: { entry: ModelProbeEntry }) {
  const { intl } = useZCodeIntl();
  const dot = modelProbeDotClass(entry.status);
  return (
    <tr className="border-b border-border/60 transition-colors last:border-b-0 hover:bg-hover/50">
      <td className="max-w-[280px] px-4 py-2.5">
        <span className="inline-flex items-center gap-2">
          {dot ? (
            <span aria-hidden className={cn("size-2 shrink-0 rounded-full", dot)} />
          ) : (
            <span aria-hidden className="size-2 shrink-0 rounded-full border border-border" />
          )}
          <span className="truncate font-medium text-foreground" title={entry.modelId}>
            {entry.modelId}
          </span>
        </span>
      </td>
      <td
        className="max-w-[200px] truncate px-4 py-2.5 text-foreground-subtle"
        title={entry.providerId}
      >
        {entry.providerId}
      </td>
      <td className="px-4 py-2.5 tabular-nums text-foreground-subtle">
        {entry.latencyMs != null ? `${(entry.latencyMs / 1000).toFixed(1)}s` : "-"}
      </td>
      <td className="max-w-[320px] truncate px-4 py-2.5" title={entry.lastError}>
        {entry.status === "alive" ? (
          <span className="text-foreground-subtle">
            {intl.formatMessage({ id: "settings.modelProbe.result.ok" })}
          </span>
        ) : (
          <span className="text-foreground-subtle">{entry.lastError ?? "-"}</span>
        )}
      </td>
      <td className="px-4 py-2.5 text-right tabular-nums text-foreground-subtle">
        {entry.attemptCount}
      </td>
      <td className="px-4 py-2.5 text-right tabular-nums text-foreground-subtle">
        {entry.nextRetryAt != null ? formatTime(entry.nextRetryAt) : "-"}
      </td>
    </tr>
  );
}
