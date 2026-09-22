import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventStore } from '../src/evaluation/event-store.mjs';
import { RadarState } from '../src/state.mjs';
import { Scanner } from '../src/scanner.mjs';
import { config } from '../src/config.mjs';

const temporary = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-events-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const event = (overrides = {}) => ({
  source: 'gmgn',
  chain: 'sol',
  stage: 'new_creation',
  token: { address: 'So11111111111111111111111111111111111111112', symbol: 'DOG' },
  observedAt: 1_800_000_000_000,
  raw: { price: 1, volume: 20, nested: { b: 2, a: 1 } },
  normalized: { price: 1, volume: 20, nested: { b: 2, a: 1 } },
  ...overrides
});

test('event store writes immutable normalized snapshots with private permissions', async t => {
  const dir = temporary(t);
  const store = new EventStore(dir, { now: () => 1_800_000_000_000 });
  const row = await store.append(event());
  assert.match(row.eventId, /^[a-f0-9]{64}$/);
  const rows = await store.read({ chain: 'sol' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stage, 'new_creation');
  assert.equal(fs.statSync(path.join(dir, 'events')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(store.file(row.observedAt)).mode & 0o777, 0o600);
});

test('event store deduplicates nested-key-equivalent observations', async t => {
  const store = new EventStore(temporary(t), { now: () => 1_800_000_000_000 });
  const first = event({ raw: { a: 1, nested: { x: 1, y: 2 } }, normalized: { a: 1, nested: { x: 1, y: 2 } } });
  const second = event({ raw: { nested: { y: 2, x: 1 }, a: 1 }, normalized: { nested: { y: 2, x: 1 }, a: 1 } });
  const a = await store.append(first);
  const b = await store.append(second);
  assert.equal(a.eventId, b.eventId);
  assert.equal((await store.read()).length, 1);
});

test('event store rejects incomplete events and unknown stages', async t => {
  const store = new EventStore(temporary(t));
  await assert.rejects(store.append({ source: 'gmgn' }), /invalid event/);
  await assert.rejects(store.append(event({ stage: 'not-a-stage' })), /invalid event/);
});

test('event store accepts completed outcome snapshots as immutable evidence', async t => {
  const store = new EventStore(temporary(t));
  const row = await store.append(event({
    source: 'radar-outcome',
    stage: 'outcome',
    normalized: { kind: 'outcome', label: 'SUCCESS', success: true, rug: false }
  }));
  assert.equal(row.stage, 'outcome');
  assert.equal((await store.read({ stage: 'outcome' })).length, 1);
});

test('event store filters by chain and stage and sorts by observation time', async t => {
  const store = new EventStore(temporary(t));
  await store.append(event({ observedAt: 2000, stage: 'completed' }));
  await store.append(event({ observedAt: 1000, stage: 'new_creation' }));
  await store.append(event({ chain: 'bsc', observedAt: 1500, stage: 'completed' }));
  const solCompleted = await store.read({ chain: 'sol', stage: 'completed' });
  assert.deepEqual(solCompleted.map(row => row.observedAt), [2000]);
  assert.deepEqual((await store.read()).map(row => row.observedAt), [1000, 1500, 2000]);
});

test('event store fails closed on a corrupt line', async t => {
  const dir = temporary(t);
  const store = new EventStore(dir);
  await store.append(event());
  fs.appendFileSync(store.file(event().observedAt), '{broken\n');
  await assert.rejects(store.read(), error => error.code === 'EVENT_STORE_CORRUPT');
});

test('state migrates v2 to v4 without dropping existing data', t => {
  const dir = temporary(t);
  fs.writeFileSync(path.join(dir, 'radar.json'), JSON.stringify({ version: 2, scanCount: 7, candidates: [{ address: 'A' }] }));
  const state = new RadarState(dir);
  assert.equal(state.value.version, 4);
  assert.equal(state.value.scanCount, 7);
  assert.equal(state.value.candidates[0].address, 'A');
  assert.deepEqual(state.value.events, []);
});

test('scanner persists every staged discovery event and queries it by time and stage', async t => {
  const dir = temporary(t);
  const store = new EventStore(dir);
  const state = new RadarState(path.join(dir, 'state'));
  state.value.activeChain = 'bsc';
  const observedAt = 1_700_000_000_000;
  const row = {
    address: '0x' + '2'.repeat(40),
    symbol: 'EVENT',
    observedAt,
    raw: { rank: 1 },
    normalized: { rank: 1, liquidityUsd: 4_000 }
  };
  const gmgn = {
    keyEpoch: 0,
    nextAllowedAt: 0,
    disabled: false,
    metrics: { requests: 0, cacheHits: 0, rateLimits: 0 },
    configured: async () => true,
    discover: async () => [],
    audit: async () => { throw new Error('event-only row must not be deep-audited in this test'); }
  };
  const scanner = new Scanner({
    gmgn,
    state,
    eventStore: store,
    settings: { ...config, chain: 'bsc' },
    chainSources: [{ name: 'chain-new', read: async () => ({ stage: 'new_creation', rows: [row] }) }]
  });

  await scanner.cycle();

  const rows = await store.read({ chain: 'bsc', stage: 'new_creation', from: observedAt, to: observedAt });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'chain-new');
  assert.equal(rows[0].token.address, row.address);
  assert.deepEqual(rows[0].raw, row.raw);
  assert.deepEqual(rows[0].normalized, row.normalized);
});

test('scanner persists a completed outcome snapshot once for evaluation joins', async t => {
  const dir = temporary(t);
  const store = new EventStore(dir);
  const state = new RadarState(path.join(dir, 'state'));
  const scanner = new Scanner({
    gmgn: { keyEpoch: 0, nextAllowedAt: 0, disabled: false, metrics: {} },
    state,
    eventStore: store,
    settings: { ...config, chain: 'bsc' }
  });
  const address = '0x' + '3'.repeat(40);
  const baselineAt = 1_800_000_000_000;
  const observedAt = baselineAt + 24 * 60 * 60_000;
  const row = {
    chain: 'bsc', address, symbol: 'DONE', creatorAddress: '0x' + '4'.repeat(40),
    baselineAt, baselinePrice: 1, riskScore: .77, riskVersion: 'risk-v1',
    samples: { h24: { at: observedAt, collectedAt: observedAt, price: 3, return: 2, failedRead: false } },
    path: {
      version: 'outcome-path-v1', peak: 3, maxDrawdown: 0, firstRugAt: null,
      observations: [{ at: baselineAt, price: 1 }, { at: observedAt, price: 3, return: 2, failedRead: false }],
      coverage: { expected: 7, completed: 7, missing: 0, ratio: 1, complete: true }
    }
  };

  assert.equal(await scanner.persistOutcomeEvents([row], 'bsc'), 1);
  assert.equal(await scanner.persistOutcomeEvents([row], 'bsc'), 1);
  const rows = await store.read({ stage: 'outcome' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token.address, address);
  assert.equal(rows[0].normalized.label, 'SUCCESS');
  assert.equal(rows[0].normalized.riskScore, .77);
  assert.equal(rows[0].observedAt, observedAt);
});

test('event-store appends use an index instead of rereading the whole day file', async t => {
  const store = new EventStore(temporary(t), { now: () => 1_800_000_000_000 });
  const read = t.mock.method(fs, 'readFileSync');
  await store.append(event({ token: { address: 'INDEX-0' }, raw: { index: 0 }, normalized: { index: 0 } }));
  read.mock.resetCalls();
  for (let index = 1; index <= 25; index++) {
    await store.append(event({ token: { address: `INDEX-${index}` }, raw: { index }, normalized: { index } }));
  }
  const repeatedReads = read.mock.calls.filter(call =>
    String(call.arguments[0]).endsWith('.ndjson')
  ).length;
  assert.equal(repeatedReads, 0);
  assert.equal((await store.read()).length, 26);
});

test('scanner timestamps GMGN snapshots when observed, not when the token was created', async t => {
  const dir = temporary(t);
  const store = new EventStore(dir);
  const state = new RadarState(path.join(dir, 'state'));
  const creationSec = 1_800_000_000;
  const address = `0x${'a'.repeat(40)}`;
  const scanner = new Scanner({
    gmgn: { keyEpoch: 0, nextAllowedAt: 0, disabled: false, metrics: {} },
    state,
    eventStore: store,
    settings: { ...config, chain: 'bsc' }
  });
  const observedAt = Date.now();
  await scanner.persistDiscoveryEvents({
    byStage: {
      completed: [{
        address,
        symbol: 'PIT',
        creation_timestamp: creationSec,
        liquidity: 10_000,
        raw: { creation_timestamp: creationSec }
      }]
    }
  }, 'bsc', observedAt);

  const [row] = await store.read({ chain: 'bsc', stage: 'completed' });
  assert.equal(row.observedAt, observedAt);
  assert.notEqual(row.observedAt, creationSec * 1000);
  assert.equal(row.raw.creation_timestamp, creationSec);
});

test('discovery events never trust zero, seconds-less or implausible future timestamps', async t => {
  const dir = temporary(t);
  const store = new EventStore(dir);
  const state = new RadarState(path.join(dir, 'state'));
  const scanner = new Scanner({
    gmgn: { keyEpoch: 0, nextAllowedAt: 0, disabled: false, metrics: {} },
    state,
    eventStore: store,
    settings: { ...config, chain: 'bsc' }
  });
  const startedAt = Date.now();
  const row = (suffix, observedAt) => ({
    address: `0x${suffix.repeat(40)}`,
    symbol: `T${suffix}`,
    observedAt,
    liquidity: 10_000
  });
  await scanner.persistDiscoveryEvents({
    byStage: {
      completed: [
        row('1', 0),
        row('2', 'not-a-time'),
        row('3', startedAt + 2 * 86_400_000),
        row('4', Math.floor(startedAt / 1000))
      ]
    }
  }, 'bsc', startedAt);

  const rows = await store.read({ chain: 'bsc', stage: 'completed' });
  const bySymbol = Object.fromEntries(rows.map(entry => [entry.token.symbol, entry.observedAt]));
  assert.equal(bySymbol.T1, startedAt, 'a zero timestamp must fall back to the fetch time');
  assert.equal(bySymbol.T2, startedAt, 'an unparseable timestamp must fall back to the fetch time');
  assert.equal(bySymbol.T3, startedAt, 'a future timestamp must not leak into point-in-time data');
  assert.equal(bySymbol.T4, Math.floor(startedAt / 1000) * 1000, 'second-precision timestamps stay supported');
  assert.ok(rows.every(entry => entry.observedAt <= Date.now()), 'stored observations must never be future dated');
});
