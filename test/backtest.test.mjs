import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluateClassification, evaluateEconomicMetrics } from '../src/evaluation/metrics.mjs';
import { makeFolds, runWalkForward, formatMarkdown } from '../src/evaluation/backtest.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const DAY = 86_400_000;

test('walk-forward folds are ordered, non-overlapping, and deterministic', () => {
  const folds = makeFolds({ start: 0, end: 100 * DAY, trainDays: 20, validationDays: 5, testDays: 5 });
  assert.ok(folds.length > 0);
  for (const fold of folds) {
    assert.ok(Math.max(...fold.train.map(row => row.at)) < Math.min(...fold.validation.map(row => row.at)));
    assert.ok(Math.max(...fold.validation.map(row => row.at)) < Math.min(...fold.test.map(row => row.at)));
    assert.ok(fold.trainRange.end <= fold.validationRange.start);
    assert.ok(fold.validationRange.end <= fold.testRange.start);
  }
  assert.deepEqual(folds, makeFolds({ start: 0, end: 100 * DAY, trainDays: 20, validationDays: 5, testDays: 5 }));
});

test('classification metrics report precision, recall, AUPRC, Brier, calibration and coverage', () => {
  const metrics = evaluateClassification([{ score: .9, label: 1 }, { score: .2, label: 0 }], { threshold: .5 });
  assert.equal(metrics.precision, 1);
  assert.equal(metrics.recall, 1);
  assert.equal(metrics.coverage, 1);
  assert.equal(metrics.sampleCount, 2);
  assert.equal(metrics.auprc, 1);
  assert.ok(Number.isFinite(metrics.brierScore));
  assert.ok(Number.isFinite(metrics.expectedCalibrationError));
  assert.equal(metrics.calibrationBins.at(-1).max, 1);
});

test('classification metrics accept nested point-in-time dataset labels', () => {
  const metrics = evaluateClassification([
    { score: .9, label: { status: 'LABELED', success: true, rug: false } },
    { score: .2, label: { status: 'LABELED', success: false, rug: true } },
    { score: .7, label: { status: 'UNKNOWN', success: null, rug: null } }
  ], { threshold: .5 });
  assert.equal(metrics.sampleCount, 2);
  assert.equal(metrics.precision, 1);
  assert.equal(metrics.recall, 1);
});

test('classification metrics handle empty, missing labels, all-negative and class imbalance without fake values', () => {
  const empty = evaluateClassification([], { threshold: .5 });
  assert.equal(empty.sampleCount, 0);
  assert.equal(empty.coverage, null);
  assert.equal(empty.precision, null);
  assert.equal(empty.recall, null);
  assert.equal(empty.auprc, null);
  assert.equal(empty.brierScore, null);

  const missing = evaluateClassification([{ score: .8 }, { score: null, label: 1 }], { threshold: .5 });
  assert.equal(missing.sampleCount, 0);
  assert.equal(missing.missingLabels, 1);
  assert.equal(missing.missingScores, 1);
  assert.equal(missing.precision, null);

  const allNegative = evaluateClassification([{ score: .8, label: 0 }, { score: .2, label: 0 }], { threshold: .5 });
  assert.equal(allNegative.recall, null);
  assert.equal(allNegative.auprc, null);
  assert.equal(allNegative.precision, 0);
  assert.equal(allNegative.brierScore, .34);

  const imbalanced = evaluateClassification([
    { score: .99, label: 1 },
    { score: .98, label: 1 },
    { score: .2, label: 0 },
    { score: .1, label: 0 }
  ], { threshold: .5 });
  assert.equal(imbalanced.precision, 1);
  assert.equal(imbalanced.recall, 1);
  assert.equal(imbalanced.auprc, 1);
});

test('calibration keeps score=1 in the final bucket and measures overconfidence', () => {
  const perfect = evaluateClassification([
    { score: 0, label: 0 },
    { score: 1, label: 1 }
  ], { threshold: .5 });
  assert.equal(perfect.expectedCalibrationError, 0);
  assert.equal(perfect.calibrationBins[9].count, 1);
  assert.equal(perfect.calibrationBins[9].max, 1);

  const overconfident = evaluateClassification([
    { score: .99, label: 0 },
    { score: .99, label: 0 },
    { score: .01, label: 1 }
  ], { threshold: .5 });
  assert.ok(overconfident.expectedCalibrationError > .5);
});

