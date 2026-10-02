import type {
  ExecutionTarget,
  ModelGroup,
  ModelGroupMember,
  ModelGroupsConfig,
  WorkloadLevel,
} from "@zcode/shared/model-group-types";
import {
  makeEndpointKey,
  makeMemberCapacityKey,
  rankCandidates,
  computeEffectiveCooldownMs,
  type EndpointMetrics,
  type MemberCandidate,
} from "@zcode/shared/model-group-routing";
import type { ModelSelection } from "@zcode/contracts";

export interface CandidateRejection {
  readonly memberId: string;
  readonly reason: string;
}

export interface ReservationLease {
  readonly leaseId: string;
  readonly authorityScope: string;
  readonly groupId: string;
  readonly memberId: string;
  readonly connectionId: string;
  readonly modelId: string;
  readonly isHalfOpen: boolean;
  /**
   * Marks the attempt as physically dispatched. Increments the endpoint's
   * current-hour attempts bucket exactly once; later calls are no-ops.
   * Spec §8: attempts24h increments on physical request execution beginning
   * after local admission - never at reservation time.
   */
  markDispatched(): void;
  release(outcome: "success" | "transient_failure" | "terminal_failure" | "cancelled" | "neutral", retryAfterMs?: number | null): void;
}

export interface RoutedAttempt {
  readonly selection: ModelSelection;
  readonly groupId: string;
  readonly groupRevision: number;
  readonly memberId: string;
  readonly attemptNumber: number;
  readonly maxAttempts: number;
  readonly deadlineMs: number;
  readonly reservation: ReservationLease;
}

export interface ModelGroupRouterOptions {
  readonly authorityScope: string;
  readonly getGroupsConfig: () => Promise<ModelGroupsConfig | undefined>;
  readonly validateMemberConnection: (selection: ModelSelection) => Promise<{
    valid: boolean;
    connectionId?: string;
    reason?: string;
  }>;
  readonly now?: () => number;
}

