import { evaluateClassification, evaluateEconomicMetrics } from './metrics.mjs';

export const BACKTEST_VERSION = 'backtest-v1';
const DAY_MS = 86_400_000;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw Object.assign(new Error(`invalid ${name}`), { code: 'INVALID_FOLD' });
  return number;
}

function eventAt(row) {
  return finite(row?.observedAt ?? row?.at);
}

function range(start, end) {
  return { start, end };
}

function inRange(at, bounds) {
  return at !== null && at >= bounds.start && at < bounds.end;
}

function assertFold(fold) {
  const { trainRange, validationRange, testRange } = fold;
  if (!trainRange || !validationRange || !testRange
    || trainRange.start >= trainRange.end
    || validationRange.start >= validationRange.end
    || testRange.start >= testRange.end
    || trainRange.end > validationRange.start
    || validationRange.end > testRange.start) {
    throw Object.assign(new Error('overlapping or invalid walk-forward fold'), { code: 'INVALID_FOLD' });
  }
}

export function makeFolds({ start, end, trainDays, validationDays, testDays }) {
  const startAt = finite(start);
  const endAt = finite(end);
  const train = positiveInteger(trainDays, 'trainDays');
  const validation = positiveInteger(validationDays, 'validationDays');
  const test = positiveInteger(testDays, 'testDays');
  if (startAt === null || endAt === null || endAt <= startAt) return [];
  const span = (train + validation + test) * DAY_MS;
  const folds = [];
  for (let cursor = startAt; cursor + span <= endAt; cursor += test * DAY_MS) {
    const trainRange = range(cursor, cursor + train * DAY_MS);
    const validationRange = range(trainRange.end, trainRange.end + validation * DAY_MS);
    const testRange = range(validationRange.end, validationRange.end + test * DAY_MS);
    folds.push({
      index: folds.length,
      trainRange,
      validationRange,
      testRange,
      train: Array.from({ length: train }, (_, index) => ({ at: trainRange.start + index * DAY_MS })),
      validation: Array.from({ length: validation }, (_, index) => ({ at: validationRange.start + index * DAY_MS })),
      test: Array.from({ length: test }, (_, index) => ({ at: testRange.start + index * DAY_MS }))
    });
  }
  return folds;
}

function sortedRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row, index) => ({ row, at: eventAt(row), index }))
    .filter(item => item.at !== null)
    .sort((a, b) => a.at - b.at || String(a.row?.id || a.index).localeCompare(String(b.row?.id || b.index)))
    .map(item => item.row);
}

function rowsIn(rows, bounds) {
  return rows.filter(row => inRange(eventAt(row), bounds));
}

function foldReport(fold, rows, options) {
  assertFold(fold);
  const trainRows = rowsIn(rows, fold.trainRange);
  const validationRows = rowsIn(rows, fold.validationRange);
  const testRows = rowsIn(rows, fold.testRange);
  return {
    index: fold.index,
    trainRange: fold.trainRange,
    validationRange: fold.validationRange,
    testRange: fold.testRange,
    trainCount: trainRows.length,
    validationCount: validationRows.length,
    testCount: testRows.length,
    trainMetrics: evaluateClassification(trainRows, options),
    validationMetrics: evaluateClassification(validationRows, options),
    testMetrics: evaluateClassification(testRows, options)
  };
}

export function runWalkForward(rows, {
  folds,
  cutoff,
  ruleVersion = 'radar-v3',
  threshold = .5,
  executionAssumptions = {}
} = {}) {
  const allOrdered = sortedRows(rows);
  const requestedCutoff = finite(cutoff);
  const ordered = requestedCutoff === null
    ? allOrdered
    : allOrdered.filter(row => eventAt(row) <= requestedCutoff);
  const foldSet = Array.isArray(folds) ? folds : makeFolds({
    start: eventAt(ordered[0]),
    end: eventAt(ordered.at(-1)) === null ? null : eventAt(ordered.at(-1)) + 1,
    trainDays: 30,
    validationDays: 7,
    testDays: 7
  });
  const reports = foldSet.map(fold => foldReport(fold, ordered, { threshold }));
  const testRows = foldSet.flatMap(fold => rowsIn(ordered, fold.testRange));
  const dataCutoff = requestedCutoff ?? (allOrdered.length ? eventAt(allOrdered.at(-1)) : null);
  return {
    version: BACKTEST_VERSION,
    dataCutoff,
    ruleVersion: String(ruleVersion || 'radar-v3'),
    threshold: finite(threshold) ?? .5,
    sampleCount: ordered.length,
    eligibleSampleCount: ordered.length,
    excludedAfterCutoff: allOrdered.length - ordered.length,
    foldCount: reports.length,
    folds: reports,
    metrics: evaluateClassification(testRows, { threshold }),
    economicMetrics: evaluateEconomicMetrics(testRows, executionAssumptions),
    executionReady: false,
    readOnly: true
  };
}

function display(value) {
  if (value === null || value === undefined) return 'N/A';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(4);
  return String(value);
}

export function formatMarkdown(report = {}) {
  const metrics = report.metrics || {};
  const economic = report.economicMetrics || {};
  const lines = [
    '# Walk-forward Backtest',
    '',
    `- Version: ${display(report.version)}`,
    `- Rule version: ${display(report.ruleVersion)}`,
    `- Data cutoff: ${display(report.dataCutoff)}`,
    `- Samples: ${display(report.sampleCount)}`,
    `- Folds: ${display(report.foldCount)}`,
    `- Execution ready: ${report.executionReady === true ? 'true' : 'false'}`,
    '',
    '## Test Metrics',
    '',
    '| Metric | Value |',
    '| --- | ---: |',
    `| Precision | ${display(metrics.precision)} |`,
    `| Recall | ${display(metrics.recall)} |`,
    `| AUPRC | ${display(metrics.auprc)} |`,
    `| Brier score | ${display(metrics.brierScore)} |`,
    `| Expected calibration error | ${display(metrics.expectedCalibrationError)} |`,
    `| Coverage | ${display(metrics.coverage)} |`,
    `| Sample count | ${display(metrics.sampleCount)} |`,
    '',
    '## Economic Estimates',
    '',
    '| Metric | Value |',
    '| --- | ---: |',
    `| Observed return | ${display(economic.observedReturn)} |`,
    `| Estimated net return | ${display(economic.estimatedNetReturn)} |`,
    `| Observed coverage | ${display(economic.observedCoverage)} |`,
    `| Estimated coverage | ${display(economic.estimatedCoverage)} |`,
    '',
    '## Folds',
    '',
    '| Fold | Train | Validation | Test | Test samples |',
    '| ---: | --- | --- | --- | ---: |'
  ];
  for (const fold of report.folds || []) {
    lines.push(`| ${display(fold.index)} | ${display(fold.trainRange?.start)}–${display(fold.trainRange?.end)} | ${display(fold.validationRange?.start)}–${display(fold.validationRange?.end)} | ${display(fold.testRange?.start)}–${display(fold.testRange?.end)} | ${display(fold.testCount)} |`);
  }
  lines.push('', `Read-only estimate. Observed returns and estimated net returns are separate and are not execution instructions.`, '');
  return lines.join('\n');
}
