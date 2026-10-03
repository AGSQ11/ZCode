# ZCode model groups: complete developer implementation prompt

You are implementing a production feature in https://github.com/AGSQ11/ZCode. Implement the complete feature described below, including specifications, persistence, runtime routing, UI, compatibility, documentation, and executable tests. Do not stop at a design, mock interface, partial patch, or TODO list. Work in a new feature branch; do not merge or publish a release automatically. Preserve unrelated work.

The desired feature is user-defined **model groups**. A group is a selectable execution target that dispatches to one configured member at a time. Each member binds a specific provider connection, model, and reasoning setting. Groups support deterministic routing, bounded failover, and an optional workload level. The user selects a group as easily as a single model.

This is a router inside the existing agent application. The router does not ask an LLM which member to call. The group does not create a committee of agents, split the user's prompt, or run several models concurrently for the same model request. ZCode's existing tools, permissions, workflow scheduler, and agent loop continue to own work execution.

Normative language: MUST means required; MAY means permitted. The defaults and rules below are binding unless the actual checkout exposes an incompatibility. Resolve implementation details using the existing architecture. If a binding rule cannot be satisfied, report the concrete conflict before replacing it with different product behavior.

## 1. Baseline and repository investigation

This prompt was grounded in default-branch commit `a73bdb5e430dc0afaf08ee12382f042140503880`, inspected on 2026-10-02 Europe/Bucharest. Re-read the current checkout; do not assume this commit is still the branch tip.

Before edits:

1. Read the root and applicable nested `AGENTS.md` files, `DESIGN.md`, `mise.toml`, and relevant package manifests.
2. Run `node scripts/check-workspace-freshness.mjs`.
3. Follow `.agents/skills/architecture-governance/SKILL.md`; run the existing architecture check and obtain the controlled context for affected modules.
4. Locate actual test entry points. There is no assumed repository-wide `pnpm test` command.
5. Create or update the feature spec before changing behavior, as required by the repository. Include state ownership and event-order diagrams in that spec.
6. Record all relevant model invocation entry points, including main turns, workflow actors, subagents, title generation, compaction, memory, and tools that make auxiliary LLM requests. Identify which are session-bound and which are standalone.

Verified integration anchors at the inspected commit:

| Concern | Existing source |
| --- | --- |
| Concrete model identity and reasoning choice | `packages/shared/src/model-selection.ts` |
| Model properties and option-map validation | `packages/shared/src/model-config.ts` |
| Provider registry and effective selection | `packages/provider/src/registry.ts`, `resolver.ts`, `effective-model-selection.ts`, `model-selection-config.ts` |
| Provider configuration ownership | `packages/provider/src/config-service.ts` and public facades |
| Host-facing model-selection view | `packages/ui/src/hooks/useModelSelectionView.ts`, provider facade services |
| Existing picker | `packages/ui/src/ModelConfigSelect.tsx`, `chat-input-toolbar/modelSelection.ts` |
| Existing visual provider grouping | `packages/ui/src/lib/modelSelectionGroups.ts` |
| Provider settings | `packages/ui/src/settings/ModelProviderSection.tsx` |
| Concrete runtime model factory | `apps/zcode-cli/packages/bootstrap/src/app/provider-registry-model-runtime.ts` |
| Runtime model contract | `apps/zcode-cli/packages/contracts/src/model/model.ts` |
| Invocation governance | `apps/zcode-cli/packages/contracts/src/model/invocation-context.ts`, core `runtime/methods/runtime-model.ts` |
| Turn model selection and actual execution | core `runtime/methods/turn-model.ts`, `turn-model-step.ts` |
| SDK execution, retries, and streams | adapters `model/model-execution.ts`, `runner.ts`, `runner-generate.ts`, `runner-stream.ts`, `runner-retry.ts` |
| Retry policy and existing unbounded budgets | adapters `model/retry-policy.ts`, `retry-budget.ts`, `workflow-model-failure-policy.ts` |
| Adapter's stream commitment boundary | adapters `model/stream-retry-boundary.ts` |
| Core recovery after partial output | core `runtime/methods/streaming-recovery.ts` and streaming tool coordinator |
| Workflow model selection and resume pins | bootstrap `app/workflow-actor-model.ts` |
| Session wire contract | `packages/shared/src/zcode-protocol-v4/session-config.ts` and canonical protocol entry points |
| Persisted concrete selections | services `session/tasksDatabase/provider-selection-v2.ts`; adapter session-store migrations |
| CLI model picker | CLI `command-center/handlers/model.ts`, `command-center/model-selection.ts` and TUI model files |

CLI package paths in this table are under `apps/zcode-cli/packages/`. Shortened core/adapters/bootstrap paths refer to their respective `src/` directories. New file names are implementation choices, not existing files implied by this prompt.

Important current facts:

- `ModelSelection` is a strict `{ providerId, modelId, options?: { reasoningLevel } }` schema. Picker strings are display/legacy boundaries, not canonical persisted identity.
- The normal model factory validates the registry selection and freezes the concrete provider/model configuration.
- Reasoning is expressed as `reasoningLevel` and translated by existing option maps. Do not hardcode OpenAI's `reasoning_effort` into every provider request.
- Turn execution reads properties and output limits from the concrete model before streaming. A wrapper with static metadata that secretly swaps models would give incorrect context budgets and attribution.
- Existing adapter retries normally allow the initial attempt plus ten retries; some workflow paths have an unbounded retry budget. A group that merely wraps that code could remain stuck on its first member indefinitely.
- Existing stream logic distinguishes discardable prelude from committed output, and core recovery already has committed tool anchors. Preserve and extend those boundaries.
- `modelSelectionGroups.ts` groups picker entries visually by provider. It is not this execution-routing feature. Keep the concepts distinguishable in types and UI.

## 2. Product behavior and required scope

The user can:

1. Create, edit, duplicate, enable, disable, reorder, export, import, and delete custom groups.
2. Add configured models from different provider connections to the same group.
3. Set the reasoning level separately for every member, including different reasoning levels for the same provider/model.
4. Choose `round_robin`, `balanced`, `least_used`, or `priority` routing.
5. Assign a group `light`, `medium`, `heavy`, or `custom` workload level.
6. Select a group in every application surface that currently lets them select an execution model, where that surface is applicable.
7. Use a group for the main agent and a different group for workflow actors/subagents.
8. Inspect which actual model was used, why a fallback happened, and why a member was skipped.
9. Keep existing direct single-model selection working without a behavioral change to its retry policy.

