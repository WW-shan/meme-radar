import crypto from 'node:crypto';
import { estimateExecution } from './execution-model.mjs';

export const horizons = Object.freeze({ m5: 300_000, m15: 900_000, m30: 1800_000, h1: 3600_000, h2: 7200_000, h6: 21600_000, h24: 86400_000 });
export const OUTCOME_PATH_VERSION = 'outcome-path-v1';

const HORIZON_KEYS = Object.freeze(Object.keys(horizons));
const REQUIRED_SAMPLE_FIELDS = Object.freeze(['liquidityUsd', 'volume5m', 'sells5m', 'failedRead', 'sourceLatencyMs']);

function numberOrNull(value, minimum = -Infinity) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum ? number : null;
}

function positiveOrNull(value) {
  return numberOrNull(value, Number.MIN_VALUE);
}

function textOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : null;
}

function normalizeObservation(input, baselinePrice) {
  if (!input || typeof input !== 'object') return null;
  const at = numberOrNull(input.at, 0);
  if (at === null) return null;
  const rawPrice = positiveOrNull(input.price);
  const failedRead = input.failedRead === true || rawPrice === null;
  const price = failedRead ? null : rawPrice;
  const observation = {
    at,
    targetAt: numberOrNull(input.targetAt, 0),
    lagMs: numberOrNull(input.lagMs),
    collectedAt: numberOrNull(input.collectedAt, 0),
    price,
    return: failedRead || baselinePrice === null || price === null ? null : price / baselinePrice - 1,
    estimatedNetReturn: numberOrNull(input.estimatedNetReturn),
    liquidityUsd: numberOrNull(input.liquidityUsd, 0),
    volume5m: numberOrNull(input.volume5m, 0),
    sells5m: numberOrNull(input.sells5m, 0),
    failedRead,
    sourceLatencyMs: numberOrNull(input.sourceLatencyMs, 0),
    source: textOrNull(input.source),
    errorCode: textOrNull(input.errorCode) || (failedRead ? (rawPrice === null && input.failedRead !== true ? 'INVALID_PRICE' : 'READ_FAILED') : null),
    kind: textOrNull(input.kind) || 'OBSERVATION'
  };
  if (input.return !== undefined) {
    const explicitReturn = numberOrNull(input.return);
    if (!failedRead && explicitReturn !== null) observation.return = explicitReturn;
  }
  return observation;
}

function chooseObservation(current, incoming) {
  if (!current) return incoming;
  if (current.failedRead !== incoming.failedRead) return current.failedRead ? incoming : current;
  const currentCollectedAt = current.collectedAt ?? -1;
  const incomingCollectedAt = incoming.collectedAt ?? -1;
  return incomingCollectedAt >= currentCollectedAt ? incoming : current;
}

function mergeObservations(observations) {
  const merged = new Map();
  for (const observation of observations) {
    if (!observation) continue;
    const current = merged.get(observation.at);
    const next = chooseObservation(current, observation);
    if (!current) {
      merged.set(observation.at, next);
      continue;
    }
    const combined = { ...current, ...next };
    for (const field of REQUIRED_SAMPLE_FIELDS) {
      if (next[field] === null && current[field] !== null) combined[field] = current[field];
    }
    merged.set(observation.at, combined);
  }
  return [...merged.values()].sort((a, b) => a.at - b.at);
}

function baselineObservation(row) {
  const baselinePrice = positiveOrNull(row?.baselinePrice);
  const baselineAt = numberOrNull(row?.baselineAt, 0);
  if (baselinePrice === null || baselineAt === null) return null;
  return normalizeObservation({
    at: baselineAt,
    targetAt: baselineAt,
    collectedAt: baselineAt,
    price: baselinePrice,
    failedRead: false,
    kind: 'BASELINE'
  }, baselinePrice);
}

export function estimateOutcomeExecution(sample = {}, assumptions = {}) {
  const observedReturn = numberOrNull(sample.return ?? sample.observedReturn);
  const sells5m = numberOrNull(sample.sells5m, 0);
  const execution = estimateExecution({
    notionalUsd: assumptions.notionalUsd,
    liquidityUsd: sample.liquidityUsd,
    feeRate: assumptions.feeRate,
    priorityUsd: assumptions.priorityUsd,
    mevReserveRate: assumptions.mevReserveRate,
    exitLiquidityUsd: sample.exitLiquidityUsd ?? sample.liquidityUsd,
    exitDataReliable: sample.exitDataReliable === true || sells5m !== null
  });
  return {
    observedReturn,
    estimatedNetReturn: execution.estimatedNetReturn,
    execution
  };
}