test('economic metrics use the read-only execution model and keep observed and estimated returns separate', () => {
  const rows = [
    { score: .9, label: 1, observedReturn: .2, liquidityUsd: 20_000, sells5m: 20 },
    { score: .2, label: 0, observedReturn: -.1, liquidityUsd: 10_000, sells5m: 10 }
  ];
  const metrics = evaluateEconomicMetrics(rows, {
    notionalUsd: 1000, feeRate: .01, priorityUsd: .2, mevReserveRate: .02
  });
  assert.ok(Number.isFinite(metrics.observedReturn));
  assert.ok(Number.isFinite(metrics.estimatedNetReturn));
  assert.notEqual(metrics.observedReturn, metrics.estimatedNetReturn);
  assert.equal(metrics.executionReady, false);
  assert.equal(metrics.readOnly, true);
  assert.equal(metrics.estimatedCoverage, 1);
});

test('walk-forward report is deterministic and includes cutoff, fold ranges, rule version and sample counts', () => {
  const rows = [
    { observedAt: 0, score: .9, label: 1, observedReturn: .2, liquidityUsd: 20_000, sells5m: 20 },
    { observedAt: DAY, score: .8, label: 1, observedReturn: .1, liquidityUsd: 20_000, sells5m: 20 },
    { observedAt: 2 * DAY, score: .2, label: 0, observedReturn: -.1, liquidityUsd: 20_000, sells5m: 20 },
    { observedAt: 3 * DAY, score: .1, label: 0, observedReturn: -.2, liquidityUsd: 20_000, sells5m: 20 }
  ];
  const folds = makeFolds({ start: 0, end: 4 * DAY, trainDays: 1, validationDays: 1, testDays: 1 });
  const options = {
    folds,
    cutoff: 3 * DAY,
    ruleVersion: 'radar-v3',
    threshold: .5,
    executionAssumptions: { notionalUsd: 1000, feeRate: .01, priorityUsd: .2, mevReserveRate: .02 }
  };
  const first = runWalkForward(rows, options);
  const second = runWalkForward(rows, options);
  assert.deepEqual(first, second);
  assert.equal(first.ruleVersion, 'radar-v3');
  assert.equal(first.dataCutoff, 3 * DAY);
  assert.equal(first.sampleCount, 4);
  assert.equal(first.folds.length, folds.length);
  assert.ok(first.folds.every(fold => fold.trainRange.end <= fold.validationRange.start));
  assert.equal(first.executionReady, false);
  assert.match(formatMarkdown(first), /radar-v3/);
});

test('backtest CLI writes reproducible JSON and Markdown reports', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-backtest-'));
  const input = path.join(dir, 'events.ndjson');
  const output = path.join(dir, 'report.json');
  const markdown = path.join(dir, 'report.md');
  fs.writeFileSync(input, [
    { observedAt: 0, score: .9, label: 1, observedReturn: .2, liquidityUsd: 20_000, sells5m: 20 },
    { observedAt: DAY, score: .8, label: 1, observedReturn: .1, liquidityUsd: 20_000, sells5m: 20 },
    { observedAt: 2 * DAY, score: .2, label: 0, observedReturn: -.1, liquidityUsd: 20_000, sells5m: 20 }
  ].map(row => JSON.stringify(row)).join('\n'));
  execFileSync(process.execPath, [
    path.join(root, 'scripts/backtest.mjs'),
    '--input', input,
    '--output', output,
    '--markdown', markdown,
    '--start', '0',
    '--end', String(3 * DAY),
    '--train-days', '1',
    '--validation-days', '1',
    '--test-days', '1',
    '--rule-version', 'radar-v3'
  ]);
  const report = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(report.ruleVersion, 'radar-v3');
  assert.equal(report.sampleCount, 3);
  assert.ok(Array.isArray(report.folds));
  assert.match(fs.readFileSync(markdown, 'utf8'), /Walk-forward Backtest/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('walk-forward excludes observations after the declared cutoff', () => {
  const folds = [{
    index: 0,
    trainRange: { start: -DAY, end: 0 },
    validationRange: { start: 0, end: DAY },
    testRange: { start: DAY, end: 2 * DAY },
    train: [{ at: -DAY }],
    validation: [{ at: 0 }],
    test: [{ at: DAY }]
  }];
  const rows = [
    { observedAt: 0, score: .9, label: 1 },
    { observedAt: DAY, score: .2, label: 0 },
    { observedAt: 10 * DAY, score: .99, label: 1 }
  ];
  const report = runWalkForward(rows, { folds, cutoff: 2 * DAY });
  assert.equal(report.sampleCount, 2);
  assert.equal(report.excludedAfterCutoff, 1);
  assert.equal(report.metrics.sampleCount, 1);
});
