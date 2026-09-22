import { assignLabel, LABEL_VERSION, migrateLabel } from './labels.mjs';

export const DATASET_VERSION = 'dataset-v1';
export const DEFAULT_FEATURE_KEYS = Object.freeze([
  'symbol', 'name', 'marketCap', 'liquidity', 'price', 'volume1h', 'holderCount', 'riskScore'
]);

function numberOrNull(value, minimum = -Infinity) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum ? number : null;
}

function text(value, maxLength = 160) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function eventKey(event) {
  const observedAt = numberOrNull(event?.observedAt);
  return `${text(event?.chain, 32)}:${text(event?.token?.address || event?.address, 128)}:${observedAt ?? 'invalid'}:${text(event?.eventId || event?.id, 128)}`;
}

function chooseDeterministic(current, incoming) {
  if (!current) return incoming;
  return stableStringify(incoming) >= stableStringify(current) ? incoming : current;
}

function selectFeatures(normalized, featureKeys) {
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) return {};
  return Object.fromEntries(featureKeys
    .filter(key => Object.hasOwn(normalized, key) && normalized[key] !== undefined)
    .map(key => [key, normalized[key]]));
}

function tokenAddress(event) {
  return text(event?.token?.address || event?.address, 128);
}

function tokenKey(event) {
  const chain = text(event?.chain, 32).toLowerCase();
  const address = tokenAddress(event);
  return `${chain}:${chain === 'sol' ? address : address.toLowerCase()}`;
}

function isOutcome(event) {
  return event?.stage === 'outcome' || event?.normalized?.kind === 'outcome';
}

function latestOutcome(events, cutoff) {
  return events
    .filter(event => isOutcome(event) && numberOrNull(event.observedAt) <= cutoff)
    .sort((a, b) => numberOrNull(b.observedAt) - numberOrNull(a.observedAt) || eventKey(b).localeCompare(eventKey(a)))[0] || null;
}

function outcomeSnapshot(outcome, cutoff) {
  const observations = Array.isArray(outcome?.raw?.path?.observations) ? outcome.raw.path.observations : [];
  const latest = observations.filter(row => numberOrNull(row?.at) <= cutoff)
    .sort((a, b) => numberOrNull(a.at) - numberOrNull(b.at)).at(-1);
  const baseline = numberOrNull(outcome?.raw?.baselinePrice, Number.MIN_VALUE);
  const price = numberOrNull(latest?.price, Number.MIN_VALUE);
  return {
    observations,
    baselinePrice: baseline,
    observedReturn: numberOrNull(latest?.return) ?? (baseline !== null && price !== null ? price / baseline - 1 : null),
    liquidityUsd: numberOrNull(latest?.liquidityUsd, 0),
    sells5m: numberOrNull(latest?.sells5m, 0)
  };
}

