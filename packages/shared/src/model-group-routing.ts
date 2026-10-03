import type {
  ModelGroupMember,
  RoutingStrategy,
} from "./model-group-types.js";

/**
 * Computes the absolute request deadline from a monotonic start timestamp and a
 * relative budget. requestDeadlineMs 超出安全整数范围时按 0 处理并截断到
 * Number.MAX_SAFE_INTEGER，避免溢出后 deadline 反而落在过去导致立即超时。
 *
 * @param nowMs Monotonic timestamp (ms) at which the logical request begins.
 * @param requestDeadlineMs Relative deadline budget in ms (spec: integer 1000..1800000).
 * @returns Absolute deadline timestamp (ms), capped at Number.MAX_SAFE_INTEGER.
 */
export function computeRequestDeadlineMs(nowMs: number, requestDeadlineMs: number): number {
  const start = Number.isFinite(nowMs) ? Math.max(0, Math.floor(nowMs)) : 0;
  const budget =
    Number.isFinite(requestDeadlineMs) && requestDeadlineMs > 0
      ? Math.min(Math.floor(requestDeadlineMs), Number.MAX_SAFE_INTEGER)
      : 0;
  if (start >= Number.MAX_SAFE_INTEGER - budget) {
    return Number.MAX_SAFE_INTEGER;
  }
  return start + budget;
}

/**
 * Compares a monotonic timestamp against an absolute deadline.
 * 使用 >= 语义：到达 deadline 即视为超时，与 spec §9 的 GROUP_DEADLINE_EXCEEDED 一致；
 * 非有限或负值输入按未超时处理，避免 NaN/Infinity 比较产生歧义。
 *
 * @param nowMs Current monotonic timestamp (ms).
 * @param deadlineAt Absolute deadline timestamp (ms) from computeRequestDeadlineMs.
 * @returns true when nowMs has reached or passed deadlineAt.
 */
export function isDeadlineExceeded(nowMs: number, deadlineAt: number): boolean {
  if (!Number.isFinite(nowMs) || !Number.isFinite(deadlineAt)) return false;
  if (nowMs < 0 || deadlineAt < 0) return false;
  return nowMs >= deadlineAt;
}

export interface EndpointMetricKey {
  readonly authorityScope: string;
  readonly connectionId: string;
  readonly modelId: string;
}

export function makeEndpointKey(
  authorityScope: string,
  connectionId: string,
  modelId: string,
): string {
  return `${authorityScope}\u0000${connectionId}\u0000${modelId}`;
}

export interface MemberCapacityKey {
  readonly authorityScope: string;
  readonly groupId: string;
  readonly memberId: string;
}

export function makeMemberCapacityKey(
  authorityScope: string,
  groupId: string,
  memberId: string,
): string {
  return `${authorityScope}\u0000${groupId}\u0000${memberId}`;
}

export interface EndpointMetrics {
  inFlight: number;
  /** 24 rolling hourly buckets: index 0 is current hour, 1 is previous hour... 23 is 23h ago */
  hourlyBuckets: number[];
  currentBucketHour: number; // UTC hour timestamp in integer hours: Math.floor(Date.now() / 3600000)
  consecutiveFailures: number;
  cooldownUntil: number | null; // absolute timestamp ms
  isHalfOpen: boolean;
}

export interface MemberCandidate {
  readonly member: ModelGroupMember;
  readonly index: number;
  readonly connectionId: string;
  readonly inFlight: number;
  readonly attempts24h: number;
  readonly coolingDown: boolean;
  readonly capacityAvailable: boolean;
}

/**
 * Pure ratio comparison using integer cross-multiplication:
 * Returns negative if (n1 / d1) < (n2 / d2)
 * Returns positive if (n1 / d1) > (n2 / d2)
 * Returns 0 if equal
 */
