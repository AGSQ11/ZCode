# ZCode v3.14.3-probemodels

Native **Model Probe** - persistent Alive/Dead health monitoring for every configured model, ported from the [dsh-model-probe](https://github.com/AGSQ11/dsh-model-probe) plugin and built into ZCode as a first-class feature.

## What's new

**Settings → Model Probe.** A new settings section shows every enabled model in three tabs - Alive / Dead / Unknown - with per-model latency, last result, attempt count, and next-retry time. A **Probe all** button probes the whole registry with configurable timeout and concurrency.

**Health in the model picker.** The model selection dialog annotates every model with a health dot (green = alive, red = dead, no dot = not yet probed) and orders groups health-first: Alive → Unknown → Dead.

**Automatic health tracking.** Normal chat traffic feeds the ledger: a terminal model error counts as a failure, followed by health retries before the model is declared dead; a dead model is re-probed every 30 minutes and revives immediately on any successful request. The ledger persists across restarts.

## How probing works

Hybrid probe per model: a real 1-token connectivity call as a cheap gate, then a DSH-style minimal completion ("Reply with exactly OK.", maxTokens=8) as the authoritative verdict. Failures are retried up to 3 times before a model is marked dead; explicit user cancellation is never treated as death. The engine owns the ledger in the Host process; UI and services are read-only consumers.

## This release fixes the end-to-end probe pipeline

The initial port shipped with the feature present but non-functional - clicking **Probe all** appeared to do nothing. This release resolves five compounding root causes, all verified against the running desktop app:

- **Account config not synced before probe RPCs** - probe requests hung until the 180-second protocol timeout. Probe methods now sync the account provider config first, matching the connectivity-test path.
- **Registry enumeration spun up a full workspace app on every settings poll** - the 1s polling loop saturated the CLI and got its process killed by the Host's stale-client cleanup. Model enumeration now reads the in-process provider-registry snapshot - no workspace app, no per-poll network refresh.
- **One workspace app spawned per model during probing** (~100 for a 106-model registry) - every probe blew its 30s timeout. A single workspace app is now cached per workspace and reused for all probes.
- **Stage-2 probe didn't bind a reasoning level** - models that require one failed with "Reasoning level is required" (a false death, including the user's own working model). The stage-2 selection now resolves the model's reasoning level from its own option set.
- **No retry policy and no ledger rehydration** - a single transient timeout left entries stuck, and after the process was killed the engine forgot everything and reset to `unknown`. Probe-all now retries up to 3× per model, and the engine rehydrates from the persisted ledger on creation.

Plus: adaptive settings polling (1s while probing, 5s idle) instead of a constant 1s.

## Verification

- Deterministic gates all pass: root `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`.
- Unit suites: shared health-policy (9 tests), atomic ledger store (8 tests), probe engine (5 tests), picker presentation.
- End-to-end in the running desktop app (dev build): **Alive 40 / Dead 66 / Unknown 0** with real per-model latencies and provider errors. Live-working models reach `alive`; models that genuinely reject the probe (free-tier rate limit / auth) surface their real provider error as `dead`.

## Notes

- The Windows installer is **unsigned**. Windows SmartScreen may warn on first run.
- Models on free-tier providers that rate-limit or reject the minimal probe will show as `dead` with the provider's real error - that's the monitor working as intended, not a system bug.
- Report issues at https://github.com/AGSQ11/ZCode/issues