Required platforms: Electron Desktop, Web, mobile Web remote control, local and remote workspaces, and CLI/TUI. Reuse the existing Host/service/runtime routes. A mobile attachment must control the same runtime; it must not create a second routing authority or extra agent process.

Groups are opt-in. Existing users start with an empty group collection. Do not silently convert their default model into a group or create real provider entries for the sample model names below.

## 3. Execution target and single source of truth

Retain `ModelSelection` as the concrete model identity. Introduce a separate strict, discriminated execution-target schema:

```ts
type ExecutionTarget =
  | { kind: 'model'; selection: ModelSelection }
  | { kind: 'group'; groupId: string };

type WorkloadLevel = 'light' | 'medium' | 'heavy' | 'custom';
type RoutingStrategy = 'round_robin' | 'balanced' | 'least_used' | 'priority';
```

The canonical target belongs to existing default/session/submission/workflow configuration owners. Store a structured target, never a magic provider ID such as `group:heavy`, concatenated model IDs, or a group name masquerading as a provider model. Stable group IDs survive rename.

Keep three facts separate:

- **Requested target:** the user-selected model or group; persists as intent.
- **Turn routing snapshot/pin:** the group revision and member chosen for that admitted user turn or actor turn.
- **Actual attempt selection:** the concrete provider, model, reasoning, and effective properties for one physical provider attempt.

A fallback changes the pin and actual selection; it MUST NOT overwrite the user's requested group with the member model. Direct-model intent stays concrete. UI projection fields are not another writable source of truth.

Migrate old stored model selections to `{ kind: 'model', selection: oldSelection }` using a versioned migration. Do not add unversioned repair logic to ordinary reads. Transitional old wire fields may be read-only projections for direct targets, but no record may independently own two contradictory selections. Document precedence, mixed-version handling, and when deprecated fields stop being emitted.

Preserve existing workspace identity isolation: use the repository's `workspaceIdentity?.trim() || workspacePath` utility, not a newly invented path-only key. Carry remote identity, owner/lease, run ID, and attachment identity through existing boundaries.

## 4. Persistent group configuration

Implement the following logical data shape with strict runtime validation. Use existing package style and canonical Zod schemas; equivalent naming is acceptable, equivalent semantics are required.

```ts
interface ModelGroupMember {
  id: string;                  // generated UUID; stable through edits/reordering
  selection: ModelSelection;   // exact configured providerId/modelId/reasoningLevel
  enabled: boolean;
  weight: number;              // integer 1..100; used only by balanced
  maxInFlight: number | null;  // integer 1..64; null means no extra member limit
}

interface ModelGroup {
  id: string;                  // generated UUID, immutable
  revision: number;            // positive integer, incremented by config owner
  name: string;
  description: string;
  enabled: boolean;
  workloadLevel: WorkloadLevel;
  strategy: RoutingStrategy;
  affinity: 'turn' | 'request';
  members: ModelGroupMember[];  // array order is authoritative
  failover: {
    enabled: boolean;
    maxMemberAttempts: number; // integer 1..32; initial attempt included
    requestDeadlineMs: number;// integer 1000..1800000
  };
}

interface ModelGroupsConfig {
  schemaVersion: 1;
  revision: number;
  groups: ModelGroup[];
  defaultTarget?: ExecutionTarget;
  workloadDefaults: {
    light?: string;             // referenced groupId
    medium?: string;
    heavy?: string;
    custom?: string;
  };
}
```

`defaultTarget` represents the existing default selection extended to support groups; do not create a second independent default field if its current owner stores it elsewhere. Likewise, adapt storage to existing provider configuration conventions instead of inventing a second config file if the existing owner can support this domain.

New-group defaults:

| Setting | Default |
| --- | --- |
| enabled | true |
| workloadLevel | custom |
| strategy | round_robin |
| affinity | turn |
| description | empty string |
| failover.enabled | true |
| failover.maxMemberAttempts | 32 |
| failover.requestDeadlineMs | 600000 (ten minutes per logical model request) |
| member.enabled | true |
| member.weight | 1 |
| member.maxInFlight | null |

Validation and storage rules:

- Maximum 100 groups; maximum 32 members per group. Enforce at UI and service/import boundaries.
- Name: trim, Unicode NFC normalize, 1..80 Unicode code points, case-insensitive unique after normalization. Description: at most 500 code points. Store plain text; escape when rendering. Reject control characters in names; permit ordinary newlines in descriptions.
- An empty group may be saved only disabled. An enabled group must contain at least one enabled member. Temporarily unavailable members do not prevent saving a structurally valid existing group.
- New/edited member selections must identify a configured provider/model and an explicitly valid reasoning level. Populate reasoning options from `optionSpecs.reasoningLevel.values`. Even a non-reasoning model uses the configured valid neutral value/option map; do not invent `none` or silently replace unsupported reasoning.
- No nested groups. No member referencing the group itself. No cross-group fallback graph in this version.
- Within one group, reject duplicate `(providerId, modelId, reasoningLevel)` tuples. The same model at different reasoning levels is allowed. The same member selection in several groups is allowed.
- Provider identity must identify the actual configured connection, not just the vendor name. Two connections for the same vendor are distinct. Reuse current stable connection identity. For account-plan configurations that resolve to a current account, freeze the resolved connection/credential generation for the turn; if it changes, invalidate the old pin and revalidate. Never silently move a pinned member to another account merely because its model name matches.
- Groups store references, never copied API keys, authorization headers, or secret-bearing provider configuration.
- Missing/disabled providers and models remain visible as broken member references. Never silently delete them or substitute another model.
- All writes use the existing serialized config owner and expected revision. A stale editor gets a typed conflict and Reload action, not last-write-wins data loss. A successful save publishes one new authoritative revision.
- Durable config writes must be atomic according to existing storage facilities. Malformed import cannot partially apply. Preserve the current config and show validation errors.
- Duplicate group: allocate new group/member UUIDs, revision 1, preserve settings, and choose a unique name such as `heavy_models copy` or `heavy_models copy 2`.
- Deletion scans default/workload/workflow/automation references owned by the current Host and reports them. Require an explicit replacement or unset action in the delete dialog. Do not silently redirect sessions to a single model. Historical transcripts retain their provenance. An admitted turn may finish from its snapshot after deletion; future turns using the deleted ID fail clearly.

## 5. Workload levels and selection precedence

Workload level is user-defined routing metadata. It is not reasoning strength, actual model intelligence, a context-window guarantee, or a cost guarantee. Do not infer model capability from a name containing `flash`, `pro`, `opus`, or `heavy`.

