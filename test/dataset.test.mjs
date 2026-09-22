import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildDataset, buildPointInTimeDataset, DATASET_VERSION, migrateDataset } from '../src/evaluation/dataset.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

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

test('event-store rows are joined by token address and only use labels recorded at cutoff', () => {
  const launchAt = 1_000;
  const outcomeAt = 1_000 + 24 * 60 * 60_000;
  const events = [
    {
      eventId: 'launch', source: 'gmgn', chain: 'bsc', stage: 'new_creation', observedAt: launchAt,
      token: { address: '0x' + '1'.repeat(40), symbol: 'DOG' },
      raw: { ignoredFuture: 99 },
      normalized: { symbol: 'DOG', liquidity: 10_000, futureOutcome: 'SUCCESS' }
    },
    {
      eventId: 'outcome', source: 'radar-outcome', chain: 'bsc', stage: 'outcome', observedAt: outcomeAt,
      token: { address: '0x' + '1'.repeat(40), symbol: 'DOG' },
      raw: { baselineAt: launchAt, baselinePrice: 1, path: { observations: [
        { at: launchAt, price: 1, failedRead: false },
        { at: outcomeAt, price: 3, return: 2, failedRead: false }
      ] } },
      normalized: { kind: 'outcome', label: 'SUCCESS', success: true, rug: false, riskScore: .8 }
    }
  ];
  const beforeOutcome = buildPointInTimeDataset(events, {
    cutoff: outcomeAt - 1,
    featureKeys: ['symbol', 'liquidity']
  });
  assert.equal(beforeOutcome[0].label.status, 'UNKNOWN');
  assert.equal(beforeOutcome[0].features.futureOutcome, undefined);

  const ready = buildPointInTimeDataset(events, {
    cutoff: outcomeAt,
    featureKeys: ['symbol', 'liquidity']
  });
  assert.equal(ready.length, 1);
  assert.equal(ready[0].address, '0x' + '1'.repeat(40));
  assert.deepEqual(ready[0].features, { symbol: 'DOG', liquidity: 10_000 });
  assert.equal(ready[0].label.success, true);
  assert.equal(ready[0].score, .8);
  assert.equal(ready[0].binaryLabel, 1);
  assert.equal(ready[0].observedReturn, 2);
});

test('dataset CLI converts append-only events into deterministic JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-dataset-cli-'));
  try {
    const input = path.join(dir, 'events');
    const output = path.join(dir, 'dataset.json');
    fs.mkdirSync(input);
    const launchAt = 1_000;
    const outcomeAt = 1_000 + 24 * 60 * 60_000;
    fs.writeFileSync(path.join(input, '2026-01-01.ndjson'), [
      {
        eventId: 'launch', source: 'gmgn', chain: 'bsc', stage: 'new_creation', observedAt: launchAt,
        token: { address: '0x' + '5'.repeat(40), symbol: 'CLI' }, raw: {}, normalized: { symbol: 'CLI', liquidity: 5_000 }
      },
      {
        eventId: 'outcome', source: 'radar-outcome', chain: 'bsc', stage: 'outcome', observedAt: outcomeAt,
        token: { address: '0x' + '5'.repeat(40), symbol: 'CLI' }, raw: { baselineAt: launchAt, baselinePrice: 1, path: { observations: [
          { at: launchAt, price: 1 }, { at: outcomeAt, price: .4, return: -.6, failedRead: false }
        ] } }, normalized: { kind: 'outcome', label: 'RUG', success: false, rug: true, riskScore: .2 }
      }
    ].map(row => JSON.stringify(row)).join('\n'));
    execFileSync(process.execPath, [
      path.join(root, 'scripts/dataset.mjs'),
      '--input', input,
      '--output', output,
      '--cutoff', String(outcomeAt),
      '--features', 'symbol,liquidity'
    ]);
    const dataset = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(dataset.rows.length, 1);
    assert.deepEqual(dataset.rows[0].features, { symbol: 'CLI', liquidity: 5_000 });
    assert.equal(dataset.rows[0].label.rug, true);
    assert.equal(dataset.rows[0].binaryLabel, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
