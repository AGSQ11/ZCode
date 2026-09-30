# Three Settings Features - Implementation Brief

> Saved from sess_69fef1ef for continuation. All codebase exploration complete.

## Branch: `attempted-uiplugin-merge` (current HEAD: `43fb91f`)

## Feature 2: Global System Prompt Override (Settings > General)

### Key findings
- `AppSettings` interface at `packages/shared/src/protocol.ts:237` - add `customSystemPrompt?: string`
- Settings validation at `packages/shared/src/validationAppSettings.ts` - add to schema
- `useSettings()` hook at `packages/ui/src/hooks/useSettingService.ts:108` - reads/writes AppSettings via `settingService.get()` / `settingService.update(patch)`
- General section rendered in `packages/ui/src/SettingsPage.tsx` (the `activeSection === "general"` branch)
- Runtime injection: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts` creates apps via `createZCodeApp({ ...appOptions, runtimeConfig: { ...runtimeConfig, systemPrompt: ... } })`
- Runtime reads `this.config.systemPrompt` at `apps/zcode-cli/packages/core/src/runtime/methods/context.ts:142` and passes it as `customSystemPrompt` to the context builder
- Context builder at `apps/zcode-cli/packages/core/src/context/builder.ts:87-130`: when `customSystemPrompt` is set, it replaces the stable identity/behavior sections but keeps CLI prefix, skills, date, and request-user-context

### Implementation steps
1. Add `customSystemPrompt?: string` to `AppSettings` in `packages/shared/src/protocol.ts`
2. Add to validation schema in `packages/shared/src/validationAppSettings.ts`
3. In SettingsPage General section: add a `SettingsGroupCard` with a `<textarea>` for the prompt, committed on blur via `update({ customSystemPrompt: value })`
4. In `zcode-protocol-entrypoint.ts` where `createZCodeApp` is called: read settings, inject `systemPrompt: settings.customSystemPrompt` into `runtimeConfig`
5. i18n keys in en-US + zh-CN

### Reading the settings in the entrypoint
The entrypoint at `zcode-protocol-entrypoint.ts:244-295` creates the server with app options. The settings file is read by the host process (packages/services/src/node.ts creates ISettingService). The entrypoint needs to read the setting at session creation time. Check how `appOptions` is constructed and where to inject `systemPrompt` - likely alongside `runtimeConfig.modelStreaming` in `createWorkspaceZCodeApp` or directly in the app options assembly at line 252.

---

## Feature 3: Per-Session System Prompt Override (Composer Toolbar)

### Key findings
- Permission modes at `packages/ui/src/v4/composer/V4ComposerModeControls.tsx` - a DropdownMenu with RadioItems
- Draft config at `packages/ui/src/v4/composer/composerPromptContexts.ts` - carries model selection, mode, etc.
- V4 prompt commands at `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/session-flow.ts` - handles sendText payload
- V4 command schemas in `packages/shared/src/zcode-protocol-v4/` - the prompt command payload schema
- Need to add `systemPrompt?: string` to the V4 prompt command payload, thread it through the composer draft config, and read it in the bootstrap handler

### Implementation steps
1. Add `systemPrompt?: string` to the V4 prompt command schema
2. Add a "System prompt" icon button in the composer area (next to the mode switch) that opens a Popover with a textarea
3. Store the value in the draft config / session state
4. Thread it through the prompt handler to `runtimeConfig.systemPrompt`
5. i18n keys

---

## Feature 1: Fetch All Models from Provider API

### Key findings
- "+ Add model" button at `packages/ui/src/settings/model-provider-section/ProviderCardSections.tsx:477-483`
- Model config resolution via `providerSettingsService.resolveModelConfig({ providerId, modelId })` - already fills capabilities
- `addPersonalModel()` at `packages/provider/src/facades.ts:358-373` and `packages/provider/src/config-service.ts:322-366`
- No existing "fetch remote models" / `/models` API call anywhere
- Provider config shape at `packages/services/src/model-provider/legacyModelProviderSerialized.ts:101-131` - has `endpoints.baseURL` and `apiKey`

### Implementation steps
1. New protocol method `provider/listRemoteModels` - params: `{ workspace, providerId }`, result: `{ models: { id: string }[] }`
2. Bootstrap handler: read provider config from registry, HTTP GET `${baseURL}/v1/models` with auth header, parse response
3. Wire through zcodeAgentService → IProviderSettingsService
4. UI: "Fetch all models" button next to "+ Add model" in ProviderCardSections.tsx
5. On click: call listRemoteModels → for each new model, resolveModelConfig → addPersonalModel
6. Progress state in UI
7. i18n keys