There may be many groups at one level. At most one default group is configured for each workload level. A workload-default reference must point to a group of the same level; disabled/broken groups may remain referenced with an issue indicator, but cannot execute.

Extend eligible subagent/workflow/automation configuration with an optional `workloadLevel`. It is resolved by code, with the following priority:

1. Explicit execution target for the submitted turn/actor run.
2. Explicit workload level on that turn/actor/profile, resolving its configured workload default.
3. Target inherited from the parent/session, preserving existing explicit profile-versus-parent precedence where applicable.
4. Existing configured application default for a new session only.

If an explicit workload level has no usable default, return `WORKLOAD_GROUP_UNAVAILABLE`; do not fall through to a lower-priority target. If an existing session has an unresolved explicit target, do not replace it using new-session defaults.

No automatic prompt-complexity classifier, hidden paid router call, escalation from light to heavy, or fallback to a different workload level. Those would be separate product features. The current implementation makes explicit levels usable and predictable.

Illustrative user group names and members:

| Group | Level | Example model names supplied by the user |
| --- | --- | --- |
| light_models | light | gemini-3.5-flash; glm5-3-flash; claude-haiku-4-5; deepseek-v4-flash |
| medium_models | medium | deepseek-v4-pro; kimi-k2.7-code; claude-sonnnet-5 |
| heavy_models | heavy | kimi-k3; claude-opus-5.5; glm-5.3 |

These strings are examples of user intent, not verified API identifiers or built-in configuration. Users choose actual models and reasoning values from their configured catalog. Do not silently correct spelling, manufacture unsupported models, or distribute production presets with fake provider bindings.

## 6. Runtime ownership and routing architecture

Separate pure policy from stateful execution:

- `packages/shared`: schemas, public DTOs, event/error contracts. No network, credentials, or routing state.
- `packages/provider`: pure group reference validation, capability eligibility, and deterministic ranking helpers where consistent with its architecture. Group configuration is exposed through the existing provider/config owner and public facades.
- Host/services: one authoritative group configuration service per existing Host configuration scope; transport and observable views. UI accesses it through hooks.
- CLI core/runtime: one routing-state owner per agent process/runtime authority; injected ports expose selection, reservation, attempt accounting, and release. It shares state across runtimes managed by that authority.
- Bootstrap: composes the router ports with the existing registry and concrete model factory.
- Adapters: provider request execution, option mapping, failure classification, and the single-physical-attempt mode used by groups.

Do not import adapter implementation classes into core or runtime classes into services. Use public package entry points and dependency injection. Do not make Electron Main or renderer stores own model routing. Do not maintain independent Host and CLI copies of mutable health/counter state.

Configuration revisions are mirrored through established snapshot/event transports; that mirror is a projection. Runtime live reservations, cooldowns, and attempt counters belong to the agent authority. Each separate remote agent authority has independent load/health statistics; do not pretend to have distributed global balancing. Different windows with separate agent authorities likewise balance independently.

Route **before preparing the model request**. Expose a core-owned operation conceptually equivalent to:

```text
prepareRoutedAttempt(target, invocationContext, rawCommittedHistory, requirements)
  -> actual concrete Model
   + actual ModelSelection
   + group provenance
   + reservation lease
   + attempt identity
```

Exact method names are implementation choices. The invariant is that context limits, output budget, request normalization, tool schema, media projection, traces, and authentication are prepared using the member actually about to run. A failover member requires a new prepared attempt.

Do not solve routing with a `Model` wrapper that reports A's immutable properties while calling B. The existing model interface need not become a pretend union of incompatible capabilities. If a target-level view reports capability availability, label it as conditional and still validate each actual member.

Freeze the admitted group definition and member order for the user turn. Group edits affect the next admitted turn. Credential revocation, provider removal, and security restrictions are always rechecked immediately before an attempt; snapshots never authorize bypassing revocation.

For `affinity='turn'`, the first successful reservation pins a member for the whole user turn, including model steps after tool results. Completed attempts release network leases; a pin is not an occupied network slot. Subsequent steps prefer that member if eligible. On an eligible failure, a new member becomes the turn pin. At the next user turn, apply the strategy afresh.

For `affinity='request'`, each logical model request is routed independently. Keep each physical stream on one member. Changes are shown in provenance.

Each workflow actor/subagent has its own turn pin. Explicit group intent must survive actor resume instead of being rewritten to its last concrete model. Preserve existing concrete resume-pin semantics for direct targets. For a resumed group turn, use its saved group revision/pin if a safe committed checkpoint exists and the pinned member still validates; otherwise use explicit recovery/reselection at a request boundary and record the change. Never resurrect an incomplete provider stream after process restart.

Auxiliary calls belonging to a running turn inherit its target and prefer its pin when compatible, but a temporary fallback for a title/summary must not overwrite the main turn's pin. Mark invocation purpose and pin-owner scope explicitly. Standalone auxiliary calls route as independent requests. Existing auxiliary reasoning-lowering rules remain for direct targets; group members use their explicitly configured reasoning level and must not be silently lowered by `bind()`.

## 7. Eligibility and preparing each attempt

Filter candidates before strategy ranking and before acquiring provider admission:

1. Group exists, is enabled, and has structurally valid enabled members.
2. Member is enabled and not already attempted in this logical request.
3. Exact provider connection and model exist, are enabled/executable, and pass current account/credential checks.
4. Exact reasoning level is still supported.
5. Health/cooldown allows the endpoint/connection.
6. Member has capacity under its local group-member limit, and applicable existing provider admission rules allow it.
7. Actual model supports the request's mandatory input modalities, tools, structured output, and other required features.
8. The full committed request fits after safe, existing context preparation for that concrete model, with a valid output reserve.

Keep a structured skip reason for every rejected candidate. Missing model/capability/context is not a provider network failure and must not open a circuit or count as a started provider attempt.

Use actual provider/model properties. Never claim that a group supports images or tools merely because one member does. UI can display `Vision: 2 of 4 members` and filter eligible candidates for the attachment. An image request must not fall back to a text-only model. Text extraction or other conversion is permitted only through an already authorized, explicit existing conversion flow.

Context handling:

