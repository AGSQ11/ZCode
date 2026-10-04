# Subagent Model Groups

**Status:** Implemented  
**Extends:** `2026-10-02-model-groups-design.md`  
**Scope:** `packages/shared`, `packages/services`, `packages/ui`, `apps/zcode-cli` (core, bootstrap)

---

## 1. Problem

Model groups only applied to the main session turn. Subagents could only run on a
single model:

- A session whose execution target is a group has no concrete `sessionModelSelection`
  (`setSessionExecutionTarget({kind:"group"})` clears it). A subagent without its own
  model therefore failed with `Cannot start subagent: No model selected`.
- Built-in overrides, plugin overrides and custom agent Markdown could only name one model.

## 2. Product Rules

### 2.1 Subagent model intent

A subagent's model intent is exactly one of:

| Intent | Built-in / plugin override (`agents-state.json`) | Custom agent Markdown |
| --- | --- | --- |
| Inherit parent | no entry | `model` absent / `inherit` |
| Single model | `*ModelSelectionOverrides[key] = ModelSelection` | `model: provider/model` (+ `thoughtLevel`) |
| Model group | `*ModelGroupOverrides[key] = groupId` | `model: group:<groupId>` |

Model and group intents are mutually exclusive. Every write path that sets one clears
the other for the same key. If a hand-edited state file contains both, **group wins**
(it is the newer, more specific intent).

`group:<groupId>` uses the stable group id, never the display name, so renaming a group
does not break agents. Older builds read `group:<id>` as an unparseable model and fall
back to inheriting the parent, which is a safe degradation.

### 2.2 Target resolution for one subagent run

Priority order (first match wins):

1. Core Server `modelOverride`: concrete model (unchanged behavior).
2. Profile group intent: `{kind:"group", groupId}`.
3. Profile model intent: resolved through `resolveEffectiveModelSelection` (unchanged).
4. Inherit the parent session execution target:
   - parent target is a group: the child gets the same group target;
   - otherwise: the parent's active model or session selection (unchanged).
5. Nothing is available: `selection-missing` (unchanged error).

### 2.3 Group validation

At subagent start, the group is resolved against the **live** groups config. It must
exist, be enabled and have at least one enabled member. Otherwise the run fails with a
recoverable `ConfigurationError`:

`Cannot start subagent: Model group unavailable / 模型组不可用 [reason=group-unavailable; group=<id>]`

The run never silently falls back to the parent model, because that would quietly change
an explicit user choice (same principle as `resolveSubagentSelection`).

## 3. Ownership & Event Order

```text
Parent AgentRuntime (session S)                       Child AgentRuntime (subagent C)
 ├─ sessionExecutionTarget  (owner of parent intent)
 ├─ config.modelGroupsConfig (live source) ──────────► same live source (read-only)
 └─ modelGroupRouter (authorityScope = S) ───────────► SAME instance (shared accounting)

runExploreAgent(request)
  1. resolveSubagentTarget(profile, parentTarget, override)   ── §2.2
  2. if group: resolve live config → validate                  ── §2.3
  3. representative selection = parent's routed member (if the
     parent is on the same group and its active model is a member)
     else the first enabled member                            ── budget pre-shaping only
  4. new AgentRuntime(C, { executionTarget: group,
                           modelSelection: representative,
                           modelGroupsConfig: parent source },
                         { modelGroupRouter: parent router })
  5. child turn admission → prepareRoutedAttempt(group)        ── child's own turn pin
       └─ router.selectAndReserve → lease counted against S's in-flight/cooldown
```

- The router is shared, so a member's `maxInFlight`, cooldowns and 24h usage cover the
  parent and all of its subagents together. Routing state stays single-owner.
- The child keeps its own `turnPinnedMemberId`. Affinity is per runtime and per turn.
- The representative selection only shapes context budgets before the first routed
  attempt. The child's authoritative intent is its `executionTarget`.

## 4. Surfaces

- `AgentSummary` / `SubAgentConfig` / override params gain an optional `modelGroupId`.
- Settings → Subagents: the model picker lists enabled model groups alongside models.
  Picking a group writes `modelGroupId` and clears `modelSelection`, and vice versa.
  The thought-level field is hidden for groups (members carry their own levels).

## 5. Acceptance Scenarios

1. Parent targets group G; a general-purpose subagent with no override runs, routed through G.
2. Built-in Explore override = group G; the parent targets model M; Explore routes through G.
3. Custom agent `model: group:G`; G deleted or disabled → recoverable `group-unavailable` error.
4. Setting a model override after a group override clears the group, and vice versa.
5. Markdown `model: group:G` round-trips through create/update/list unchanged.