export function createOutcome({
  chain = '', address = '', symbol = '', baselineAt, baselinePrice,
  initialDecision = 'X_REVIEW', latestDecision = initialDecision, latestFailed = [],
  lastAuditedAt = null, sampling = null, strategyVersion = 'radar-v3', ...extra
} = {}) {
  const at = numberOrNull(baselineAt, 0);
  const price = positiveOrNull(baselinePrice);
  if (at === null || price === null) throw Object.assign(new Error('invalid outcome baseline'), { code: 'INVALID_OUTCOME' });
  const row = {
    ...extra,
    chain,
    address,
    symbol,
    baselineAt: at,
    baselinePrice: price,
    initialDecision,
    latestDecision,
    latestFailed: Array.isArray(latestFailed) ? latestFailed : [],
    lastAuditedAt: numberOrNull(lastAuditedAt, 0),
    samples: {}
  };
  if (sampling !== null) row.sampling = sampling;
  if (strategyVersion !== null) row.strategyVersion = strategyVersion;
  return updateOutcomePath(row, []);
}

export function updateOutcomePath(row, samples = []) {
  if (!row || typeof row !== 'object') throw Object.assign(new Error('invalid outcome row'), { code: 'INVALID_OUTCOME' });
  const baselinePrice = positiveOrNull(row.baselinePrice);
  const existing = Array.isArray(row.path?.observations) ? row.path.observations : [];
  const incoming = (Array.isArray(samples) ? samples : [samples])
    .map(sample => normalizeObservation(sample, baselinePrice))
    .filter(Boolean);
  const observations = mergeObservations([
    baselineObservation(row),
    ...existing.map(sample => normalizeObservation(sample, baselinePrice)),
    ...incoming
  ]);

  let peak = baselinePrice;
  let maxDrawdown = baselinePrice === null ? null : 0;
  let firstRugAt = null;
  let observedPrices = 0;
  let failedReads = 0;
  for (const observation of observations) {
    if (observation.failedRead || observation.price === null) {
      failedReads += 1;
      continue;
    }
    observedPrices += 1;
    if (peak === null) peak = observation.price;
    else peak = Math.max(peak, observation.price);
    if (baselinePrice !== null && peak > 0) {
      maxDrawdown = Math.max(maxDrawdown ?? 0, Math.max(0, 1 - observation.price / peak));
      if (firstRugAt === null && observation.price <= baselinePrice * .5) firstRugAt = observation.at;
    }
  }

  const completed = HORIZON_KEYS.filter(key => {
    const sample = row.samples?.[key];
    return sample && sample.failedRead !== true && positiveOrNull(sample.price) !== null;
  }).length;
  const expected = HORIZON_KEYS.length;
  row.path = {
    version: OUTCOME_PATH_VERSION,
    status: completed === expected ? 'COMPLETE' : 'INCOMPLETE',
    peak,
    maxDrawdown,
    firstRugAt,
    observations,
    observedPrices,
    failedReads,
    coverage: {
      expected,
      completed,
      missing: expected - completed,
      ratio: completed / expected,
      complete: completed === expected
    }
  };
  return row;
}

export function sampleRejected(outcomes, candidate, now) {
  if (candidate.status !== 'HARD_REJECT' || !(candidate.price > 0)) return outcomes;
  if (outcomes.some(row => row.address === candidate.address)) return outcomes;
  // Stable 1-in-5 sampling, independent of subsequent returns or popularity.
  const hash = crypto.createHash('sha256').update(`${candidate.chain}:${candidate.address}`).digest();
  if (hash[0] % 5 || outcomes.filter(row => row.initialDecision === 'HARD_REJECT').length >= 200) return outcomes;
  outcomes.push(createOutcome({
    chain: candidate.chain,
    address: candidate.address,
    symbol: candidate.symbol,
    baselineAt: now,
    baselinePrice: candidate.price,
    initialDecision: 'HARD_REJECT',
    latestDecision: candidate.status,
    latestFailed: candidate.deep?.failed || [],
    sampling: 'SHA256_MOD5',
    strategyVersion: 'radar-v3'
  }));
  return outcomes;
}