- Reconstruct per-attempt input from canonical committed history and tool results, not from an already provider-specific request body.
- Preserve existing token estimation, compaction, and safety reserves. Apply them for the selected concrete model.
- Do not trim system instructions, permissions, current user content, pending tool results, or attachments silently to make a smaller member fit.
- If safe context preparation cannot fit a candidate, skip it and try another. If none fit, return `GROUP_CONTEXT_UNSUPPORTED` with eligible capacity information.
- Context overflow confirmed by a provider is request-specific. Do not poison that endpoint's general health. Use existing safe compaction once for that logical request, outside the network-attempt loop, then start a new logical request with a new identity and bounded budget. Do not recurse endlessly between compaction and routing.
- Output limits are recomputed per actual member and invocation purpose. The member's context window and max output setting are not copied from the prior member.

Group membership itself authorizes dispatch to those configured connections. Failover never leaves the group or bypasses existing workspace/provider/privacy restrictions. The editor must make clear that different members may send the same conversation to different providers.

## 8. Routing strategies: exact definitions

Maintain endpoint runtime statistics keyed by `(authorityScope, resolvedConnectionIdentity, modelId)`. Counts are shared across all groups in that authority, and across reasoning variants of the same endpoint, so duplicating an entry cannot conceal load. Instrument direct-model calls through the same observation boundary for accurate load statistics without changing their selection/retry behavior.

Maintain local member capacity keyed by `(authorityScope, groupId, memberId)`. `maxInFlight` is a local group-member cap, not a universal vendor limit. Existing provider admission remains an additional constraint. UI must label the distinction.

Persist endpoint `attempts24h` in bounded hourly buckets: current UTC hour plus previous 23 hour buckets. Expire older buckets on read/write. This is a rolling **24 hourly-bucket window**, not exact timestamp-level 24 hours. Increment on physical request execution beginning after local admission, including failed attempts. Skip/revalidation/cancellation before execution does not increment. Maintain `inFlight` from reservations until release. Reconcile it to zero when the authority starts; never persist active slots as permanent load.

Keep a cyclic cursor per `(authorityScope, groupId)` that identifies the next position in member order. Store stable member ID for restart/reorder reconciliation. If the cursor's member no longer exists, start from the first member of the current snapshot. Use this cursor for round robin and score ties.

All selection and reservation updates are atomic within the routing authority; do not hold a lock across network requests or provider admission waits.

| Strategy | Ranking and selection |
| --- | --- |
| `round_robin` | Scan member array cyclically from the cursor; choose first eligible/reservable member; move cursor to the position after that member when reservation succeeds. |
| `priority` | Scan from index 0 every time; choose first eligible/reservable member. Do not change order automatically based on latency. |
| `least_used` | Choose lowest `attempts24h` for the endpoint; break equal counts by cyclic cursor order; advance cursor after reservation. Weight has no effect. |
| `balanced` | Lexicographically minimize `(endpoint.inFlight / member.weight, endpoint.attempts24h / member.weight)`; break equal pairs by cyclic cursor order; advance cursor after reservation. |

Compare ratios by integer cross multiplication rather than floating point tolerances. Cap bucket counters at safe integers and handle overflow explicitly. Weight affects only `balanced`; hide/disable its control under other strategies while retaining its saved value.

Balanced means weighted concurrency first and historical request distribution second. It does not mean latency optimization, token distribution, cheapest routing, semantic quality ranking, or vendor quota remaining. Explain that in a short help text. Keep all strategies deterministic for a fixed snapshot and clock.

Sticky turn pins take precedence over ranking if the member remains eligible and has capacity. If a pinned member is locally busy, another eligible member may be used at the new request boundary and becomes the new pin; record `capacity` as the transition reason. Do not cancel an in-flight call merely to rebalance it.

If local capacity/admission prevents every member, return `GROUP_BUSY` with a retry suggestion. If all candidates are cooling, return `GROUP_COOLING_DOWN` with the earliest retry time. Do not wait indefinitely or launch an unbounded paid probe. Preserve any existing provider-level admission semantics inside the bounded request deadline; promptly cancel a queued admission if an available alternative can be selected through the existing nonblocking admission interface. Where no nonblocking interface exists, document and test the bounded queue behavior rather than guessing vendor capacity.

## 9. Bounded failover and failure classification

One logical model request may make at most `min(maxMemberAttempts, enabled snapshot member count)` physical member attempts. Initial request counts as attempt 1. Each member ID is attempted at most once in that request. Unsupported/skipped members do not count as physical attempts. A failover recomputes strategy eligibility excluding attempted members; `priority` uses remaining list order, and other strategies use their ranking rules.

With `failover.enabled=false`, select one member by strategy and permit one physical attempt only. Return that member's structured failure. Do not fall through silently.

The group router owns the attempt budget. Add an explicit invocation policy for **one physical adapter attempt**, applied below existing runtime invocation-layer merging so unbounded workflow budgets cannot override it. Disable SDK automatic retries, adapter retry loops, empty-completion retry, off-peak hidden resubmission, and other automatic physical resends for that group attempt. Authentication refresh before dispatch is still allowed; a second model completion request consumes a new router attempt. Verify the network boundary, not just a function call count.

Routing failures are also explicit outcomes at the core/workflow-driver boundary. `GROUP_EXHAUSTED`, `GROUP_BUSY`, `GROUP_COOLING_DOWN`, `GROUP_DEADLINE_EXCEEDED`, and `GROUP_RECOVERY_REQUIRED` must terminate or pause the current invocation according to its caller; an outer workflow retry policy must not unwrap their transient provider cause and automatically begin another full group cycle. A user Retry, scheduled later retry already governed by an existing finite scheduler policy, or valid checkpoint Resume may create a new invocation. Snapshot replay, reconnect, and an unbounded model retry budget may not. Test both the adapter boundary and the driver boundary.

Do not modify global retry env variables to implement group behavior. Direct targets retain current behavior. There must be one place that authorizes each physical completion request. Outer core recovery may continue only under the same router-controlled recovery ledger described in section 11; it cannot reset the same request's budget.

`requestDeadlineMs` covers candidate preparation, admission, network attempts, and recovery for one logical model request. Start it when routing begins. Deadline expiration aborts pending work and returns `GROUP_DEADLINE_EXCEEDED`; no next attempt. Use monotonic elapsed time for running deadlines. Reuse current provider connection/first-output/idle timeout policies; cap them by the remaining deadline. Do not introduce silent shorter stream timeouts that regress current providers.

Classify through existing structured failure classifiers. Extend missing distinctions explicitly. HTTP status by itself is insufficient; for example, 404 may mean an incorrect API route rather than an unavailable model.

