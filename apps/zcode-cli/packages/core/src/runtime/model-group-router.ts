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

      if (!member.enabled) {
        rejections.push({ memberId: member.id, reason: "member_disabled" });
        continue;
      }

      if (excludedMemberIds.has(member.id)) {
        rejections.push({ memberId: member.id, reason: "already_attempted" });
        continue;
      }

      candidateCount++;

      // Validate connection & model
      const connCheck = await this.#validateMemberConnection(member.selection);
      if (!connCheck.valid || !connCheck.connectionId) {
        rejections.push({ memberId: member.id, reason: connCheck.reason ?? "connection_unavailable" });
        continue;
      }
      const connectionId = connCheck.connectionId;
      const modelId = member.selection.modelId;

      // Check endpoint health & cooldown
      const metrics = this.getEndpointMetrics(connectionId, modelId);
      if (metrics.cooldownUntil !== null) {
        if (now < metrics.cooldownUntil) {
          anyCoolingDown = true;
          rejections.push({ memberId: member.id, reason: "circuit_cooling_down" });
          continue;
        }
        // Cooldown passed: half-open probe mode
        if (metrics.isHalfOpen) {
          anyCoolingDown = true;
          rejections.push({ memberId: member.id, reason: "circuit_half_open_in_flight" });
          continue;
        }
      }

      // Check member local maxInFlight
      const memberCapKey = makeMemberCapacityKey(this.#authorityScope, group.id, member.id);
      const currentMemberInFlight = this.#memberInFlight.get(memberCapKey) ?? 0;
      if (member.maxInFlight !== null && currentMemberInFlight >= member.maxInFlight) {
        anyBusy = true;
        rejections.push({ memberId: member.id, reason: "member_max_in_flight_exceeded" });
        continue;
      }

      const attempts24h = this.getAttempts24h(connectionId, modelId);

      eligibleCandidates.push({
        member,
        index: i,
        connectionId,
        inFlight: metrics.inFlight,
        attempts24h,
        coolingDown: false,
        capacityAvailable: true,
      });
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

    // Acquire atomic reservation lease
    const chosenMember = best.member;
    const connectionId = best.connectionId;
    const modelId = chosenMember.selection.modelId;
    const metrics = this.getEndpointMetrics(connectionId, modelId);

    metrics.inFlight++;
    metrics.hourlyBuckets[0] = (metrics.hourlyBuckets[0] ?? 0) + 1;

    const isHalfOpen = metrics.cooldownUntil !== null && now >= metrics.cooldownUntil;
    if (isHalfOpen) {
      metrics.isHalfOpen = true;
    }

    const memberCapKey = makeMemberCapacityKey(this.#authorityScope, group.id, chosenMember.id);
    const curCap = this.#memberInFlight.get(memberCapKey) ?? 0;
    this.#memberInFlight.set(memberCapKey, curCap + 1);

    // Advance cursor to position after the chosen member
    this.setGroupCursor(group.id, (best.index + 1) % group.members.length);

    const leaseId = crypto.randomUUID();
    let released = false;

    const reservation: ReservationLease = {
      leaseId,
      authorityScope: this.#authorityScope,
      groupId: group.id,
      memberId: chosenMember.id,
      connectionId,
      modelId,
      isHalfOpen,
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