export function compareRatios(n1: number, d1: number, n2: number, d2: number): number {
  const left = BigInt(Math.max(0, Math.floor(n1))) * BigInt(Math.max(1, Math.floor(d2)));
  const right = BigInt(Math.max(0, Math.floor(n2))) * BigInt(Math.max(1, Math.floor(d1)));
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Computes base exponential backoff cooldown in milliseconds:
 * baseCooldownMs = min(60000, 5000 * 2^(min(n - 1, 4)))
 */
export function computeBaseCooldownMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  const exp = Math.min(consecutiveFailures - 1, 4);
  return Math.min(60000, 5000 * Math.pow(2, exp));
}

/**
 * Computes effective cooldown in milliseconds, taking Retry-After into account.
 */
export function computeEffectiveCooldownMs(
  consecutiveFailures: number,
  retryAfterMs?: number | null,
): number {
  const base = computeBaseCooldownMs(consecutiveFailures);
  // Infinity/NaN/非有限值会让 cooldownUntil 变成 Infinity，单条响应就把端点
  // 永久移出路由（悬空冷却）。只接受有限值并钳到计时器安全上限。
  if (retryAfterMs !== undefined && retryAfterMs !== null && Number.isFinite(retryAfterMs)) {
    const TIMER_SAFE_MAX_DELAY_MS = 2_147_483_647;
    return Math.max(base, Math.min(Math.max(0, retryAfterMs), TIMER_SAFE_MAX_DELAY_MS));
  }
  return base;
}

/**
 * Pure deterministic ranking function for a model group and its candidates.
 *
 * @param candidates List of eligible candidates with their live metrics.
 * @param strategy The group's routing strategy.
 * @param cursorIndex The group's current cyclic cursor position (index into the group's members array).
 * @returns Ranked array of candidates (best candidate at index 0).
 */
export function rankCandidates(
  candidates: readonly MemberCandidate[],
  strategy: RoutingStrategy,
  cursorIndex: number,
  totalMemberCount: number,
): readonly MemberCandidate[] {
  if (candidates.length <= 1) return candidates;

  // 环形序号必须覆盖全组成员顺序（含不合格尾部成员）：只按合格候选推导
  // 环长会让游标距离失真，尾部成员不合格时 round_robin/平局次序与真实组顺序背离（P1）。
  const totalMembers = totalMemberCount;
  // 游标超出派生环长时距离必须仍为非负：JS % 对负操作数返回负值，会把
  // round_robin/平局次序倒序化（悬空排序）。
  const cursorDistance = (idx: number) =>
    (((idx - cursorIndex) % totalMembers) + totalMembers) % totalMembers;

  switch (strategy) {
    case "priority": {
      // Scan from index 0 every time in authoritative member order
      return [...candidates].sort((a, b) => a.index - b.index);
    }

    case "round_robin": {
      // Choose first eligible member starting from cursor position
      return [...candidates].sort((a, b) => cursorDistance(a.index) - cursorDistance(b.index));
    }

    case "least_used": {
      // Lowest attempts24h; break ties by cursor distance
      return [...candidates].sort((a, b) => {
        if (a.attempts24h !== b.attempts24h) {
          return a.attempts24h - b.attempts24h;
        }
        return cursorDistance(a.index) - cursorDistance(b.index);
      });
    }

    case "balanced": {
      // Lexicographically minimize (endpoint.inFlight / weight, endpoint.attempts24h / weight)
      // Break equal pairs by cursor distance.
      // Compare ratios by integer cross-multiplication.
      return [...candidates].sort((a, b) => {
        const inFlightCmp = compareRatios(a.inFlight, a.member.weight, b.inFlight, b.member.weight);
        if (inFlightCmp !== 0) return inFlightCmp;

        const attemptsCmp = compareRatios(
          a.attempts24h,
          a.member.weight,
          b.attempts24h,
          b.member.weight,
        );
        if (attemptsCmp !== 0) return attemptsCmp;

        return cursorDistance(a.index) - cursorDistance(b.index);
      });
    }
  }
}
