import test from 'node:test';
import assert from 'node:assert/strict';
import { collectOutcomeSamples, createOutcome, updateOutcomePath } from '../src/outcomes.mjs';
import { summarizeOutcomes, updateOutcomeTracking } from '../src/scanner.mjs';
import { toPublicStatus } from '../src/server.mjs';

const DAY = 24 * 60 * 60_000;
const address = '0x' + '2'.repeat(40);

test('outcome path records peak, max drawdown, first rug, and ordered deduplicated observations', () => {
  const row = createOutcome({ chain: 'bsc', address, baselineAt: 0, baselinePrice: 1, initialDecision: 'X_REVIEW' });
  updateOutcomePath(row, [
    { at: 180_000, price: .1, liquidityUsd: 900, volume5m: 40, sells5m: 9, failedRead: false, sourceLatencyMs: 18 },
    { at: 60_000, price: .8, liquidityUsd: 1_000, volume5m: 20, sells5m: 4, failedRead: false, sourceLatencyMs: 12 },
    { at: 120_000, price: .2, liquidityUsd: 800, volume5m: 30, sells5m: 7, failedRead: false, sourceLatencyMs: 15 },
    { at: 120_000, price: .2, liquidityUsd: 800, volume5m: 30, sells5m: 7, failedRead: false, sourceLatencyMs: 15 },
    { at: 90_000, price: 0, failedRead: false }
  ]);

  assert.equal(row.path.peak, 1);
  assert.equal(row.path.maxDrawdown, .9);
  assert.equal(row.path.firstRugAt, 120_000);
  assert.deepEqual(row.path.observations.map(sample => sample.at), [0, 60_000, 90_000, 120_000, 180_000]);
  const invalid = row.path.observations.find(sample => sample.at === 90_000);
  assert.equal(invalid.price, null);
  assert.equal(invalid.failedRead, true);
  assert.equal(invalid.errorCode, 'INVALID_PRICE');
  assert.equal(invalid.liquidityUsd, null);
  assert.equal(invalid.volume5m, null);
  assert.equal(invalid.sells5m, null);
  assert.equal(invalid.sourceLatencyMs, null);
});

test('failed reads remain explicit evidence and never count as normal path or coverage samples', async () => {
  const now = 1_800_000_000_000;
  const row = createOutcome({ chain: 'bsc', address, baselineAt: now - 31 * 60_000, baselinePrice: 2 });
  const gmgn = { priceAt: async () => { throw Object.assign(new Error('timeout'), { code: 'GMGN_TIMEOUT' }); } };
  await collectOutcomeSamples([row], gmgn, 'bsc', { now: () => now, limit: 3 });

  assert.equal(row.samples.m30, undefined);
  const failed = row.path.observations.at(-1);
  assert.equal(failed.failedRead, true);
  assert.equal(failed.price, null);
  assert.equal(failed.errorCode, 'READ_FAILED');
  assert.equal(failed.liquidityUsd, null);
  assert.equal(failed.volume5m, null);
  assert.equal(failed.sells5m, null);
  assert.equal(row.path.maxDrawdown, 0);
  assert.equal(row.path.coverage.completed, 0);
  assert.ok(row.sampleRetries.m30.nextAt > now);
});

test('current discovery metrics preserve missing values as null and real zeroes as zero', () => {
  const now = 1_800_000_000_000;
  const missing = createOutcome({ chain: 'bsc', address, baselineAt: now - 31 * 60_000, baselinePrice: 1 });
  const trackedMissing = updateOutcomeTracking([missing], new Map([[address, { price: 2 }]]), now, 7 * DAY)[0];
  const missingSample = trackedMissing.samples.m30;
  assert.equal(missingSample.liquidityUsd, null);
  assert.equal(missingSample.volume5m, null);
  assert.equal(missingSample.sells5m, null);
  assert.equal(missingSample.sourceLatencyMs, null);

  const zero = createOutcome({ chain: 'bsc', address, baselineAt: now - 31 * 60_000, baselinePrice: 1 });
  const trackedZero = updateOutcomeTracking([zero], new Map([[address, { price: 2, liquidityUsd: 0, volume5m: 0, sells5m: 0, sourceLatencyMs: 0 }]]), now, 7 * DAY)[0];
  assert.equal(trackedZero.samples.m30.liquidityUsd, 0);
  assert.equal(trackedZero.samples.m30.volume5m, 0);
  assert.equal(trackedZero.samples.m30.sells5m, 0);
  assert.equal(trackedZero.samples.m30.sourceLatencyMs, 0);
});

test('late current prices are not backfilled into expired target windows and retention removes old paths', () => {
  const now = 1_800_000_000_000;
  const row = createOutcome({ chain: 'bsc', address, baselineAt: now - DAY - 3 * 60_000, baselinePrice: 1 });
  const kept = updateOutcomeTracking([row], new Map([[address, { price: 1.5 }]]), now, 7 * DAY)[0];
  assert.equal(kept.samples.m30, undefined);
  assert.equal(kept.samples.h2, undefined);
  assert.equal(kept.samples.h24.return, .5);

  const expired = createOutcome({ chain: 'bsc', address, baselineAt: 0, baselinePrice: 1 });
  assert.deepEqual(updateOutcomeTracking([expired], new Map(), 8 * DAY, 7 * DAY), []);
});

test('outcome API separates observed results, path risk, and sample coverage without marking incomplete paths complete', () => {
  const now = Date.now();
  const row = createOutcome({ chain: 'bsc', address, baselineAt: now - 31 * 60_000, baselinePrice: 1 });
  row.samples.m30 = { at: now, targetAt: now - 60_000, price: .5, return: -.5, failedRead: false,
    liquidityUsd: 1_000, volume5m: 20, sells5m: 5, sourceLatencyMs: 10 };
  updateOutcomePath(row, [row.samples.m30]);

  const summary = summarizeOutcomes([row]);
  assert.equal(summary.observedResults.m30.completed, 1);
  assert.equal(summary.observedResults.m30.average, -.5);
  assert.equal(summary.pathRisk.complete, 0);
  assert.equal(summary.pathRisk.incomplete, 1);
  assert.equal(summary.pathRisk.firstRugCount, 1);
  assert.equal(summary.sampleCoverage.passed.m30.completed, 1);
  assert.equal(summary.sampleCoverage.passed.h24.missing, 0);

  const api = toPublicStatus({ outcomeSummary: summary }).outcomeSummary;
  assert.equal(api.observedResults.m30.completed, 1);
  assert.equal(api.pathRisk.complete, 0);
  assert.equal(api.pathRisk.incomplete, 1);
  assert.equal(api.sampleCoverage.passed.m30.completed, 1);
  assert.equal(api.coverage.passed.m30.completed, 1);
});