export function dueOutcomeJobs(outcomes, now) {
  return outcomes.flatMap(row => Object.entries(horizons).filter(([key, duration]) =>
    !row.samples?.[key] && now >= row.baselineAt + duration + 60_000
    && now >= (row.sampleRetries?.[key]?.nextAt || 0)
  ).map(([key, duration]) => ({ row, key, targetAt: row.baselineAt + duration })))
    .sort((a, b) => (a.row.sampleRetries?.[a.key]?.attempts || 0) - (b.row.sampleRetries?.[b.key]?.attempts || 0) || a.targetAt - b.targetAt);
}

export async function collectOutcomeSamples(outcomes, gmgn, chain, { limit = 4, now = Date.now, deadline = Infinity } = {}) {
  if (typeof gmgn.priceAt !== 'function') return outcomes;
  for (const job of dueOutcomeJobs(outcomes, now()).slice(0, limit)) {
    if (now() >= deadline || gmgn.disabled || gmgn.nextAllowedAt > now()) break;
    const { row, key, targetAt } = job;
    const readStartedAt = now();
    let sample, errorCode = 'NO_CANDLE';
    try {
      sample = await gmgn.priceAt(row.address, targetAt, row.chain || chain);
    } catch (error) {
      errorCode = error?.code === 'GMGN_RATE_LIMITED' ? 'RATE_LIMITED' : 'READ_FAILED';
    }
    const sourceLatencyMs = Math.max(0, now() - readStartedAt);
    row.samples ||= {};
    row.sampleRetries ||= {};
    if (sample && Number.isFinite(sample.price) && sample.price > 0 && row.baselinePrice > 0
      && Number.isFinite(sample.at) && Math.abs(sample.at - targetAt) <= 60_000 && sample.at <= now()) {
      const observation = {
        ...sample,
        targetAt,
        lagMs: sample.at - targetAt,
        collectedAt: now(),
        return: sample.price / row.baselinePrice - 1,
        liquidityUsd: sample.liquidityUsd ?? null,
        volume5m: sample.volume5m ?? null,
        sells5m: sample.sells5m ?? null,
        failedRead: false,
        sourceLatencyMs
      };
      row.samples[key] = observation;
      delete row.sampleRetries[key];
      updateOutcomePath(row, [observation]);
    } else {
      const attempts = (row.sampleRetries[key]?.attempts || 0) + 1;
      row.sampleRetries[key] = { attempts, code: errorCode, nextAt: now() + Math.min(3600_000, 120_000 * 2 ** Math.min(attempts - 1, 5)) };
      updateOutcomePath(row, [{
        at: now(), targetAt, lagMs: now() - targetAt, collectedAt: now(),
        price: null, liquidityUsd: null, volume5m: null, sells5m: null,
        failedRead: true, sourceLatencyMs, errorCode
      }]);
    }
    if (errorCode === 'RATE_LIMITED') break;
  }
  return outcomes;
}

export function outcomeCoverage(outcomes, now = Date.now()) {
  const cohort = decision => {
    const rows = outcomes.filter(row => row.initialDecision === decision);
    return Object.fromEntries(Object.entries(horizons).map(([key, duration]) => {
      const eligible = rows.filter(row => now >= row.baselineAt + duration);
      const samples = eligible.map(row => row.samples?.[key])
        .filter(sample => sample && sample.failedRead !== true && positiveOrNull(sample.price) !== null);
      const values = samples.map(sample => numberOrNull(sample.return)).filter(value => value !== null).sort((a, b) => a - b);
      const n = values.length;
      return [key, {
        eligible: eligible.length,
        completed: n,
        missing: eligible.length - n,
        failedReads: eligible.filter(row => row.sampleRetries?.[key] && !row.samples?.[key]).length,
        median: n ? (values[Math.floor((n - 1) / 2)] + values[Math.floor(n / 2)]) / 2 : null,
        positiveRate: n ? values.filter(x => x > 0).length / n : null
      }];
    }));
  };
  return { passed: cohort('X_REVIEW'), rejected: cohort('HARD_REJECT') };
}
