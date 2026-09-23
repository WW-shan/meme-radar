import test from 'node:test';
import assert from 'node:assert/strict';
import { CreatorReputation, loadCreatorReputation } from '../src/analytics/creator-reputation.mjs';
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

test('creator reputation covers every configured EVM chain used by the scanner', () => {
  const store = new CreatorReputation();
  store.record({ chain: 'robinhood', creator, token: 'R', observedAt: 1, outcome: 'rug', timeToRugMs: 50 });
  const snapshot = store.snapshot('robinhood', creator, 2);
  assert.equal(snapshot.priorLaunches, 1);
  assert.equal(snapshot.priorRugRate, 1);
});

test('outcome ingestion skips malformed creator identities instead of failing the scan cycle', () => {
  const now = 1_800_000_000_000;
  const row = createOutcome({
    chain: 'bsc',
    address,
    creatorAddress: 'not-an-address',
    baselineAt: now - 25 * 60 * 60_000,
    baselinePrice: 1
  });
  row.samples.h24 = { at: now, targetAt: now, collectedAt: now, price: 3, return: 2, failedRead: false };
  updateOutcomePath(row, [row.samples.h24]);
  assert.equal(recordConfirmedCreatorOutcomes(new CreatorReputation(), [row]), 0);
});

test('unmeasured H24 samples never turn an unknown creator into a clean one', () => {
  const now = 1_800_000_000_000;
  const creatorAddress = `0x${'9'.repeat(40)}`;
  const row = createOutcome({
    chain: 'bsc', address, creatorAddress,
    baselineAt: now - 25 * 60 * 60_000, baselinePrice: 1
  });
  row.samples.h24 = {
    at: now, targetAt: now, collectedAt: now,
    price: 3, return: null, failedRead: false, liquidityUsd: 1_000
  };
  updateOutcomePath(row, [row.samples.h24]);

  const reputation = new CreatorReputation();
  assert.equal(recordConfirmedCreatorOutcomes(reputation, [row]), 0,
    'a sample without a measured return is not a confirmed outcome');
  assert.equal(reputation.snapshot('bsc', creatorAddress, now + 1).known, false,
    'an unmeasured sample must not make the creator look known and safe');
});

test('a confirmed rug is recorded even when the H24 return is unmeasured', () => {
  const now = 1_800_000_000_000;
  const creatorAddress = `0x${'7'.repeat(40)}`;
  const row = createOutcome({
    chain: 'bsc', address, creatorAddress,
    baselineAt: now - 25 * 60 * 60_000, baselinePrice: 1
  });
  row.samples.h24 = {
    at: now, targetAt: now, collectedAt: now,
    price: .1, return: null, failedRead: false, liquidityUsd: 1_000
  };
  updateOutcomePath(row, [row.samples.h24]);
  row.path.firstRugAt = now - 60_000;

  const reputation = new CreatorReputation();
  assert.equal(recordConfirmedCreatorOutcomes(reputation, [row]), 1);
  assert.equal(reputation.snapshot('bsc', creatorAddress, now + 1).priorRugs, 1);
});

test('persisted creator history skips invalid rows instead of failing startup', () => {
  const valid = { chain: 'bsc', creator, token: 'T1', observedAt: 5, outcome: 'rug', timeToRugMs: 10 };
  const invalid = [];
  const reputation = loadCreatorReputation([
    valid,
    { chain: 'bsc', creator: 'not-an-address', token: 'T2', observedAt: 5, outcome: 'rug' },
    { chain: 'unknown-chain', creator, token: 'T3', observedAt: 5, outcome: 'rug' },
    null
  ], { onInvalid: info => invalid.push(info) });

  assert.equal(reputation.serialize().length, 1, 'valid history must survive');
  assert.equal(invalid.length, 3, 'every rejected row must be reported');
  assert.equal(reputation.snapshot('bsc', creator, 10).priorRugs, 1);
  assert.deepEqual(loadCreatorReputation('not-a-list').serialize(), []);
});
