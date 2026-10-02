# ZCode Model Groups Specification

**Status:** Implementation In Progress  
**Scope:** `packages/shared`, `packages/provider`, `packages/provider-node`, `packages/services`, `packages/ui`, `apps/zcode-cli` (contracts, core, adapters, bootstrap)  
**Authoritative Prompt:** `ZCode-model-groups-implementation-prompt.md`

---

## 1. Domain & Conceptual Model

### 1.1 Execution Target
An execution target is the primary user selection for model execution:
- `{ kind: "model", selection: ModelSelection }` (direct model target)
- `{ kind: "group", groupId: string }` (model group target)

```text
                  ┌──────────────────────┐
                  │   ExecutionTarget    │
                  └──────────┬───────────┘
                             │
            ┌────────────────┴────────────────┐
            ▼                                 ▼
   { kind: 'model' }                 { kind: 'group' }
   selection: ModelSelection         groupId: string (UUID)
```

### 1.2 Model Group & Members
A Model Group represents a set of candidate models with defined routing strategy, failover parameters, affinity, and workload level.

- Group: `{ id, revision, name, description, enabled, workloadLevel, strategy, affinity, members, failover }`
- Member: `{ id, selection: ModelSelection, enabled, weight, maxInFlight }`
- WorkloadLevel: `'light' | 'medium' | 'heavy' | 'custom'`
- RoutingStrategy: `'round_robin' | 'balanced' | 'least_used' | 'priority'`
- Affinity: `'turn' | 'request'`
- Failover: `{ enabled: boolean, maxMemberAttempts: number, requestDeadlineMs: number }`

---

## 2. State Ownership & Architecture

### 2.1 Single Owners
- **Configuration (ModelGroupsConfig):** Owned by Provider Configuration / Personal Config Repository (`packages/provider` and `packages/provider-node` via `personal-provider-config-repository.ts` storing in `provider_config.json`). Mirrored to Host/Services and UI.
- **Runtime Router State & Accounting:** Owned by the agent process authority (`ModelGroupRouter` in `apps/zcode-cli/packages/core/src/runtime/model-group/`). Tracks endpoint metrics `(authorityScope, connectionId, modelId)`:
  - `attempts24h`: 24 hourly buckets.
  - `inFlight`: active lease reservations.
  - `cooldown`: circuit breakers and retry-after timestamps.
  - `cursors`: round-robin / tie-break pointers per group.

```text
┌────────────────────────────────────────────────────────┐
│ Host / Settings / UI (packages/ui, packages/services)  │
│ - Reads/Writes ModelGroupsConfig via ProviderConfig     │
└───────────────────────────┬────────────────────────────┘
                            │ Snapshot / Sync
                            ▼
┌────────────────────────────────────────────────────────┐
│ Agent Process Runtime Authority (apps/zcode-cli)       │
│                                                        │
│  [ ModelGroupRouter / State Owner ]                    │
│   ├── Endpoint inFlight & 24h hourly buckets           │
│   ├── Cooldown & Circuit breaker state                 │
│   └── Group cursors (cyclic index)                     │
│                                                        │
│  [ prepareRoutedAttempt ]                              │
│   ├── Target resolution (model vs group)               │
│   ├── Candidate filter & deterministic ranking         │
│   ├── Lease acquisition (inFlight/admission)           │
│   └── Returns concrete Model + selection + lease       │
└────────────────────────────────────────────────────────┘
```

---

## 3. Event-Order & Lifecycle Diagrams

### 3.1 Turn / Request Routing & Failover Flow

```text
Client/Turn Request
       │
       ▼
prepareRoutedAttempt(target, invocationContext, history, requirements)
       │
       ├─ [kind == 'model'] ──► Return direct model (legacy retry behavior)
       │
       ▼ [kind == 'group']
Filter eligible members:
  - Member enabled & not attempted in this logical request
  - Provider & model enabled, credentials valid
  - Reasoning level valid & supported
  - Endpoint not in cooldown (or exactly 1 half-open ticket)
  - Under member maxInFlight and provider admission limits
  - Capabilities match (vision, tools, json, etc.)
  - Context fits without truncation
       │
       ├─ (None eligible / all busy) ──► Return GROUP_BUSY / GROUP_COOLING_DOWN
       │
       ▼
Select candidate via Strategy (priority | round_robin | least_used | balanced)
       │
       ▼
Acquire Lease (atomic inFlight reservation) & Provider Admission
       │
       ▼
Dispatch physical adapter attempt (Single Physical Attempt Policy)
       │
       ├─ Success ──► Close circuit, increment 24h bucket, release lease, return result
       │
       ▼ Failure (Pre-commit stream / Provider Error)
Classify failure:
  - Cancellation / Deadline / Refusal ──► Abort, no failover
  - Transient / 429 / 5xx / 401 / 404 ──► Cooldown affected scope
       │
       ▼ Check Failover Budget: min(maxMemberAttempts, enabledCount) & deadline
         ├─ Budget exceeded ──► GROUP_EXHAUSTED
         └─ Budget remaining ──► Loop to prepare next eligible member
```

---

## 4. Workload Level Precedence

Resolution order:
1. Explicit execution target on the turn / actor run (`ExecutionTarget`).
2. Explicit `workloadLevel` on that turn / actor / profile, resolving its configured default group.
3. Inherited target from parent / session.
4. Application default target for new sessions.
5. If explicit workloadLevel has no configured default group: `WORKLOAD_GROUP_UNAVAILABLE`.
