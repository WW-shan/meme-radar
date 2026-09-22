import { assignLabel, LABEL_VERSION, migrateLabel } from './labels.mjs';

export const DATASET_VERSION = 'dataset-v1';

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
  return `${text(event?.chain, 32)}:${text(event?.address, 128)}:${observedAt ?? 'invalid'}:${text(event?.id, 128)}`;
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
