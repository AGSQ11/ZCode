# Model Probe - Native Health Monitoring for ZCode

Date: 2026-09-29
Status: Approved design (pending implementation plan)
Origin: Port of [AGSQ11/dsh-model-probe](https://github.com/AGSQ11/dsh-model-probe) as a native ZCode feature.

## 1. Goal

ZCode maintains a persistent **Alive / Dead** health ledger for every enabled model in the provider registry:

- The model selection dialog annotates every model with a health dot (green Alive, red Dead, no dot Unknown) and orders groups health-first: **Alive → Unknown → Dead**, alphabetical within each tier.
- **Settings → Model Probe** shows the full ledger in Alive / Dead / Unknown tabs with probe diagnostics, a manual "Probe all" action, and configurable timeout / concurrency / recheck interval.
- Health is maintained automatically: normal chat failures trigger verification retries, Dead models are re-probed every 30 minutes, and any successful real request revives a Dead model immediately.

Non-goals: no strict filtering of Dead models out of the picker (they remain selectable, per user decision); no replay of failed user requests for verification.

## 2. Decisions (user-confirmed)

| Decision            | Choice                                                                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Alive determination | Hybrid: existing connectivity test (real 1-token call) as cheap gate, then DSH-style minimal probe (`"Reply with exactly OK."`, maxTokens=8) as authoritative verdict |
| Picker behavior     | DSH parity: dots + health-first ordering; no filtering                                                                                                                |
| Automation          | Full DSH parity: observe normal chat errors, 2 health retries before Dead, 30-min Dead recheck, revive on success                                                     |
| Scope               | All enabled providers/models in the Host's Environment Registry; ledger per Host, persisted locally                                                                   |
| Architecture        | Runtime-owned probe engine (Approach A)                                                                                                                               |

## 3. Architecture and ownership

One writer per state; the health ledger's single owner is the CLI runtime, where model errors and successes originate.

```
┌─ UI (packages/ui) ──────────────────────────────────────────────┐
│  ModelConfigSelect ── useModelSelectionView + useModelProbeStatus│
│  Settings > Model Probe section ── useModelProbeView             │
└──────────────┬───────────────────────────────────────────────────┘
               │ IModelProbeService (new descriptor, ServiceChannels.ModelProbe)
┌─ services (packages/services) ──────────────────────────────────┐
│  modelProbeService: facade over zcodeAgent protocol calls        │
│  (mirrors testModelConnectivity wiring in zcodeAgentService)     │
└──────────────┬───────────────────────────────────────────────────┘
               │ zcode protocol (stdio): provider/modelProbe* methods
┌─ CLI runtime (apps/zcode-cli/packages/core) ─── OWNER OF HEALTH STATE ──┐
│  ModelProbeRuntime: ledger, probe executor, scheduler, observers        │
│  inputs: session events (model_error / model_complete) + probe requests │
│  persistence: session-store migration (probe ledger), bounded 500       │
└──────────────────────────────────────────────────────────────────────────┘
```

- UI and services are read-only consumers plus command issuers. They never write ledger state.
- The scheduler runs in the runtime process. UIs (Settings page, model picker) do not need to stay open.
- Works identically on desktop and web because the engine lives in the runtime shared by both.

## 4. Probe engine (CLI core)

New `ModelProbeRuntime` beside the model execution methods (`apps/zcode-cli/packages/core/src/runtime/methods/`).

### Ledger

- Key: `providerId + modelId`.
- Entry: `{ status: "alive" | "dead" | "unknown", lastCheckedAt, latencyMs, ttftMs, lastError, attemptCount, nextRetryAt, history: last 500 outcomes }`.
- Persisted via a new session-store migration (frozen SQL, checksummed - same pattern as `0020-provider-model-selection.ts`).
- Entries for models no longer in the registry are pruned on registry change.
- On startup, statuses load from the ledger; Dead models with overdue `nextRetryAt` are re-probed immediately.

### Probe executor (hybrid)

1. Stage 1: existing `testModelConnectivity` executor (real call: system `"You are ZCode connectivity probe."`, user `"hi"`, maxOutputTokens=1) - cheap gate.
2. Stage 2 (only if stage 1 passes): DSH-style probe - user message `"Reply with exactly OK."`, maxTokens=8, through the same `createRuntimeModel` path with the lowest reasoning level. Measures latency and time-to-first-token.
3. Per-probe `AbortSignal` timeout, default 30 s, configurable. Bounded concurrency, default 4, for "Probe all".
4. A manual probe has up to 3 attempts (initial + 2 retries). Dead only if all 3 fail.

### Failure observation

- The runtime already emits `model_error` and `model_complete` session events; the probe runtime subscribes on its own event bus - no protocol hop.
- Terminal `model_error` for a model → that failure counts as the initial failure → health retry #1 → health retry #2 (minimal probe) → Dead only if both fail and no success revived the model in between.
- User-initiated cancellation/abort is **not** treated as model death (filtered via existing cancellation paths).
- Any `model_complete` success immediately revives a previously Dead model.

### Scheduler

- Interval timer in the runtime process: each Dead model gets one background probe every 30 min (configurable). Success → Alive immediately; failure → stays Dead, next check in 30 min.
- Timer is disposed with the runtime; overdue checks resume on the next start.

## 5. Protocol, services, hooks

- `packages/shared/src/zcode-protocol/index.ts`: new methods `provider/modelProbeGetView`, `provider/modelProbeProbeAll`, `provider/modelProbeUpdateConfig`; strict zod schemas (`zcodeModelProbeEntrySchema` etc.), runtime-validated, mirroring the connectivity schemas.
- `packages/services`: new `IModelProbeService` (`getView`, `probeAll`, `updateConfig`, `onDidChange`) in `model-probe/modelProbeService.ts`, wired through `zcodeAgentService` like `testModelConnectivity` (zcodeAgentService.ts:4412).
- `packages/ui/src/hooks/useModelProbeStatus.ts`: subscribes to the service; returns a `Map<"providerId:modelId", status>` for the picker.
- `packages/ui/src/hooks/useModelProbeView.ts`: full ledger view for the Settings page.

## 6. Model picker integration

- `ModelConfigSelect.tsx` + `lib/modelSelectionGroups.ts`: status dot per model row (green / red / none); groups re-ordered globally **Alive → Unknown → Dead**, alphabetical A→Z within tier.
- Dead models remain visible and selectable; the health view is additive to the existing selection flow.
- Ordering and dot logic are pure functions with table-driven tests.
- No Zustand store writes, no broadcast fields - local composition of the two hooks only.

## 7. Settings → Model Probe

- New section id `modelProbe` in `settingsPageConfig.ts`, group `basics`, placed after `modelProvider`; icon from `lucide-react` (e.g. `Activity`).
- New `ModelProbeSection.tsx`: Alive / Dead / Unknown tabs; per row: provider, model, latency, TTFT, last result/error, attempt count, next retry time; "Probe all" button; timeout / concurrency / recheck-interval inputs.
- i18n keys added to both `en-US.ts` and `zh-CN.ts`.
- Follows `DESIGN.md`; reuses existing settings section components and tokens.

## 8. Error and edge behavior

- Invalid probe config values are rejected by the zod schema at the protocol boundary; not silently clamped.
- Transient probe IO failures do not overwrite a healthy ledger entry with stale-error data; retries follow the health policy.
- Registry change events trigger pruning and view refresh, reusing the existing `onDidChange` pattern of the provider facades.
- Remote workspaces use the same Host-scoped engine; `workspaceIdentity` is threaded per existing conventions.

## 9. State and event order

```
normal chat:  model_error ──▶ retry#1 probe ──fail──▶ retry#2 probe ──fail──▶ Dead(+30min timer)
                  │                                             ▲
                  └──aborted (user cancel)──▶ ignored           │model_complete success
                                                                └──▶ Alive (timer cancelled)
manual probe:  stage1 connectivity ──pass──▶ stage2 minimal probe ──pass──▶ Alive
                                     └──fail──▶ retry (≤2) ──all fail──▶ Dead
scheduled:     Dead ──30 min──▶ probe ──pass──▶ Alive │ ──fail──▶ Dead(nextRetryAt +30min)
```

Owner of every transition: `ModelProbeRuntime`. UI observes via `onDidChange` only.

## 10. Testing

- Unit: health-policy state machine (retry counts, revive-on-success, abort-not-death), ledger pruning, scheduler catch-up on restart, picker ordering/dot pure functions.
- Integration: probe executor against the runtime model path with a mocked model; protocol schema round-trip.
- E2E: Settings section renders tabs and accepts "Probe all"; picker shows dots and tiered ordering.
- Gates: `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`, `pnpm verify:pre-push`.

## 11. Cost note

Stage 2 of the hybrid probe is a real completion per model. "Probe all" over a large registry multiplies token spend; timeout and concurrency are configurable, and stage 1 (1-token gate) skips broken setups cheaply.
