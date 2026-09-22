import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { calibrationReport } from '../src/evaluation/calibration.mjs';
import { summarizeOutcomes } from '../src/scanner.mjs';
import { toPublicStatus } from '../src/server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

function calibrationRows(count, { overconfident = false } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const label = index % 2;
    return { score: overconfident ? .99 : label, label };
  });
}

function outcomeRows(count) {
  return Array.from({ length: count }, (_, index) => {
    const label = index % 2;
    return {
      initialDecision: 'X_REVIEW',
      riskScore: label,
      riskVersion: 'risk-engine-v1',
      baselineAt: 0,
      samples: {},
      path: {
        coverage: { complete: true },
        firstRugAt: label === 1 ? 1 : null,
        observations: []
      }
    };
  });
}

test('calibration report rejects overconfident models and exposes metadata and buckets', () => {
  const report = calibrationReport([{ score: .99, label: 0 }, { score: .99, label: 0 }, { score: .01, label: 1 }], {
    modelVersion: 'risk-engine-v1', dataCutoff: 123, lastCalibratedAt: 100
  });
  assert.equal(report.ready, false);
  assert.ok(report.expectedCalibrationError > .5);
  assert.equal(report.modelVersion, 'risk-engine-v1');
  assert.equal(report.dataCutoff, 123);
  assert.equal(report.lastCalibratedAt, 100);
  assert.equal(report.bins.at(-1).max, 1);
  assert.equal(report.minimumSample, 500);
});

test('50 samples can start observation but never count as calibrated', () => {
  const report = calibrationReport(calibrationRows(50));
  assert.equal(report.sampleCount, 50);
  assert.equal(report.canStartObservation, true);
  assert.equal(report.ready, false);
  assert.equal(report.status, 'OBSERVING');
});

test('calibration gate switches only at 500 balanced samples with acceptable ECE', () => {
  assert.equal(calibrationReport(calibrationRows(499)).ready, false);
  const ready = calibrationReport(calibrationRows(500));
  assert.equal(ready.sampleCount, 500);
  assert.equal(ready.expectedCalibrationError, 0);
  assert.equal(ready.ready, true);
  assert.equal(ready.status, 'CALIBRATED');
});

test('empty, single-class and missing-label inputs are safe and never calibrated', () => {
  const empty = calibrationReport([]);
  assert.equal(empty.sampleCount, 0);
  assert.equal(empty.expectedCalibrationError, null);
  assert.equal(empty.ready, false);
  assert.equal(empty.status, 'INSUFFICIENT');

  const singleClass = calibrationReport(Array.from({ length: 500 }, () => ({ score: 0, label: 0 })));
  assert.equal(singleClass.expectedCalibrationError, 0);
  assert.equal(singleClass.ready, false);

  const missing = calibrationReport([{ score: .5 }, { score: .5, label: null }]);
  assert.equal(missing.sampleCount, 0);
  assert.equal(missing.ready, false);
  assert.equal(missing.missingLabels, 2);
});

test('outcome summary and public API expose calibration gate without enabling failed models', () => {
  const insufficient = summarizeOutcomes(outcomeRows(50));
  assert.equal(insufficient.calibrationReady, false);
  assert.equal(insufficient.canStartObservation, true);
  assert.equal(insufficient.calibrationMinimumSample, 500);

  const ready = summarizeOutcomes(outcomeRows(500));
  assert.equal(ready.calibrationReady, true);
  const publicSummary = toPublicStatus({ outcomeSummary: ready }).outcomeSummary;
  assert.equal(publicSummary.calibrationReady, true);
  assert.equal(publicSummary.expectedCalibrationError, 0);
  assert.equal(publicSummary.modelVersion, 'risk-engine-v1');
  assert.ok(Array.isArray(publicSummary.calibrationBins));
  assert.equal(publicSummary.executionReady, false);
});

test('model audit CLI writes a calibration report with model metadata and buckets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-calibration-'));
  const input = path.join(dir, 'calibration.json');
  const output = path.join(dir, 'audit.json');
  fs.writeFileSync(input, JSON.stringify(calibrationRows(500)));
  execFileSync(process.execPath, [
    path.join(root, 'scripts/model-audit.mjs'),
    '--input', input,
    '--output', output,
    '--model-version', 'risk-engine-v1',
    '--data-cutoff', '123'
  ]);
  const report = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(report.ready, true);
  assert.equal(report.modelVersion, 'risk-engine-v1');
  assert.equal(report.dataCutoff, 123);
  assert.equal(report.bins.length, 10);
  fs.rmSync(dir, { recursive: true, force: true });
});
