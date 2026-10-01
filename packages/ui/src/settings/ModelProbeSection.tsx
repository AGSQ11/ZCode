import { useMemo, useState } from "react";
import { RefreshCwIcon, RadarIcon } from "lucide-react";
import type { ModelProbeEntry, ModelProbeStatus, ZCodeModelProbeConfig } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { Input } from "@/components/ui/input.js";
import { cn } from "@/components/lib/utils.js";
import { useModelProbeView } from "@/hooks/useModelProbeView.js";
import { modelProbeDotClass } from "@/lib/modelProbePresentation.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { SettingsSegmentedTabs } from "@/settings/SettingsSegmentedTabs.js";

type ModelProbeTab = ModelProbeStatus;

const TAB_ORDER: readonly ModelProbeTab[] = ["alive", "dead", "unknown"];
/** 协议 schema 允许 1-120s；UI 只暴露 5/10/20/30s 四档常用值。 */
const TIMEOUT_OPTIONS: readonly { label: string; value: number }[] = [
  { label: "5s", value: 5_000 },
  { label: "10s", value: 10_000 },
  { label: "20s", value: 20_000 },
  { label: "30s", value: 30_000 },
];
/** 协议 schema 上限 16；同时不超过本机 CPU 数。 */
const MAX_CONCURRENCY = Math.min(16, navigator.hardwareConcurrency || 4);
const MAX_RECHECK_MINUTES = 24 * 60;

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}

/** 草稿态：焦点中的数字输入不从轮询回填，blur/Enter 时才提交。 */
interface ConfigDraft {
  concurrency: string;
  recheckMinutes: string;
}

export function ModelProbeSection(props: { workspacePath: string; workspaceIdentity?: string }) {
  const { intl } = useZCodeIntl();
  const { view, loading, error, reload, probeAll, probing, updateConfig } = useModelProbeView(
    props.workspacePath,
    props.workspaceIdentity,
  );
  const [tab, setTab] = useState<ModelProbeTab>("alive");
  const [draft, setDraft] = useState<ConfigDraft | null>(null);

  const config = view?.config;

  const commitConfig = async (patch: Partial<ZCodeModelProbeConfig>): Promise<void> => {
    if (!config) return;
    const next: ZCodeModelProbeConfig = {
      probeTimeoutMs: config.probeTimeoutMs,
      concurrency: config.concurrency,
      deadRecheckIntervalMs: config.deadRecheckIntervalMs,
      ...patch,
    };
    try {
      await updateConfig(next);
    } catch {
      // 协议层 schema 拒绝非法值；轮询会把当前有效配置带回来。
    }
  };

  // 聚焦时从当前配置播种草稿；草稿存在期间轮询不回填这两个输入。
  const beginDraft = (): void => {
    setDraft(
      (current) =>
        current ?? {
          concurrency: String(config?.concurrency ?? ""),
          recheckMinutes: String(config ? Math.round(config.deadRecheckIntervalMs / 60_000) : ""),
        },
    );
  };

  const commitDraft = async (field: keyof ConfigDraft): Promise<void> => {
    if (!draft || !config) {
      setDraft(null);
      return;
    }
    if (field === "concurrency") {
      const parsed = Number.parseInt(draft.concurrency, 10);
      if (Number.isFinite(parsed)) {
        const clamped = Math.min(MAX_CONCURRENCY, Math.max(1, parsed));
        await commitConfig({ concurrency: clamped });
      }
    } else {
      const parsed = Number.parseInt(draft.recheckMinutes, 10);
      if (Number.isFinite(parsed)) {
        const clamped = Math.min(MAX_RECHECK_MINUTES, Math.max(1, parsed));
        await commitConfig({ deadRecheckIntervalMs: clamped * 60_000 });
      }
    }
    setDraft(null);
  };

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
          label={intl.formatMessage({ id: "settings.modelProbe.timeout.label" })}
          description={intl.formatMessage({ id: "settings.modelProbe.timeout.description" })}
          control={
            <SettingsSegmentedTabs
              items={TIMEOUT_OPTIONS.map((option) => ({
                value: String(option.value),
                label: option.label,
              }))}
              value={String(
                TIMEOUT_OPTIONS.find((option) => option.value === config?.probeTimeoutMs)?.value ??
                  config?.probeTimeoutMs ??
                  30_000,
              )}
              onValueChange={(value) => void commitConfig({ probeTimeoutMs: Number(value) })}
            />
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.modelProbe.concurrency.label" })}
          description={intl.formatMessage({
            id: "settings.modelProbe.concurrency.description",
          })}
          control={
            <Input
              type="number"
              min={1}
              max={MAX_CONCURRENCY}
              className="h-8 w-20 text-right tabular-nums"
              disabled={!config}
              value={draft ? draft.concurrency : config ? String(config.concurrency) : ""}
              onChange={(event) =>
                setDraft((current) => ({
                  concurrency: event.target.value,
                  recheckMinutes: current?.recheckMinutes ?? "",
                }))
              }
              onFocus={beginDraft}
              onBlur={() => void commitDraft("concurrency")}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                }
              }}
              aria-label={intl.formatMessage({ id: "settings.modelProbe.concurrency.label" })}
            />
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.modelProbe.deadRecheck.label" })}
          description={intl.formatMessage({ id: "settings.modelProbe.deadRecheck.description" })}
          control={
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                max={MAX_RECHECK_MINUTES}
                className="h-8 w-20 text-right tabular-nums"
                disabled={!config}
                value={
                  draft
                    ? draft.recheckMinutes
                    : config
                      ? String(Math.round(config.deadRecheckIntervalMs / 60_000))
                      : ""
                }
                onChange={(event) =>
                  setDraft((current) => ({
                    concurrency: current?.concurrency ?? "",
                    recheckMinutes: event.target.value,
                  }))
                }
                onFocus={beginDraft}
                onBlur={() => void commitDraft("recheckMinutes")}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.currentTarget.blur();
                  }
                }}
                aria-label={intl.formatMessage({ id: "settings.modelProbe.deadRecheck.label" })}
              />
              <span className="text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "settings.modelProbe.minutes" })}
              </span>
            </div>
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
