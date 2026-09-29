// 模型健康探测（dsh-model-probe 的原生移植）：类型与健康状态机均为纯函数，
// 供 bootstrap 引擎与 UI 展示层共用；本文件不依赖任何运行时或进程 API。

// 状态与来源的枚举值表共享给协议层（z.enum 复用同一数组），避免两处定义漂移。
export const MODEL_PROBE_STATUSES = ["alive", "dead", "unknown"] as const;

export type ModelProbeStatus = (typeof MODEL_PROBE_STATUSES)[number];

export const MODEL_PROBE_SOURCES = [
  "manual-probe",
  "observed-failure",
  "observed-success",
  "scheduled-recheck",
] as const;

export interface ModelProbeKey {
  readonly providerId: string;
  readonly modelId: string;
}

export interface ModelProbeOutcome {
  readonly ok: boolean;
  /** 墙钟毫秒。 */
  readonly checkedAt: number;
  readonly latencyMs?: number;
  readonly ttftMs?: number;
  readonly error?: string;
}

export interface ModelProbeOutcomeRecord extends ModelProbeOutcome {
  readonly source: (typeof MODEL_PROBE_SOURCES)[number];
}

export interface ModelProbeEntry extends ModelProbeKey {
  readonly status: ModelProbeStatus;
  readonly lastCheckedAt?: number;
  readonly latencyMs?: number;
  readonly ttftMs?: number;
  readonly lastError?: string;
  /** 当前故障验证已计入的失败次数；成功后清零。 */
  readonly attemptCount: number;
  /** Dead 模型的下一次后台复查墙钟毫秒；其余状态 undefined。 */
  readonly nextRetryAt?: number;
  /** 有界历史：最新 500 条 outcome，尾部追加。 */
  readonly history: readonly ModelProbeOutcomeRecord[];
}

export const MODEL_PROBE_HISTORY_LIMIT = 500;

export const MODEL_PROBE_DEFAULTS = {
  /** 手工/观察探测的判定阈值：初次失败 + 2 次健康重试。 */
  failureThreshold: 3,
  /** Dead 模型后台复查间隔。 */
  deadRecheckIntervalMs: 30 * 60 * 1000,
  /** 单次探测超时。 */
  probeTimeoutMs: 30_000,
  /** Probe all 的并发上限。 */
  concurrency: 4,
} as const;

export function createProbeEntry(key: ModelProbeKey): ModelProbeEntry {
  return {
    providerId: key.providerId,
    modelId: key.modelId,
    status: "unknown",
    attemptCount: 0,
    history: [],
  };
}

function withHistory(entry: ModelProbeEntry, record: ModelProbeOutcomeRecord): ModelProbeEntry {
  const history = [...entry.history, record].slice(-MODEL_PROBE_HISTORY_LIMIT);
  return { ...entry, history };
}

function reschedule(entry: ModelProbeEntry, checkedAt: number): ModelProbeEntry {
  return {
    ...entry,
    nextRetryAt: checkedAt + MODEL_PROBE_DEFAULTS.deadRecheckIntervalMs,
  };
}

/**
 * 内部实现：outcome 携带显式 source 落入账本。失败达到阈值即判 Dead 并安排复查；
 * 未达阈值保持当前状态继续重试。成功立即 Alive。
 */
function applyOutcome(
  entry: ModelProbeEntry,
  outcome: ModelProbeOutcome,
  source: ModelProbeOutcomeRecord["source"],
): ModelProbeEntry {
  const recorded = withHistory(entry, { ...outcome, source });
  if (outcome.ok) {
    return {
      ...recorded,
      status: "alive",
      attemptCount: 0,
      lastCheckedAt: outcome.checkedAt,
      latencyMs: outcome.latencyMs,
      ttftMs: outcome.ttftMs,
      lastError: undefined,
      nextRetryAt: undefined,
    };
  }
  const attemptCount = entry.attemptCount + 1;
  const dead = attemptCount >= MODEL_PROBE_DEFAULTS.failureThreshold;
  const next: ModelProbeEntry = {
    ...recorded,
    // 修复依据：计划原文此处为 `dead ? "dead" : entry.status === "dead" ? "dead" : "unknown"`，
    // 会把未达阈值（如 Alive 模型的首次失败）降级为 unknown，与本函数"未达阈值保持当前状态
    // 继续重试"的文档注释及行为测试矛盾；Dead 条目必然满足 attemptCount >= 阈值、已走
    // dead 分支，故失败未达阈值时保持 entry.status 不变即可。
    status: dead ? "dead" : entry.status,
    attemptCount,
    lastCheckedAt: outcome.checkedAt,
    lastError: outcome.error,
    latencyMs: entry.latencyMs,
    ttftMs: entry.ttftMs,
  };
  return dead ? reschedule(next, outcome.checkedAt) : next;
}

/**
 * 探测结果（手工探测、计划复查）落入账本，按当前状态推断来源：
 * Dead 条目的失败视为后台复查结果，其余视为手工探测。
 */
export function applyProbeOutcome(
  entry: ModelProbeEntry,
  outcome: ModelProbeOutcome,
): ModelProbeEntry {
  const source: ModelProbeOutcomeRecord["source"] =
    entry.status === "dead" ? "scheduled-recheck" : "manual-probe";
  return applyOutcome(entry, outcome, source);
}

/** 正常会话内的模型请求终止性失败：算初次失败；健康重试由引擎调度，失败逐次计入。 */
export function applyObservedFailure(entry: ModelProbeEntry, checkedAt: number): ModelProbeEntry {
  return applyOutcome(
    entry,
    { ok: false, checkedAt, error: "observed model error" },
    "observed-failure",
  );
}

/** 正常会话内模型请求成功：立即复活。 */
export function applyObservedSuccess(
  entry: ModelProbeEntry,
  checkedAt: number,
  latencyMs?: number,
): ModelProbeEntry {
  return applyOutcome(entry, { ok: true, checkedAt, latencyMs }, "observed-success");
}

/** 用户主动取消/中止不算模型死亡；不进入账本历史。 */
export function applyObservedAbort(entry: ModelProbeEntry, _checkedAt: number): ModelProbeEntry {
  return entry;
}
