import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventStore } from '../src/evaluation/event-store.mjs';
import { RadarState } from '../src/state.mjs';

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
