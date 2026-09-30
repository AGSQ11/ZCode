# Implementation Plan: 3 Settings Features

## Feature 1: "Fetch all models" button in Settings > Model settings > Provider

**What exists today:** Each provider has a "+ Add model" button that opens a dialog for adding ONE model by ID, with smart capability resolution via `useModelConfigResolution` → `providerSettingsService.resolveModelConfig()`. The dialog uses `ProviderModelMetadataDialog` in `mode="add"`.

**What to build:** A second button "Fetch all models" next to "+ Add model" that:
1. Calls the provider's API (`GET /models` or equivalent) to discover all available models
2. For each discovered model, runs the existing `resolveModelConfig()` to fill capabilities (context window, max output tokens, input format, reasoning levels)
3. Adds them all via `addPersonalModel()` (the same path "+ Add model" uses), skipping duplicates
4. Shows progress (X / N models added)

**Implementation approach:**
- Add a new protocol method `provider/listRemoteModels` that makes a real HTTP call to the provider's base URL + `/models` (OpenAI-compatible endpoint), returning `{ models: { id: string }[] }`
- Wire it through `zcodeAgentService` → bootstrap server → a new handler in `workspace-model-runtime.ts` that uses the provider's configured `baseURL` + API key to fetch `/v1/models`
- In `ProviderCardSections.tsx`, add a "Fetch all models" button next to the existing "+ Add model" button
- On click: fetch remote models → for each, call `resolveModelConfig()` → then batch `addPersonalModel()` for each resolved model
- Show a progress toast/inline status while importing

**Files to create/modify:**
- `packages/shared/src/zcode-protocol/index.ts` — new method + schemas
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server.ts` — handler dispatch
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-runtime.ts` — HTTP fetch to provider's /models endpoint
- `packages/services/src/zcode-agent/zcodeAgent.ts` + `zcodeAgentService.ts` — service method
- `packages/services/src/model-provider/providerFacadeServices.ts` — expose on IProviderSettingsService
- `packages/ui/src/settings/model-provider-section/ProviderCardSections.tsx` — "Fetch all models" button + progress state
- i18n keys in both locale files

---

## Feature 2: Global system prompt override in Settings > General

**What exists today:** The runtime already supports `customSystemPrompt` via `AgentRuntimeConfig.systemPrompt` → `ContextBuilderConfig.customSystemPrompt`. When set, it replaces the entire stable system body (identity/behavior sections) while keeping the CLI prefix, skills, and date. Currently this field is only set programmatically (e.g. by workflow actors), never from user settings.

**What to build:** A text area in Settings > General that persists a global system prompt override in `AppSettings.customSystemPrompt`. When set, every new session reads it from settings and passes it to the runtime config.

**Implementation approach:**
- Add `customSystemPrompt?: string` to the `AppSettings` interface (`packages/shared/src/protocol.ts`)
- Add `customSystemPrompt` to the settings validation schema (`packages/shared/src/validationAppSettings.ts`)
- In `packages/ui/src/settings` General section (or a new sub-card), add a `SettingsRow` with a multi-line `<textarea>` for the prompt, committed on blur
- In the bootstrap protocol entrypoint where session apps are created (`zcode-protocol-entrypoint.ts`), read `customSystemPrompt` from the settings file and inject it into the app options' `runtimeConfig.systemPrompt`
- The existing `customSystemPrompt` → builder → context pipeline handles the rest

**Files to modify:**
- `packages/shared/src/protocol.ts` — add field to `AppSettings`
- `packages/shared/src/validationAppSettings.ts` — add to schema
- `packages/ui/src/SettingsPage.tsx` or the General section component — add the textarea control
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts` — read from settings, inject into runtime config
- i18n keys in both locale files

---

## Feature 3: Per-session system prompt override in the composer toolbar

**What exists today:** The composer toolbar has a permission mode dropdown (`V4ComposerModeControls.tsx`) with modes like "Full access", "Ask before changes", etc. The runtime's `systemPrompt` field is already per-session via `AgentRuntimeConfig`.

**What to build:** Add a "System prompt" option in the composer's mode/config dropdown (or as a separate button near the permission controls) that opens a dialog/popover for entering a session-scoped system prompt. When set, it overrides both the global setting and the default for that session only.

**Implementation approach:**
- In the V4 composer controls area, add a small icon button (e.g. `MessageSquareText` from lucide) that opens a popover/dialog with a textarea
- The value is stored in the draft config (same Zustand store as model selection and mode) as `draftConfig.systemPrompt`
- When the session starts or the next prompt is sent, the `systemPrompt` from draftConfig flows into the V4 prompt command payload → the bootstrap layer reads it and passes it to `runtimeConfig.systemPrompt`
- This requires threading a new optional `systemPrompt` field through the V4 prompt command schema and the bootstrap prompt handler

**Files to modify:**
- `packages/shared/src/zcode-protocol/index.ts` or the V4 command schemas — add `systemPrompt` to the prompt command params
- `packages/ui/src/v4/composer/V4ComposerToolbar.tsx` or `V4ComposerModeControls.tsx` — add the system prompt button + popover
- `packages/ui/src/v4/composer/composerPromptContexts.ts` — thread systemPrompt in the draft config
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/session-flow.ts` — read systemPrompt from command payload and apply to runtime config
- i18n keys in both locale files

---

## Execution order

Feature 2 (global prompt) first — it's the simplest, adds the `AppSettings` field that Feature 3 can later override. Feature 3 (per-session) second — builds on the same runtime path. Feature 1 (fetch all models) last — it's independent and the most complex (HTTP call to external API).