export function buildPointInTimeDataset(events, { cutoff, featureKeys = DEFAULT_FEATURE_KEYS, labelOptions = {} } = {}) {
  const cutoffAt = numberOrNull(cutoff);
  if (cutoffAt === null) throw Object.assign(new Error('invalid dataset cutoff'), { code: 'INVALID_DATASET_CUTOFF' });
  const keys = [...new Set((Array.isArray(featureKeys) ? featureKeys : [])
    .filter(key => typeof key === 'string' && key))];
  const deduplicated = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const observedAt = numberOrNull(event?.observedAt);
    if (observedAt === null || observedAt > cutoffAt || !tokenAddress(event)) continue;
    const key = eventKey(event);
    deduplicated.set(key, chooseDeterministic(deduplicated.get(key), event));
  }
  const grouped = new Map();
  for (const event of deduplicated.values()) {
    const key = tokenKey(event);
    const group = grouped.get(key) || { launches: [], outcomes: [] };
    (isOutcome(event) ? group.outcomes : group.launches).push(event);
    grouped.set(key, group);
  }
  const rows = [];
  for (const [key, group] of grouped) {
    const launch = group.launches.sort((a, b) =>
      numberOrNull(a.observedAt) - numberOrNull(b.observedAt) || eventKey(a).localeCompare(eventKey(b)))[0];
    if (!launch) continue;
    const outcome = latestOutcome(group.outcomes, cutoffAt);
    const snapshot = outcomeSnapshot(outcome, cutoffAt);
    const observedAt = numberOrNull(launch.observedAt);
    const label = assignLabel({
      observedAt,
      horizonAt: Math.min(cutoffAt, outcome ? numberOrNull(outcome.observedAt) : cutoffAt),
      observations: snapshot.observations,
      baselinePrice: snapshot.baselinePrice ?? numberOrNull(launch.normalized?.price, Number.MIN_VALUE),
      successThreshold: labelOptions.successThreshold,
      rugThreshold: labelOptions.rugThreshold
    });
    const binaryLabel = label.success === true ? 1 : label.rug === true ? 0 : null;
    rows.push({
      observedAt,
      chain: text(launch.chain, 32),
      address: tokenAddress(launch),
      features: selectFeatures(launch.normalized, keys),
      label,
      binaryLabel,
      score: numberOrNull(outcome?.normalized?.riskScore ?? launch.normalized?.riskScore),
      observedReturn: snapshot.observedReturn,
      liquidityUsd: snapshot.liquidityUsd,
      sells5m: snapshot.sells5m,
      labelVersion: label.version,
      labelAt: label.labeledAt,
      cutoff: cutoffAt,
      datasetVersion: DATASET_VERSION,
      eventKey: key
    });
  }
  return rows.sort((a, b) => a.observedAt - b.observedAt || a.eventKey.localeCompare(b.eventKey));
}

export function buildDataset(events, { cutoff, featureKeys = [], labelOptions = {} } = {}) {
  const cutoffAt = numberOrNull(cutoff);
  if (cutoffAt === null) throw Object.assign(new Error('invalid dataset cutoff'), { code: 'INVALID_DATASET_CUTOFF' });
  const keys = [...new Set((Array.isArray(featureKeys) ? featureKeys : []).filter(key => typeof key === 'string' && key))];
  const deduplicated = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const observedAt = numberOrNull(event?.observedAt);
    if (observedAt === null || observedAt > cutoffAt) continue;
    const key = eventKey(event);
    deduplicated.set(key, chooseDeterministic(deduplicated.get(key), event));
  }
  return [...deduplicated.values()]
    .sort((a, b) => numberOrNull(a.observedAt) - numberOrNull(b.observedAt) || eventKey(a).localeCompare(eventKey(b)))
    .map(event => {
      const observedAt = numberOrNull(event.observedAt);
      const label = assignLabel({
        observedAt,
        horizonAt: event.horizonAt ?? cutoffAt,
        observations: event.observations,
        baselinePrice: event.baselinePrice,
        successThreshold: labelOptions.successThreshold,
        rugThreshold: labelOptions.rugThreshold
      });
      return {
        observedAt,
        chain: text(event.chain, 32),
        address: text(event.address, 128),
        features: selectFeatures(event.normalized, keys),
        label,
        labelVersion: label.version,
        labelAt: label.labeledAt,
        cutoff: cutoffAt,
        datasetVersion: DATASET_VERSION
      };
    });
}

export function migrateDataset(rows, { cutoff } = {}) {
  const cutoffAt = numberOrNull(cutoff);
  return (Array.isArray(rows) ? rows : []).map(row => {
    const label = migrateLabel(row?.label && typeof row.label === 'object' ? row.label : {
      horizonAt: row?.horizonAt ?? cutoffAt,
      rug: row?.rug,
      success: row?.success,
      cutoff: row?.cutoff ?? cutoffAt
    });
    const migratedCutoff = numberOrNull(row?.cutoff) ?? numberOrNull(label.cutoff) ?? cutoffAt;
    return {
      observedAt: numberOrNull(row?.observedAt),
      chain: text(row?.chain, 32),
      address: text(row?.address, 128),
      features: row?.features && typeof row.features === 'object' && !Array.isArray(row.features) ? { ...row.features } : {},
      label,
      labelVersion: label.version || LABEL_VERSION,
      labelAt: numberOrNull(row?.labelAt) ?? label.labeledAt,
      cutoff: migratedCutoff,
      datasetVersion: DATASET_VERSION,
      migratedFrom: row?.datasetVersion || row?.version || 'unversioned'
    };
  });
}
