# Features 1 & 3 - Implementation Spec (exact anchors)

> Written for subagent implementers. All anchors verified on branch `attempted-uiplugin-merge` @ `a4346c7`. Do NOT re-explore; implement to spec. Chinese comments for constraint comments. No attribution trailers.

## Repo facts
- Windows, Git Bash, pnpm monorepo. Root gates: `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`.
- **Critical:** root `pnpm typecheck` does NOT compile `apps/zcode-cli`. After ANY change under `apps/zcode-cli`, run `pnpm --filter @zcode/bootstrap... build` (must exit 0) - this is the gate that caught the earlier regressions.
- Locale files (`packages/ui/src/i18n/locales/en-US.ts`, `zh-CN.ts`) have typographic quotes. The **Edit tool corrupts them** (normalizes quotes file-wide). Insert new keys with a Node script: `node -e "..."` doing string slice-insert at an anchor, or `sed`. Verify with `git diff --stat` that only your lines changed (insertions, no deletions of existing lines). After inserting, run `pnpm exec oxfmt <file>` to format (oxfmt is safe; it's the Edit tool that corrupts).

---

## FEATURE 3: Per-session system prompt override (composer)

Goal: a button in the V4 composer toolbar (near the permission-mode switch) opens a popover with a textarea. The entered prompt overrides the system prompt for that session only, applied live and persisted for the session. It takes precedence over the global `AppSettings.customSystemPrompt` (Feature 2, already merged).

### Data flow (mirror the existing `setFollowupMode` command exactly)

**1. Runtime accepts systemPrompt in `updateConfig`** - `apps/zcode-cli/packages/core/src/runtime/methods/config.ts:48`
- `updateConfig(this, patch: Pick<AgentRuntimeConfig, "mode"|"planEnabled"|"language"|"outputStyle">)` - widen the patch type to include `"systemPrompt"`.
- Add a branch mirroring the `language`/`outputStyle` handling (lines 59-70):
  ```ts
  if (patch.systemPrompt !== undefined) {
    this.config.systemPrompt = patch.systemPrompt;
    if (!this.activeTurn) {
      rebuildContextPrefix(this);
    }
  }
  ```
- `context.ts:142` already reads `customSystemPrompt: this.config.systemPrompt`, so no context-builder change needed.

**2. App facade exposes `setSystemPrompt`** - `apps/zcode-cli/packages/bootstrap/src/app/input-facade.ts` (near `setFollowupMode` at line 362) and its type in `app/types.ts` (near line 787).
- Add to the facade pick-list union (`input-facade.ts:36` area) and `app/types.ts`:
  ```ts
  setSystemPrompt(prompt: string | undefined, options?: { traceContext?: TraceContext }): Promise<void>;
  ```
- Implementation: `setSystemPrompt: async (prompt, options) => { await deps.runtime.updateConfig({ systemPrompt: prompt }); }` - mirror how `setFollowupMode` calls `deps.runtime.setFollowupMode(...)`. (If `updateConfig` isn't directly on the runtime facade, call through whatever `setFollowupMode` uses - read that call site.)

**3. V4 command** - `packages/shared/src/zcode-protocol-v4/command.ts`
- Add to `commandPayloadSchemas` (near `setFollowupMode` at line 223):
  ```ts
  setSystemPrompt: z.object({ prompt: z.string().max(32_000).optional() }),
  ```
- Add to `createSessionRequestedConfigSchema` (line 31): `systemPrompt: z.string().max(32_000).optional(),`

**4. Command handler** - `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/`
- Register a `setSystemPrompt` handler mirroring `setFollowupMode` (find it in `queue.ts:146` or wherever setFollowupMode is wired - it calls `record.app.setFollowupMode`). New handler calls `record.app.setSystemPrompt(payload.prompt)` and returns `undefined` (or throws `V4CommandNoopError` if unchanged - check if there's a current-value getter; if none, just apply unconditionally like a plain set).
- Wire it into the handlers index + the executor's command routing (find where `setFollowupMode` is dispatched).
- In `applyRequestedSessionConfig` (`model-config.ts:182`): add handling for `config.systemPrompt` - call `record.app.setSystemPrompt(config.systemPrompt)` when present, alongside the existing model/mode application.

**5. Projection/persistence** - check how `setFollowupMode`'s result reaches the v4 projection (`product-projection.ts`, `projection-state.ts`). If followupMode is projected via a session event, systemPrompt may need the same. **Simplest correct approach:** since the composer holds the draft value locally and it's applied via command, the projection may not need to echo it back. Verify by checking whether `setFollowupMode` emits a `SessionFollowupModeChanged` event that the reducer consumes. If systemPrompt needs persistence across reload, add a session event; if it's fine as a live-only override that the composer re-applies, skip projection. **Prefer live-only + re-apply on session load** to keep the change bounded - document the choice in the commit.

**6. UI** - `packages/ui/src/v4/composer/`
- Add a small icon button near the mode switch in `V4ComposerToolbar.tsx` (the `V4ComposerModeSwitch` is exported from `V4ComposerModeControls.tsx`). Use a lucide icon like `MessageSquareText`.
- Clicking opens a `Popover` (component exists in `packages/ui/src/components/ui/popover.tsx`) containing a textarea + Apply/Clear buttons.
- Store the value in the composer draft. Find `draftConfig` / `SessionConfigState` usage in `V4ComposerToolbar.tsx` and `useDraftConfigControl.ts`. Add `systemPrompt` handling: on Apply, send the `setSystemPrompt` command (mirror how the mode switch sends `switchCollaborationMode` - find that dispatch in `SessionPane.tsx` or the composer submit path) AND include `systemPrompt` in the createSession `config` for draft sessions.
- Show a visual indicator (e.g. the button highlighted) when a session override is active.

**7. i18n** - keys `settings`/`chat` namespace: `chat.systemPrompt.label`, `chat.systemPrompt.placeholder`, `chat.systemPrompt.apply`, `chat.systemPrompt.clear`, `chat.systemPrompt.active`.

### Acceptance
- `pnpm typecheck` exit 0; `pnpm --filter @zcode/bootstrap... build` exit 0; `pnpm lint` 0 errors; `pnpm architecture:check --changed` 0 violations.
- A unit test if feasible for the runtime `updateConfig({systemPrompt})` path (check if `config.ts` has sibling tests; if the pattern exists, add one asserting `config.systemPrompt` is set and context rebuilt).

---

## FEATURE 1: Fetch all models from provider API

Goal: in Settings > Model settings > provider, next to "+ Add model", a "Fetch all models" button. It calls the provider's OpenAI-compatible `GET {baseURL}/models`, discovers model IDs, and for each new one runs the existing smart capability resolution (`resolveModelConfig`) then `addPersonalModel` - same as the single "+ Add model" dialog does, but batched. Shows progress.

### Data flow

**1. Protocol method** - `packages/shared/src/zcode-protocol/index.ts`
- Add to `zcodeProtocolMethods`: `providerListRemoteModels: "provider/listRemoteModels",`
- Schemas (near the connectivity/probe schemas):
  ```ts
  export const zcodeProviderListRemoteModelsParamsSchema = z.object({
    workspace: zcodeWorkspaceRefSchema,
    providerId: nonEmptyString,
  }).strict();
  export const zcodeProviderListRemoteModelsResultSchema = z.object({
    models: z.array(z.object({ id: nonEmptyString }).strict()),
  }).strict();
  ```
  + `z.infer` types.

**2. CLI handler** - `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/`
- New handler (e.g. in `workspace-model-runtime.ts` or a new `remote-models.ts`): given providerId, read the provider's config from the process registry (`context.deps` - mirror how `listRegistryModels` was injected in `zcode-protocol-entrypoint.ts`; you need baseURL + apiKey + headers). HTTP `GET {baseURL}/models` with `Authorization: Bearer {apiKey}` + provider headers. Parse `{ data: [{ id }] }` (OpenAI shape) or `{ models: [{ id|name }] }` (some providers). Return `{ models: [{ id }] }`.
- **Auth note:** the API key may be resolved via the account-provider credential path, not stored plaintext in config. Check how `testModelConnectivity` / the provider runtime gets the key (search `accountProviderApiKeyResolver` in packages/services). If the CLI can't easily get the key, the fetch may need to happen Host-side instead. **Decide based on what you find and document it.** Prefer Host-side fetch if the key only lives there.
- Dispatch in `server.ts` (near the probe cases at line ~693).

**3. Services facade** - `packages/services/src/model-provider/providerFacadeServices.ts`
- Add `listRemoteModels(input: { workspacePath; providerId }): Promise<{ models: {id:string}[] }>` to `IProviderSettingsService`, wired through `zcodeAgentService` (mirror `testModelConnectivity` at `zcodeAgentService.ts:4418` - include the `ensureAccountProviderConfigSynced` call first, same bug Feature 2's probe path fixed).

**4. UI** - `packages/ui/src/settings/model-provider-section/ProviderCardSections.tsx`
- Next to the "+ Add model" button (line ~477), add "Fetch all models" button (`variant="outline"`).
- On click: call `providerSettingsService.listRemoteModels({ providerId })` → for each returned id not already present, call `resolveModelConfig({ providerId, modelId })` then `addPersonalModel(providerId, modelId, resolution.config, useRecommendedConfig=true)` - reuse the EXACT same calls the single-add dialog's commit uses (read `useProviderModelDraft.ts` / the dialog's `onCommit` → `onAddModel` path to copy the resolution+add logic).
- Show inline progress "Importing X / N..." and a completion summary. Skip models that already exist (the service throws "Model 已存在" - catch and continue).
- Refresh the provider view after (call the existing refresh that `onAddModel` triggers).

**5. i18n** - `settings.modelProvider.fetchAllModels`, `.fetching`, `.fetchedCount` (with {count}), `.fetchError`.

### Acceptance
- Same gates as Feature 3.
- Unit test for the OpenAI-shape parser (pure function extracting ids from `{data:[{id}]}` and `{models:[{id}]}`) if the handler logic is factored into a pure parse helper.

---

## Execution order & commits
Do Feature 3 first, then Feature 1 (they share i18n files - sequential avoids conflicts). Two separate commits:
- `feat(ui): per-session system prompt override in composer`
- `feat(settings): fetch all models from provider API`

Each commit must leave all gates green (typecheck, bootstrap build if CLI touched, lint, architecture).
