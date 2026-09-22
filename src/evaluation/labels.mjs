export const LABEL_VERSION = 'label-v1';

function numberOrNull(value, minimum = -Infinity) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum ? number : null;
}

function unknownLabel({ observedAt, horizonAt, reason, version = LABEL_VERSION }) {
  return {
    version,
    status: 'UNKNOWN',
    reason,
    label: 'UNKNOWN',
    rug: null,
    success: null,
    observedAt,
    horizonAt,
    labeledAt: horizonAt,
    cutoff: horizonAt,
    evidenceCount: 0
  };
}

export function assignLabel({
  observedAt,
  horizonAt,
  observations = [],
  baselinePrice,
  successThreshold = 2,
  rugThreshold = .5,
  version = LABEL_VERSION
} = {}) {
  const start = numberOrNull(observedAt);
  const end = numberOrNull(horizonAt);
  const baseline = numberOrNull(baselinePrice, Number.MIN_VALUE);
  const successAt = numberOrNull(successThreshold, Number.MIN_VALUE);
  const rugAt = numberOrNull(rugThreshold, 0);
  if (start === null || end === null || end < start) return unknownLabel({ observedAt: start, horizonAt: end, reason: 'INVALID_WINDOW', version });
  if (baseline === null) return unknownLabel({ observedAt: start, horizonAt: end, reason: 'MISSING_BASELINE_PRICE', version });
  if (successAt === null || rugAt === null) return unknownLabel({ observedAt: start, horizonAt: end, reason: 'INVALID_THRESHOLD', version });

  const byAt = new Map();
  for (const observation of Array.isArray(observations) ? observations : []) {
    const at = numberOrNull(observation?.at);
    const price = numberOrNull(observation?.price, Number.MIN_VALUE);
    if (at === null || price === null || at <= start || at > end) continue;
    if (byAt.has(at) && byAt.get(at) !== price) {
      return unknownLabel({ observedAt: start, horizonAt: end, reason: 'CONFLICTING_OBSERVATIONS', version });
    }
    byAt.set(at, price);
  }
  const eligible = [...byAt.entries()].sort((a, b) => a[0] - b[0]).map(([at, price]) => ({ at, price }));
  if (!eligible.length) return unknownLabel({ observedAt: start, horizonAt: end, reason: 'INSUFFICIENT_EVIDENCE', version });

  const rug = eligible.some(observation => observation.price <= baseline * rugAt);
  const success = eligible.some(observation => observation.price >= baseline * successAt);
  return {
    version,
    status: 'LABELED',
    reason: null,
    label: rug ? 'RUG' : success ? 'SUCCESS' : 'NEUTRAL',
    rug,
    success,
    observedAt: start,
    horizonAt: end,
    labeledAt: end,
    cutoff: end,
    evidenceCount: eligible.length
  };
}

export function migrateLabel(label = {}) {
  if (label.version === LABEL_VERSION) return { ...label, label: label.label || (label.rug === true ? 'RUG' : label.success === true ? 'SUCCESS' : 'UNKNOWN') };
  if (label.version && label.version !== 'label-v0') {
    throw Object.assign(new Error(`unsupported label version: ${label.version}`), { code: 'UNSUPPORTED_LABEL_VERSION' });
  }
  const horizonAt = numberOrNull(label.cutoff) ?? numberOrNull(label.horizonAt);
  const status = label.status || (label.rug === true || label.success === true ? 'LABELED' : 'UNKNOWN');
  const outcome = label.label || (label.rug === true ? 'RUG' : label.success === true ? 'SUCCESS' : 'UNKNOWN');
  return {
    ...label,
    version: LABEL_VERSION,
    status,
    label: outcome,
    cutoff: horizonAt,
    labeledAt: numberOrNull(label.labeledAt) ?? horizonAt,
    migratedFrom: label.version || 'unversioned'
  };
}