export class ModelGroupRouter {
  readonly #authorityScope: string;
  readonly #getGroupsConfig: () => Promise<ModelGroupsConfig | undefined>;
  readonly #validateMemberConnection: (selection: ModelSelection) => Promise<{
    valid: boolean;
    connectionId?: string;
    reason?: string;
  }>;
  readonly #now: () => number;

  /** Endpoint metrics: keyed by makeEndpointKey(authorityScope, connectionId, modelId) */
  readonly #endpointMetrics = new Map<string, EndpointMetrics>();

  /** Group cursors: keyed by groupId -> number */
  readonly #groupCursors = new Map<string, number>();

  /** Active local member in-flight count: keyed by makeMemberCapacityKey(authorityScope, groupId, memberId) -> number */
  readonly #memberInFlight = new Map<string, number>();

  constructor(options: ModelGroupRouterOptions) {
    this.#authorityScope = options.authorityScope;
    this.#getGroupsConfig = options.getGroupsConfig;
    this.#validateMemberConnection = options.validateMemberConnection;
    this.#now = options.now ?? (() => Date.now());
  }

  getEndpointMetrics(connectionId: string, modelId: string): EndpointMetrics {
    const key = makeEndpointKey(this.#authorityScope, connectionId, modelId);
    let m = this.#endpointMetrics.get(key);
    if (!m) {
      m = {
        inFlight: 0,
        hourlyBuckets: new Array(24).fill(0),
        currentBucketHour: Math.floor(this.#now() / 3600000),
        consecutiveFailures: 0,
        cooldownUntil: null,
        isHalfOpen: false,
      };
      this.#endpointMetrics.set(key, m);
    } else {
      this.#rollBuckets(m);
    }
    return m;
  }

  #rollBuckets(m: EndpointMetrics): void {
    const currentHour = Math.floor(this.#now() / 3600000);
    const diff = currentHour - m.currentBucketHour;
    if (diff > 0) {
      if (diff >= 24) {
        m.hourlyBuckets.fill(0);
      } else {
        for (let i = 0; i < diff; i++) {
          m.hourlyBuckets.pop();
          m.hourlyBuckets.unshift(0);
        }
      }
      m.currentBucketHour = currentHour;
    }
  }

  getAttempts24h(connectionId: string, modelId: string): number {
    const m = this.getEndpointMetrics(connectionId, modelId);
    return m.hourlyBuckets.reduce((acc, count) => acc + count, 0);
  }

  getGroupCursor(groupId: string): number {
    return this.#groupCursors.get(groupId) ?? 0;
  }

  setGroupCursor(groupId: string, cursor: number): void {
    this.#groupCursors.set(groupId, cursor);
  }

  /**
   * Runs the eligibility gate for a single member against live state.
   * selectAndReserve 与 reservePinnedMember 共用同一套准入检查，保证 pin 路径
   * 与策略路径的 cooldown/half-open/容量语义一致（P1-2）。
   * Returns the enriched candidate when eligible, or a rejection reason.
   */
  async #checkMemberEligibility(
    group: ModelGroup,
    member: ModelGroupMember,
    index: number,
    now: number,
  ): Promise<
    | { ok: true; candidate: MemberCandidate }
    | { ok: false; reason: string; coolingDown: boolean; busy: boolean }
  > {
    if (!member.enabled) {
      return { ok: false, reason: "member_disabled", coolingDown: false, busy: false };
    }

    // Validate connection & model
    const connCheck = await this.#validateMemberConnection(member.selection);
    if (!connCheck.valid || !connCheck.connectionId) {
      return {
        ok: false,
        reason: connCheck.reason ?? "connection_unavailable",
        coolingDown: false,
        busy: false,
      };
    }
    const connectionId = connCheck.connectionId;
    const modelId = member.selection.modelId;

    // Check endpoint health & cooldown
    const metrics = this.getEndpointMetrics(connectionId, modelId);
    if (metrics.cooldownUntil !== null) {
      if (now < metrics.cooldownUntil) {
        return { ok: false, reason: "circuit_cooling_down", coolingDown: true, busy: false };
      }
      // Cooldown passed: half-open probe mode
      if (metrics.isHalfOpen) {
        return { ok: false, reason: "circuit_half_open_in_flight", coolingDown: true, busy: false };
      }
    }

    // Check member local maxInFlight
    const memberCapKey = makeMemberCapacityKey(this.#authorityScope, group.id, member.id);
    const currentMemberInFlight = this.#memberInFlight.get(memberCapKey) ?? 0;
    if (member.maxInFlight !== null && currentMemberInFlight >= member.maxInFlight) {
      return { ok: false, reason: "member_max_in_flight_exceeded", coolingDown: false, busy: true };
    }

    const attempts24h = this.getAttempts24h(connectionId, modelId);

    return {
      ok: true,
      candidate: {
        member,
        index,
        connectionId,
        inFlight: metrics.inFlight,
        attempts24h,
        coolingDown: false,
        capacityAvailable: true,
      },
    };
  }

  /**
   * Acquires the atomic reservation lease for an already-chosen member:
   * endpoint inFlight++, member capacity++, half-open probe marking, and a
   * working release(). 绝不触碰 group cursor -- 只有策略路由才有权推进游标（P1-2）。
   * attempts24h 不再在预留时自增，改由 ReservationLease.markDispatched() 在物理
   * 派发前恰好自增一次（P1-3，spec §8：skip/cancel before execution 不计数）。
   */
  #acquireLease(
    group: ModelGroup,
    member: ModelGroupMember,
    connectionId: string,
    now: number,
  ): ReservationLease {
    const modelId = member.selection.modelId;
    const metrics = this.getEndpointMetrics(connectionId, modelId);

    metrics.inFlight++;

    const isHalfOpen = metrics.cooldownUntil !== null && now >= metrics.cooldownUntil;
    if (isHalfOpen) {
      metrics.isHalfOpen = true;
    }

    const memberCapKey = makeMemberCapacityKey(this.#authorityScope, group.id, member.id);
    const curCap = this.#memberInFlight.get(memberCapKey) ?? 0;
    this.#memberInFlight.set(memberCapKey, curCap + 1);

    const leaseId = crypto.randomUUID();
    let released = false;
    let dispatched = false;

    return {
      leaseId,
      authorityScope: this.#authorityScope,
      groupId: group.id,
      memberId: member.id,
      connectionId,
      modelId,
      isHalfOpen,
      markDispatched: () => {
        // P1-3: attempts24h 仅在物理请求真正开始执行后自增，且恰好一次。
        if (dispatched) return;
        dispatched = true;
        metrics.hourlyBuckets[0] = (metrics.hourlyBuckets[0] ?? 0) + 1;
      },
      release: (outcome, retryAfterMs) => {
        if (released) return;
        released = true;

        metrics.inFlight = Math.max(0, metrics.inFlight - 1);
        const cur = this.#memberInFlight.get(memberCapKey) ?? 1;
        this.#memberInFlight.set(memberCapKey, Math.max(0, cur - 1));

        if (outcome === "success") {
          // Closed circuit, reset consecutive failures
          metrics.consecutiveFailures = 0;
          metrics.cooldownUntil = null;
          metrics.isHalfOpen = false;
        } else if (outcome === "transient_failure") {
          // Open or re-trip circuit
          metrics.consecutiveFailures++;
          const cooldownMs = computeEffectiveCooldownMs(metrics.consecutiveFailures, retryAfterMs);
          metrics.cooldownUntil = this.#now() + cooldownMs;
          metrics.isHalfOpen = false;
        } else if (outcome === "terminal_failure") {
          // Terminal failure: hold off endpoint
          metrics.consecutiveFailures++;
          metrics.cooldownUntil = this.#now() + 60000;
          metrics.isHalfOpen = false;
        } else {
          // cancelled or neutral (deadline/abort): release half-open probe if applicable
          if (isHalfOpen) {
            metrics.isHalfOpen = false;
          }
        }
      },
    };
  }

  /**
   * Reserves a pinned member (turn-affinity reuse) WITHOUT touching the group's
   * round-robin cursor. Performs the same eligibility checks as selectAndReserve
   * (member enabled, connection validation, cooldown/half-open gate, member
   * maxInFlight capacity) and acquires the same lease shape.
   *
   * P1-2: turn-model.ts 此前用单成员假组调用 selectAndReserve，末尾的
   * setGroupCursor(group.id, (0 + 1) % 1 = 0) 每次 pin 复用都会把真实组的
   * 游标静默重置为 0，破坏 round_robin/平局打破语义，故提供此专用方法。
   */
  async reservePinnedMember(
    group: ModelGroup,
    member: ModelGroupMember,
  ): Promise<{
    routedAttempt?: {
      member: ModelGroupMember;
      attemptNumber: number;
      reservation: ReservationLease;
    };
    rejections: CandidateRejection[];
    allCoolingDown: boolean;
    allBusy: boolean;
  }> {
    const now = this.#now();
    // pin 目标必须仍属于当前组快照；找不到时按索引 0 处理（仅影响候选 index 字段，
    // 不影响任何游标语义，因为本方法不写游标）。
    const index = group.members.findIndex((m) => m.id === member.id);
    const effectiveIndex = index >= 0 ? index : 0;

    const eligibility = await this.#checkMemberEligibility(group, member, effectiveIndex, now);
    if (!eligibility.ok) {
      return {
        rejections: [{ memberId: member.id, reason: eligibility.reason }],
        allCoolingDown: eligibility.coolingDown,
        allBusy: eligibility.busy,
      };
    }

    const reservation = this.#acquireLease(group, member, eligibility.candidate.connectionId, now);

    return {
      routedAttempt: {
        member,
        attemptNumber: 1,
        reservation,
      },
      rejections: [],
      allCoolingDown: false,
      allBusy: false,
    };
  }

  /**
   * Evaluates candidates, ranks them according to group strategy, and acquires atomic reservation.
   */
  async selectAndReserve(
    group: ModelGroup,
    excludedMemberIds: ReadonlySet<string>,
  ): Promise<{
    routedAttempt?: {
      member: ModelGroupMember;
      attemptNumber: number;
      reservation: ReservationLease;
    };
    rejections: CandidateRejection[];
    allCoolingDown: boolean;
    allBusy: boolean;
  }> {
    const rejections: CandidateRejection[] = [];
    const eligibleCandidates: MemberCandidate[] = [];
    const now = this.#now();

    let anyCoolingDown = false;
    let anyBusy = false;
    let candidateCount = 0;

    for (let i = 0; i < group.members.length; i++) {
      const member = group.members[i];
      if (!member) continue;

      if (excludedMemberIds.has(member.id)) {
        rejections.push({ memberId: member.id, reason: "already_attempted" });
        continue;
      }

      candidateCount++;

      const eligibility = await this.#checkMemberEligibility(group, member, i, now);
      if (!eligibility.ok) {
        if (eligibility.coolingDown) anyCoolingDown = true;
        if (eligibility.busy) anyBusy = true;
        rejections.push({ memberId: member.id, reason: eligibility.reason });
        continue;
      }

      eligibleCandidates.push(eligibility.candidate);
    }

    if (eligibleCandidates.length === 0) {
      return {
        rejections,
        allCoolingDown: anyCoolingDown && candidateCount > 0,
        allBusy: anyBusy && candidateCount > 0,
      };
    }

    const currentCursor = this.getGroupCursor(group.id);
    const ranked = rankCandidates(eligibleCandidates, group.strategy, currentCursor);
    const best = ranked[0];
    if (!best) {
      return { rejections, allCoolingDown: false, allBusy: false };
    }

    const chosenMember = best.member;
    const reservation = this.#acquireLease(group, chosenMember, best.connectionId, now);

    // Advance cursor to position after the chosen member -- 仅策略路径允许推进游标；
    // pin 路径走 reservePinnedMember，不写游标（P1-2）。
    this.setGroupCursor(group.id, (best.index + 1) % group.members.length);

    return {
      routedAttempt: {
        member: chosenMember,
        attemptNumber: excludedMemberIds.size + 1,
        reservation,
      },
      rejections,
      allCoolingDown: false,
      allBusy: false,
    };
  }
}
