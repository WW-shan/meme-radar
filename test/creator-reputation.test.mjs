import test from 'node:test';
import assert from 'node:assert/strict';
import { CreatorReputation } from '../src/analytics/creator-reputation.mjs';
import { createOutcome, recordConfirmedCreatorOutcomes, updateOutcomePath } from '../src/outcomes.mjs';

const creator = '0x' + '1'.repeat(40);
const other = '0x' + '2'.repeat(40);
const address = '0x' + 'a'.repeat(40);

test('creator reputation uses prior launches only and computes median time to rug', () => {
  const store = new CreatorReputation();
  store.record({ chain: 'bsc', creator, token: 'A', observedAt: 1, outcome: 'rug', timeToRugMs: 100 });
  store.record({ chain: 'bsc', creator, token: 'B', observedAt: 2, outcome: 'rug', timeToRugMs: 300 });
  store.record({ chain: 'bsc', creator, token: 'C', observedAt: 3, outcome: 'success' });
  const before = store.snapshot('bsc', creator, 2);
  assert.equal(before.priorLaunches, 1);
  assert.equal(before.priorRugRate, 1);
  assert.equal(before.priorMedianTimeToRug, 100);
  assert.equal(before.known, false);
  const after = store.snapshot('bsc', creator, 4);
  assert.equal(after.priorLaunches, 3);
  assert.equal(after.priorRugs, 2);
  assert.equal(after.priorSuccessfulLaunches, 1);
  assert.equal(after.priorRugRate, 2 / 3);
  assert.equal(after.priorMedianTimeToRug, 200);
  assert.equal(after.known, true);
});

test('creator reputation is isolated by chain and rejects invalid records', () => {
  const store = new CreatorReputation();
  store.record({ chain: 'bsc', creator, token: 'A', observedAt: 1, outcome: 'rug' });
  assert.equal(store.snapshot('base', creator, 10).priorLaunches, 0);
  assert.throws(() => store.record({ chain: 'bsc', creator: 'bad', token: 'A', observedAt: 1, outcome: 'rug' }), error => error.code === 'INVALID_CREATOR_HISTORY');
});

test('creator reputation is replayable from serialized records', () => {
  const first = new CreatorReputation();
  first.record({ chain: 'bsc', creator, token: 'A', observedAt: 1, outcome: 'rug', timeToRugMs: 10 });
  first.record({ chain: 'bsc', creator: other, token: 'B', observedAt: 2, outcome: 'success' });
  const restored = new CreatorReputation(first.serialize());
  assert.deepEqual(restored.snapshot('bsc', creator, 2), first.snapshot('bsc', creator, 2));
  assert.deepEqual(restored.serialize(), first.serialize());
});

test('zero history is explicitly unknown rather than safe', () => {
  const result = new CreatorReputation().snapshot('bsc', creator, 100);
  assert.equal(result.priorLaunches, 0);
  assert.equal(result.priorRugRate, null);
  assert.equal(result.known, false);
  assert.match(result.unknownReason, /insufficient/);
});

test('confirmed H24 outcomes are written once and replay identically', () => {
  const now = 1_800_000_000_000;
  const row = createOutcome({
    chain: 'bsc',
    address,
    creatorAddress: `0x${'9'.repeat(40)}`,
    baselineAt: now - 25 * 60 * 60_000,
    baselinePrice: 1
  });
  row.samples.h24 = {
    at: now, targetAt: now, collectedAt: now,
    price: 3, return: 2, failedRead: false,
    liquidityUsd: 1_000, volume5m: 10, sells5m: 2, sourceLatencyMs: 5
  };
  updateOutcomePath(row, [row.samples.h24]);

  const reputation = new CreatorReputation();
  assert.equal(recordConfirmedCreatorOutcomes(reputation, [row]), 1);
  assert.equal(recordConfirmedCreatorOutcomes(reputation, [row]), 0);
  const snapshot = reputation.snapshot('bsc', `0x${'9'.repeat(40)}`, now + 1);
  assert.equal(snapshot.priorLaunches, 1);
  assert.equal(snapshot.priorSuccessfulLaunches, 1);
  assert.equal(snapshot.priorRugRate, 0);
});