| Failure class | Group action at a safe boundary | Health effect |
| --- | --- | --- |
| User cancellation, stale owner/lease, deadline exhausted | Stop immediately; do not try another member | None |
| Network reset/timeout, upstream 408, transient 5xx/overload | Try another eligible member | Transient cooldown on affected endpoint; connection-wide only for confirmed connection/transport failure |
| Temporary rate limit 429/concurrency rejection | Try another eligible member; respect Retry-After for affected scope | Endpoint cooldown unless classifier proves connection/account-wide scope |
| Invalid credentials 401 or confirmed authentication 403 | Mark connection unavailable; try members using other usable connections | Block connection until credential/account state changes |
| Confirmed balance/quota exhaustion (402 or structured business code) | Try usable members outside exhausted scope | Known reset time, or connection block until quota/account/config change |
| Confirmed model unavailable/not entitled/model-specific 404 | Try another eligible member | Model/endpoint blocked until catalog/config/entitlement change |
| Generic route 404, invalid endpoint/TLS configuration | Try different usable connection; never disable TLS verification | Block misconfigured connection until config change |
| Member-specific unsupported reasoning/feature | Skip or invalidate that member; try another | Member issue; do not rewrite reasoning |
| Input/context/output budget validation | Re-prepare/skip as in section 7; fail if universal | Request-specific; no general circuit damage |
| Provider malformed/empty completion before commitment | Try another eligible member | Transient endpoint cooldown |
| Shared malformed request/tool schema/internal programming error | Stop with actionable error | None; do not mask a bug by exhausting providers |
| Policy/security/content refusal | Return refusal; do not route around it | None |
| Tool execution/permission failure, uncertain tool side effect | Return through existing tool/core handling; do not treat it as a model outage | None |
| Truncation/output limit/valid finish with no further work | Existing finish handling; do not pretend it is a connection failure | None |

Unknown errors stop with diagnostic classification `unclassified`; they are not silently declared transient. Add fixtures for provider-specific business codes and prove scope. Do not use broad `catch { try next }` logic.

Use a separate bounded candidate-visit set as well as the physical-attempt set: each snapshot member may be examined/selected at most once per logical request after a preparation/admission failure. A failure before physical dispatch records a skip/preparation outcome and consumes no network-attempt count, but must not let the loop select that same broken member forever. Reusing the healthy turn pin at the next logical model step is still permitted.

After exhaustion return `GROUP_EXHAUSTED` with group ID/name/revision, invocation ID, started attempt count, ordered sanitized member outcomes, skip reasons, and earliest retry time if known. Keep a typed root cause. Do not report only the last provider's error or claim every member was attempted when some were skipped.

## 10. Health, cooldown, and accounting

One routing-state owner tracks health at endpoint/connection scope. Reasoning variants and groups using the same affected endpoint see the same endpoint outage. Member-validation issues remain member-specific.

For transient failures, consecutive failure count `n` sets:

```text
baseCooldownMs = min(60000, 5000 * 2^(min(n - 1, 4)))
effectiveCooldownMs = max(baseCooldownMs, valid provider Retry-After delay)
```

Parse numeric seconds and HTTP-date Retry-After using the existing helper or a tested standard parser. Do not cap a valid provider-directed wait to 60 seconds; cap only arithmetic to safe representable values. Implausible/malformed values produce a diagnostic and the base cooldown. Countdown uses recorded absolute expiry and monotonic remaining time in the running process.

After cooldown, allow at most one half-open attempt for that scope. Other eligible endpoints may run. A fully validated successful completion closes the circuit and resets consecutive failures; a failure reopens it. Cancellation, group deadline, and skip are neutral and release the half-open lease. No paid background probes.

Persist routing cursors, hourly usage counters, and unexpired cooldown/block state in a versioned runtime-owned ledger using existing storage. Associate persisted health with connection/config/credential generation using a non-secret revision or invalidation token; never hash or export the secret itself for telemetry. On restart, restore only matching-generation, unexpired health; other entries become unknown and require revalidation. Reconcile transient in-flight/half-open slots to zero while preserving the remaining cooldown. Persistent health must not attach an old permanent block to changed credentials/config. A storage failure is surfaced as a runtime-ledger issue; in-memory execution may continue with an explicit warning, but restart must never be reported as durable when it was not. Test these semantics.

Stats changes never increment group configuration revision. UI observes runtime state through a projection. Exports exclude runtime stats and secrets. Reset usage and Reset health are distinct explicit actions and must not affect transcript history or another authority.

Lease lifecycle:

1. Atomically validate/reserve local capacity and any half-open ticket.
2. Acquire applicable provider admission under abort/deadline governance.
3. Revalidate connection generation; release and reselect if it changed before dispatch.
4. Start physical execution and increment attempted usage once.
5. Release all leases exactly once in `finally`, including stream iterator `.return()`, consumer disconnect, aborted admission, thrown normalization errors, and shutdown.

All reservations have unique IDs. Idempotent release must not decrement twice. Late events from an aborted attempt cannot update the current pin, clear a newer failure, append content, or change current UI status. Use invocation/attempt/run/owner identities, not just the model name.

## 11. Streaming, tools, and safe recovery

Automatic failover is allowed before a committed output boundary. Reuse the adapter's actual `stream-retry-boundary.ts` semantics. In particular, non-empty text and non-empty reasoning deltas count as committed output; start/empty/prelude/partial tool-input events may be buffered as they are today. A tool call must not execute until the existing streaming tool coordinator has authorized a complete valid call.

At a pre-commit failure:

1. Abort and close the failed iterator.
2. Discard its buffered prelude and incomplete tool arguments.
3. Record its failure and release its leases.
4. Prepare the next member from the same canonical committed request input.
5. Start a new attempt with a new physical request ID but the same logical invocation ID/budget.

At a post-commit failure, the adapter/router MUST NOT blindly replay the original user prompt. Pass the failure and routing context to core recovery. Extend existing committed-anchor recovery to use another eligible group member only when core proves that:

- the failed iterator is closed and no more failed-attempt content can arrive;
- tool actions are settled, or unresolved actions force a pause;
- the canonical checkpoint contains every committed tool call and its actual result;
- no completed tool action will be re-executed by transcript reconstruction;
- discarded tail content is represented through existing recovery events, consistently in live and replay views;
- messages for the new provider are reconstructed from canonical history, not copied with foreign provider reasoning signatures;
- the new member passes fresh capability/context validation.

All safe-boundary recoveries for that logical request share its deadline, attempted-member set, and attempt budget. They are not a way to grant each failed stream another full budget. If the existing anchor recovery cannot guarantee these invariants, return `GROUP_RECOVERY_REQUIRED` and pause with a Resume action at the last valid checkpoint. Do not advertise successful automatic failover in that case.

