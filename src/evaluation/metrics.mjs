import { estimateExecution } from '../execution-model.mjs';

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function labelOrNull(value) {
  if (value && typeof value === 'object') {
    // Rug precedence keeps a pumped-then-dumped token in the sample as a
    // negative instead of silently dropping the worst outcomes.
    if (value.rug === true) return 0;
    if (value.success === true) return 1;
    return null;
  }
  if (value === true || value === 1 || value === '1') return 1;
  if (value === false || value === 0 || value === '0') return 0;
  return null;
}

function rounded(value) {
  return value === null || value === undefined ? null : Math.round(value * 1e12) / 1e12;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
}

function calibrationBuckets(rows, bins) {
  const buckets = Array.from({ length: bins }, (_, index) => ({
    index,
    min: index / bins,
    max: index === bins - 1 ? 1 : (index + 1) / bins,
    count: 0,
    confidence: null,
    accuracy: null,
    gap: null
  }));
  for (const row of rows) {
    const index = Math.min(bins - 1, Math.floor(row.score * bins));
    const bucket = buckets[index];
    bucket.count += 1;
    bucket._confidenceSum = (bucket._confidenceSum || 0) + row.score;
    bucket._labelSum = (bucket._labelSum || 0) + row.label;
  }
  for (const bucket of buckets) {
    if (!bucket.count) continue;
    bucket.confidence = bucket._confidenceSum / bucket.count;
    bucket.accuracy = bucket._labelSum / bucket.count;
    bucket.gap = Math.abs(bucket.confidence - bucket.accuracy);
    delete bucket._confidenceSum;
    delete bucket._labelSum;
  }
  return buckets;
}

function averagePrecision(rows, positiveCount) {
  if (!positiveCount || !rows.length) return null;
  const ranked = [...rows].sort((a, b) => b.score - a.score || a._index - b._index);
  let truePositives = 0;
  let falsePositives = 0;
  let previousRecall = 0;
  let area = 0;
  for (let index = 0; index < ranked.length;) {
    const score = ranked[index].score;
    const scoreGroup = [];
    while (index < ranked.length && ranked[index].score === score) scoreGroup.push(ranked[index++]);
    for (const row of scoreGroup) {
      if (row.label === 1) truePositives += 1;
      else falsePositives += 1;
    }
    const recall = truePositives / positiveCount;
    const precision = truePositives + falsePositives ? truePositives / (truePositives + falsePositives) : null;
    if (precision !== null) area += (recall - previousRecall) * precision;
    previousRecall = recall;
  }
  return area;
}

export function evaluateClassification(rows, { threshold = .5, bins = 10 } = {}) {
  const input = Array.isArray(rows) ? rows : [];
  const cutoff = finiteOrNull(threshold);
  if (cutoff === null || cutoff < 0 || cutoff > 1) throw Object.assign(new Error('invalid threshold'), { code: 'INVALID_THRESHOLD' });
  const binCount = Number.isInteger(bins) && bins > 0 ? bins : 10;
  const valid = [];
  let missingScores = 0;
  let missingLabels = 0;
  let invalidScores = 0;
  let invalidLabels = 0;
  input.forEach((row, index) => {
    const rawScore = row?.score;
    const score = finiteOrNull(rawScore);
    const label = labelOrNull(row?.label);
    if (score === null) {
      if (rawScore === null || rawScore === undefined || rawScore === '') missingScores += 1;
      else invalidScores += 1;
    } else if (score < 0 || score > 1) {
      invalidScores += 1;
    }
    if (label === null) {
      if (row?.label === null || row?.label === undefined || row?.label === '') missingLabels += 1;
      else invalidLabels += 1;
    }
    if (score !== null && score >= 0 && score <= 1 && label !== null) valid.push({ ...row, score, label, _index: index });
  });

  const positiveCount = valid.filter(row => row.label === 1).length;
  const negativeCount = valid.length - positiveCount;
  const predictedPositive = valid.filter(row => row.score >= cutoff);
  const truePositives = predictedPositive.filter(row => row.label === 1).length;
  const falsePositives = predictedPositive.length - truePositives;
  const falseNegatives = positiveCount - truePositives;
  const trueNegatives = negativeCount - falsePositives;
  const buckets = calibrationBuckets(valid, binCount);
  const expectedCalibrationError = valid.length
    ? buckets.reduce((sum, bucket) => sum + (bucket.gap === null ? 0 : bucket.gap * bucket.count), 0) / valid.length
    : null;
  const maximumCalibrationError = valid.length
    ? Math.max(...buckets.filter(bucket => bucket.gap !== null).map(bucket => bucket.gap))
    : null;
  const brierScore = valid.length
    ? average(valid.map(row => (row.score - row.label) ** 2))
    : null;

  return {
    sampleCount: valid.length,
    totalCount: input.length,
    positiveCount,
    negativeCount,
    missingScores,
    missingLabels,
    invalidScores,
    invalidLabels,
    coverage: input.length ? valid.length / input.length : null,
    threshold: cutoff,
    precision: rounded(predictedPositive.length ? truePositives / predictedPositive.length : null),
    recall: rounded(positiveCount ? truePositives / positiveCount : null),
    auprc: rounded(averagePrecision(valid, positiveCount)),
    brierScore: rounded(brierScore),
    expectedCalibrationError: rounded(expectedCalibrationError),
    maximumCalibrationError: rounded(maximumCalibrationError),
    calibrationBins: buckets,
    confusionMatrix: { truePositives, falsePositives, falseNegatives, trueNegatives }
  };
}

export const classificationMetrics = evaluateClassification;

export function evaluateEconomicMetrics(rows, assumptions = {}) {
  const input = Array.isArray(rows) ? rows : [];
  const observedReturns = [];
  const estimatedReturns = [];
  let missingObservedReturns = 0;
  let missingEstimates = 0;
  for (const row of input) {
    const observedReturn = finiteOrNull(row?.observedReturn ?? row?.return);
    if (observedReturn === null) missingObservedReturns += 1;
    else observedReturns.push(observedReturn);

    const liquidityUsd = finiteOrNull(row?.liquidityUsd ?? row?.liquidity);
    const sells5m = finiteOrNull(row?.sells5m ?? row?.sells);
    const execution = estimateExecution({
      notionalUsd: assumptions.notionalUsd,
      liquidityUsd,
      feeRate: assumptions.feeRate,
      priorityUsd: assumptions.priorityUsd,
      mevReserveRate: assumptions.mevReserveRate,
      exitLiquidityUsd: row?.exitLiquidityUsd ?? liquidityUsd,
      exitDataReliable: row?.exitDataReliable === true || sells5m !== null
    });
    if (execution.estimatedNetReturn === null) missingEstimates += 1;
    else estimatedReturns.push(execution.estimatedNetReturn);
  }
  return {
    sampleCount: input.length,
    observedReturn: average(observedReturns),
    estimatedNetReturn: average(estimatedReturns),
    medianObservedReturn: median(observedReturns),
    medianEstimatedNetReturn: median(estimatedReturns),
    observedCoverage: input.length ? observedReturns.length / input.length : null,
    estimatedCoverage: input.length ? estimatedReturns.length / input.length : null,
    missingObservedReturns,
    missingEstimates,
    executionReady: false,
    readOnly: true,
    status: estimatedReturns.length ? 'ESTIMATED' : 'UNKNOWN'
  };
}
