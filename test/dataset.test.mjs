import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDataset, DATASET_VERSION, migrateDataset } from '../src/evaluation/dataset.mjs';

test('dataset builder uses an explicit feature whitelist and never spreads future fields', () => {
  const rows = buildDataset([{
    chain: 'bsc',
    address: 'A',
    observedAt: 1000,
    normalized: { liquidity: 1, futureOutcome: 'rug', raw: 'secret' },
    futureOutcome: 'rug',
    raw: 'secret',
    observations: [{ at: 1100, price: .4 }],
    baselinePrice: 1,
    horizonAt: 1200
  }], { cutoff: 1000, featureKeys: ['liquidity'] });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].features, { liquidity: 1 });
  assert.equal(rows[0].futureOutcome, undefined);
  assert.equal(rows[0].raw, undefined);
  assert.equal(rows[0].label.status, 'LABELED');
  assert.equal(rows[0].label.rug, true);
  assert.equal(rows[0].datasetVersion, DATASET_VERSION);
});

test('dataset cutoff is inclusive and future events are excluded', () => {
  const rows = buildDataset([
    { observedAt: 1000, normalized: { liquidity: 1 } },
    { observedAt: 1001, normalized: { liquidity: 2 } }
  ], { cutoff: 1000, featureKeys: ['liquidity'] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].observedAt, 1000);
  assert.equal(rows[0].labelAt, 1000);
});

test('dataset deduplicates duplicate events, sorts out-of-order events, and is reproducible at one cutoff', () => {
  const events = [
    { chain: 'bsc', address: 'A', observedAt: 2000, normalized: { liquidity: 2 } },
    { chain: 'bsc', address: 'A', observedAt: 1000, normalized: { liquidity: 1 } },
    { chain: 'bsc', address: 'A', observedAt: 2000, normalized: { liquidity: 2 } }
  ];
  const options = { cutoff: 3000, featureKeys: ['liquidity'] };
  const first = buildDataset(events, options);
  const second = buildDataset([...events].reverse(), options);
  assert.deepEqual(first, second);
  assert.deepEqual(first.map(row => row.observedAt), [1000, 2000]);
});

test('zero evidence produces UNKNOWN rather than a fabricated success or failure', () => {
  const rows = buildDataset([{ observedAt: 1000, normalized: { liquidity: 1 } }], { cutoff: 1000, featureKeys: ['liquidity'] });
  assert.equal(rows[0].label.status, 'UNKNOWN');
  assert.equal(rows[0].label.label, 'UNKNOWN');
  assert.equal(rows[0].label.success, null);
  assert.equal(rows[0].label.rug, null);
});

test('dataset migration keeps versions and drops non-whitelisted legacy fields', () => {
  const migrated = migrateDataset([{
    observedAt: 1000,
    features: { liquidity: 1 },
    label: { rug: false, success: true, horizonAt: 2000 },
    futureOutcome: 'success',
    raw: 'secret'
  }], { cutoff: 2000 });
  assert.equal(migrated.length, 1);
  assert.equal(migrated[0].datasetVersion, DATASET_VERSION);
  assert.equal(migrated[0].label.version, 'label-v1');
  assert.equal(migrated[0].label.cutoff, 2000);
  assert.equal(migrated[0].futureOutcome, undefined);
  assert.equal(migrated[0].raw, undefined);
});