A previous completed model step that ran tools does not forbid failover of the **next** model request. Its tool calls/results are committed history; pass them to the next member and continue the existing loop. Do not restart the whole agent turn.

Provider portability:

- Translate canonical messages/tool schema through the chosen adapter.
- Preserve tool-call/result associations; adapt provider-specific ID restrictions through existing normalization.
- Omit or safely normalize foreign encrypted reasoning blocks/signatures and cache markers using existing normalization rules. Never fabricate reasoning signatures.
- Do not copy one provider's request IDs or continuation IDs into another provider's request.
- Audit tool execution deduplication and recovery anchors across failover. An in-memory tool-call map does not prove durable exactly-once execution after a crash. Where an external action may have happened but no durable result is known, pause for reconciliation rather than automatically replaying it.

Cancellation wins every race: cancelling before dispatch prevents dispatch; cancelling while A fails prevents B from starting; cancelling a stream closes its iterator and releases leases; a stale lease/owner prohibits retry. Do not fail over because the user pressed Stop.

## 12. Main agent, subagents, workflows, and auxiliary integration

Audit and update every place that assumes a target is necessarily a `ModelSelection` or reads `.providerId` directly from session intent. Keep direct-model behavior unchanged while making group intent first-class.

Required integration:

- New-session defaults, drafts, submitted turns, queued follow-ups, guide inputs, editing/retrying/forking, persisted sessions, restore, and snapshot hydration.
- Main agent runtime and all model steps across tools.
- Workflow run settings, explicit subagent targets, profile targets/workload defaults, actor journal pins, resume/amend behavior, and model-label projections.
- Scheduled automations and saved workflow settings wherever they store/select a model.
- Bots or other entry points that use the same model-selection service.
- Auxiliary title, compaction, memory, and tool-side model calls; actual model selection and reasoning must be visible in instrumentation. Auxiliary failures follow their existing caller policy after the router's bounded outcome; a failed title must not kill an otherwise successful main turn.
- CLI/TUI and applicable list-models/model-selection tools. Group entries must be explicitly typed. Do not pass them through the concrete provider-qualified model-string parser.
- Off-peak/account plan entitlements, request-level credential sources, request admission, and usage reporting. A group cannot turn hidden restricted models into generally executable entries. Only show/add them where their existing execution context allows it; incompatible contexts get a member issue.

Existing explicit run/subagent choices must keep their documented precedence. New workload selection must not silently override an explicit existing concrete target. Group members' reasoning is part of the chosen member identity; a session-level thought control must not override all members.

## 13. UI specification

Follow `DESIGN.md`, existing components, themes, localization, and mobile interaction conventions. UI reaches services through hooks; platform operations use `IPlatformService`, not direct `window.zcode` calls.

Add **Model groups** within the existing model/provider settings navigation. Keep provider configuration and group editing linked but separate.

Group list rows show name, workload badge, strategy label, enabled state, configured/enabled/available member counts, and an issue indicator. Actions: Create, Edit, Duplicate, Enable/Disable, Export, Delete. Persist user order through the configuration owner.

Editor fields:

- Name and description.
- Enabled toggle.
- Workload level selector.
- Routing strategy selector with the definitions from section 8.
- Affinity selector: `Keep model for each turn` (default), `Choose for each request`.
- Failover toggle; attempt limit; per-request deadline, displayed in seconds/minutes while stored in milliseconds.
- Member list with provider connection, model, per-member reasoning, enabled toggle, weight when Balanced, optional local concurrency limit, availability/reason text, remove, and drag reorder plus keyboard move actions.
- Add member picker searches real configured provider/model entries. Reasoning is a dropdown of actual option values. It displays connection names so identical model IDs are distinguishable.
- Optional `Use as default for this workload level` control; this updates the same authoritative workload mapping with conflict protection.
- Save/Cancel, unsaved-change handling, inline validation, disabled Save while a write is pending, typed stale revision conflict, and useful empty states.

Do not perform a paid model test merely by opening the editor or selecting a member. Reuse existing connectivity/model-probe features only through an explicit user action with their existing behavior.

Model picker:

- Present distinct **Models** and **Model groups** sections, with search across both.
- Group entries show a group icon, workload/strategy, and eligible member count. They are selectable execution targets, not provider display categories.
- If no groups exist, show a concise Create group entry; do not obstruct direct model selection.
- Selected group remains the visible requested target during failover.
- For a group, replace the global reasoning control with `Reasoning: per member` and an Edit group action. Do not show a misleading single group reasoning level.
- Broken/disabled selections remain visible with an explanation and an actionable settings link; never silently choose a different model.

Conversation/runtime display:

- Show requested group and actual member, e.g. `heavy_models · kimi-k3 · high` using configured display names.
- Show a compact failover event, e.g. `Rate limited; switched from Kimi / high to GLM / high (attempt 2 of 3)`.
- Capacity switches, cooldown skips, and preflight incompatibility are distinguishable from failed network requests.
- Preserve actual model badges on historical responses/model steps. Do not relabel old responses after a group/model rename.
- On exhaustion show a readable collapsed summary and expandable sanitized outcomes plus Retry/Edit group actions. On unsafe recovery show checkpoint Resume, not a misleading generic Retry that repeats tool actions.
- Health view exposes in-flight requests, hourly-window attempt count, success/failure totals, cooldown, and connection/member issues. Label statistics as local to the execution authority. No invented cost or token estimates.

Use existing internationalization namespaces and languages; do not hardcode English into an otherwise localized view. Ensure keyboard operation, focus restoration, accessible labels, visible errors, theme contrast, and narrow-screen layout.

## 14. Wire protocol, persistence, and restart

Update strict shared schemas, client/service interfaces, serializers, command handlers, event projections, session/task storage, workflow journals, settings sync where applicable, and remote snapshot/replay support together.

Feature-negotiate `modelGroupsV1` through existing protocol capability/version mechanisms. A client or remote agent that does not understand group targets must get `MODEL_GROUPS_UNSUPPORTED`; it must not interpret a group ID as a model ID or silently select a member. Old direct-model records/snapshots must remain readable through the repository's normal versioned compatibility rules. Do not widen old strict schemas to accept arbitrary payloads.

New routing-event logical fields:

```text
eventId, sequence, authority/run/session/turn identity,
invocationId, attemptId, attemptOrdinal, invocationPurpose,
requestedTarget, groupId, groupRevision, memberId,
actualSelection, transitionReason, outcome,
startedAt, endedAt, sanitizedErrorCode, retryAfterAt
```

Use the existing journal sequence and event IDs for ordering/deduplication. Emit enough state for both `desktop-continuous` live operation and `web-remote-replayable` reconnect hydration to render the same pin, attempt, and outcomes. Reconnecting a UI must not itself invoke the router or restart a provider request.

Persist group intent and concrete provenance separately. Save the turn routing snapshot without credentials if needed for recovery. A process restart releases/reconciles active reservations and marks interrupted attempts as interrupted; it never resumes a half-consumed SSE stream or assumes an unjournaled tool action did not happen. A deliberate Resume starts from a valid checkpoint with a new logical invocation and explicit provenance.

Imports/exports use a versioned strict format with group definitions and optional workload mappings. Exclude secrets, endpoint config bodies, health, stats, default API keys, and transcripts. On import:

1. Parse/validate the entire document and show a preview before a settings-changing apply.
2. Resolve IDs only against the destination Host catalog; never match by model name alone.
3. New imports receive new group/member IDs. Existing groups are replaced only through an explicit user merge choice and revision guard.
4. Broken references remain visible; imported groups with unresolved enabled members are disabled until repaired.
5. Apply selected changes in one atomic configuration transaction; unsupported schema version is rejected clearly.

## 15. Telemetry, logs, and security boundaries

Record actual provider/model/reasoning for each attempt and requested group separately. Usage/token attribution uses the actual attempt, never a fake group model. If usage is unknown for a failed/aborted attempt, record unknown; do not assert zero billable usage. De-duplicate usage by physical request ID so replay does not count it twice.

Use repository loggers and appropriate log levels. Normal routing decisions/turn transitions are concise lifecycle events; high-frequency chunks remain debug. Do not log prompts, API keys, authorization headers, reasoning content, raw secret-bearing provider errors, or full group exports. Sanitize provider errors before returning them to UI/RPC.

Group CRUD/import remains within existing authenticated settings permissions. Routing events respect existing workspace/session access boundaries. Respect owner/lease and stale-run protection on every attempted transition. Do not expose another account's group config or remote authority stats through a local fallback view.

No new heavyweight proxy service, Redis, Python daemon, network scheduler, or separate LiteLLM dependency is required. Implement within the TypeScript monorepo and existing provider adapters. Add dependencies only if necessary and document the reason.

## 16. Mandatory test and acceptance matrix

Tests must execute actual policy paths with a fake clock, fake registry, fake admission, and scripted fake provider streams/generation. Local tests must not require live paid API credentials. Use the repository's actual test runners. Assert physical network request counts and concrete request options, not merely that a selector function returned a name.

Implement these scenarios, combining related tests where appropriate without omitting assertions:

| ID | Scenario | Required result |
| --- | --- | --- |
| G01 | Create/edit/reorder group and restart | IDs/settings/order/revisions persist; no credentials stored |
| G02 | Rename group used by a session | Requested target still references same ID |
| G03 | Empty/duplicate/invalid-limit/unsupported schema input | Strict rejection; no partial config write |
| G04 | Duplicate same endpoint/reasoning; different reasoning | Exact duplicate rejected; different valid reasoning allowed |
| G05 | Provider/model disappears then returns | Reference retained; issue shown; execution eligibility returns after revalidation |
| G06 | Unsupported reasoning becomes supported/unsupported | No silent rewrite; issue clears/appears based on catalog |
| G07 | Concurrent editor saves | Stale revision rejected; successful save produces one event |
| G08 | Round robin A/B/C, no affinity across turns | Six turns yield A/B/C/A/B/C |
| G09 | Round robin skips disabled/cooling B | A/C sequence; cursor stays deterministic |
| G10 | Priority A fails, B succeeds, later A healthy | B handles fallback; later fresh request prefers A |
| G11 | Least-used scores 8/2/5 | B chosen; ties use cyclic cursor |
| G12 | Balanced inFlight 2/0/1 at equal weight | B chosen; second score used only on first-score ties |
| G13 | Balanced weights 1/3 | With sequential idle requests, six reservations at initial zero usage produce two for weight 1 and four for weight 3 under the exact lexicographic rule; concurrent score and cap tests also pass |
| G14 | Concurrent equal-score reservations | Atomic updates distribute fairly; no capacity oversubscription |
| G15 | Same endpoint in two groups/reasoning variants | Shared endpoint load/usage/health; local member limits remain separate |
| G16 | Twenty-four hourly buckets and UTC boundary | Old bucket expires exactly per documented hourly window |
| G17 | A 429, B 503, C succeeds | Exactly three physical calls, correct C reasoning/options, group intent unchanged |
| G18 | All fail; attempt limit 2 with 3 members | Exactly two started calls; third not called; outcomes explain limit |
| G19 | Failover disabled | Exactly one physical request; no fallback |
| G20 | Workflow has old unbounded retry budget | Group attempts remain bounded; no hidden adapter/SDK resend |
| G21 | Empty response/off-peak/internal adapter resend paths | A group attempt never creates a second hidden completion call |
| G22 | 401 on connection X, two models on X, member on Y | X blocked; Y tried; X's second model not redundantly called |
| G23 | Structured quota/model/route errors | Correct scope, typed classification, and revalidation trigger |
| G24 | Shared malformed request or unknown programming error | Stop promptly; do not exhaust every provider |
| G25 | Refusal/security/permission error | No model-switch bypass |
| G26 | Retry-After seconds/date/malformed | Valid cooldown respected; invalid value handled deterministically |
| G27 | Cooldown expires during concurrent requests | At most one half-open probe; successful completion closes circuit |
| G28 | Credential generation changes | Old blocked health/pin not silently reused; fresh auth resolved |
| G29 | All members busy or cooling | Typed busy/cooldown error, correct retry time, no infinite queue |
| G30 | Deadline during prep/admission/stream | Abort, no next member, leases released |
| G31 | Cancel before dispatch and while A fails | No unwanted A dispatch/next B dispatch; cancellation wins |
| G32 | Iterator throws, consumer returns/disconnects | One release per lease; inFlight returns to baseline |
| G33 | Late chunk/failure from cancelled A after B starts | No content, status, pin, or health overwrite from stale event |
| G34 | Turn affinity across three model/tool steps | Same member retained, network leases released between steps |
| G35 | Request affinity across model/tool steps | Strategy applied for each request; transcript/tools preserved |
| G36 | Group edited/deleted during an admitted turn | Snapshot governs admitted turn; next turn sees new revision/deletion |
| G37 | Main vs auxiliary fallback | Title fallback does not change main turn pin |
| G38 | Member reasoning vs auxiliary lowering and UI thought setting | Exact member reasoning used; no silent bind override |
| G39 | Image/tool/JSON requirement incompatible with one member | Incompatible member skipped; no lossy input sent |
| G40 | Failover from large to smaller-context model | Fresh budget preparation; safe compaction/skip; no blind truncation |
| G41 | Before-commit stream failure after partial tool args | Buffer discarded; no incomplete tool executes; next member starts cleanly |
| G42 | Non-empty reasoning delta then failure | Classified as committed output; routed through core recovery |
| G43 | A executes file/command tool, next request fails, B continues | Existing tool result preserved; tool not rerun by router |
| G44 | Post-commit failure with valid recovery anchor | Safe next-member recovery with shared request budget and recovery events |
| G45 | Pending tool side effect uncertain | Pause `GROUP_RECOVERY_REQUIRED`; no blind replay |
| G46 | Cross-provider failover with foreign reasoning/cache/IDs | Canonical normalization produces valid request; no fake signatures |
| G47 | Restart during network request / after uncertain external action | Slots reconciled; interrupted request shown; Resume uses valid checkpoint |
| G48 | Group actor resume, explicit override, direct-model resume | Group intent preserved; explicit override precedence; legacy concrete pins still work |
| G49 | Workload mapping light/medium/heavy/custom | Correct group chosen; missing explicit mapping errors; no cross-tier fallback |
| G50 | Old direct-model stored sessions and snapshots | Versioned migration works; direct retry/selection behavior unchanged |
| G51 | Old remote capability | Clear unsupported error; no bogus model request |
| G52 | Mobile reconnect/snapshot/replay during A→B failover | One router, consistent requested/actual view, no new calls on reconnect |
| G53 | Workspace identity/owner/lease conflict | No cross-workspace state leakage or stale-run dispatch |
| G54 | Import malformed/valid/broken-reference export | Atomic import, preview, new IDs, correct disabled issue states, secret-free export |
| G55 | Delete referenced group | References shown; explicit replacement/unset; history retained |
| G56 | Usage/attempt events replay twice | No duplicate token/attempt accounting; unknown failed usage stays unknown |
| G57 | UI create→save→select→run→failover | Real end-to-end interaction; selected group remains visible with actual B badge |
| G58 | UI validation/conflict/keyboard/mobile/themes/i18n | Functional, accessible, localized, no layout obstruction |
| G59 | CLI/TUI group selection and list-models output | Typed targets work; concrete parser never receives a fake provider ID |
| G60 | Main/workflow/automation/bot/auxiliary dispatch inventory | Every applicable path audited; group targets do not crash or bypass routing |

For G13, the expected 2:4 six-request split follows this specific discrete tie-break rule; it is not a promise of exact weight ratios over every prefix. Include a larger sample proving convergence and a test where in-flight load changes the selection.

G20 must also assert that the workflow driver does not restart another group cycle after a terminal group outcome. G30/G32 must include pre-dispatch preparation and admission failures, proving candidate visits are bounded even when zero physical requests start. G47 must include generation-aware persisted cooldown restoration and a ledger-write failure.

Add model-group regression tests before implementation where practical. Inspect package manifests to run them correctly. For interaction changes, add executable E2E coverage using the repository's supported approach. If a platform cannot be exercised in this environment, document exactly what is unverified and provide a runnable scenario; do not call the feature fully validated.

## 17. Implementation order and completion gates

Implement in this sequence, keeping the branch usable at each step:

1. Repository investigation, dispatch inventory, architecture context, and written spec with diagrams.
2. Strict schemas, domain validation, configuration owner/facade, conflict handling, and versioned migration.
3. Pure deterministic eligibility/ranking tests and runtime-owned counters/reservations/cooldowns.
4. Single-physical-attempt adapter policy and group budget tests, including old unbounded workflow behavior.
5. Runtime preparation seam, turn affinity, safe failover, actual-model budgets, and streaming/tool checkpoint recovery.
6. Main/workflow/subagent/auxiliary/automation/bot integration, actor journaling, snapshots, capability negotiation, remote replay.
7. Settings/editor/picker/history/health UI, CLI/TUI, import/export, localization, accessibility.
8. Full acceptance matrix, regression checks, docs, and review of remaining assumptions.

Run at least `pnpm typecheck` and `pnpm lint`, as required by the repository, plus applicable CLI-package typechecks, actual targeted unit/integration/E2E commands, formatting checks on changed files, and the architecture checks prescribed by the current governance skill. Do not assume root typecheck covers every CLI package. Do not weaken architecture checks, modify baselines just to silence findings, remove failing tests, or use `any`/unsafe casts to conceal schema gaps.

Acceptance is complete only when:

- A user can create a real group in settings, select it, use it for actual work, and observe a controlled failover to the next usable member.
- Every attempt uses that member's exact reasoning, properties, connection, and request limits.
- Budgets prevent loops; cancellation and side-effect safety hold.
- Requested group intent, actor inheritance/resume, direct-model compatibility, restart, and remote replay are correct.
- The group config and routing state each have exactly one owner at their proper authority scope.
- No TODO, fake success, disconnected UI, hardcoded imaginary model list, silent tier escalation, or hidden provider retry remains in the shipped path.
- Required verification has passed or a concrete blocking environment limitation is explicitly reported. Existing failures are reported as existing failures, not written as passes.

## 18. Required final developer report

Provide:

1. What changed and the resulting user-visible behavior.
2. Configuration/runtime ownership and the actual routing/preparation seam used.
3. Schema/storage/protocol migrations and direct-model compatibility.
4. Exact routing, retry, cooldown, affinity, and streaming/tool recovery behavior implemented.
5. Files changed, diagrams/spec documentation, and any dependencies added.
6. Actual validation commands and results, mapped to the acceptance matrix; identify unverified platforms.
7. Any unresolved defects, design conflicts, or limits. Do not claim exactly-once external side effects or zero bugs without evidence.
8. Branch/commit information and a concise review-ready description. Open a PR only if the surrounding development task authorizes publishing one; do not merge automatically.

Do the work. Do not return only a proposal. When an implementation choice is routine, choose it consistently with this spec and the repository; when a genuine contract conflict blocks safe implementation, state the specific conflict instead of quietly shipping a different feature.
