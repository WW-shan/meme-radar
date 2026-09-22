import test from 'node:test';
import assert from 'node:assert/strict';
import { LifecycleTracker } from '../src/discovery/lifecycle.mjs';
import { GmgnClient } from '../src/gmgn.mjs';

test('lifecycle transitions only forward and keeps observed time', () => {
  const tracker = new LifecycleTracker();
  tracker.observe({ chain: 'sol', address: 'A', stage: 'new_creation', observedAt: 1 });
  tracker.observe({ chain: 'sol', address: 'A', stage: 'near_completion', observedAt: 2 });
  tracker.observe({ chain: 'sol', address: 'A', stage: 'completed', observedAt: 3 });
  assert.deepEqual(tracker.get('sol', 'A').history.map(row => row.stage), ['new_creation', 'near_completion', 'completed']);
  assert.deepEqual(tracker.get('sol', 'A').history.map(row => row.observedAt), [1, 2, 3]);
});

test('backward and out-of-order observations become conflicts instead of overwriting history', () => {
  const tracker = new LifecycleTracker();
  tracker.observe({ chain: 'sol', address: 'A', stage: 'completed', observedAt: 2 });
  tracker.observe({ chain: 'sol', address: 'A', stage: 'new_creation', observedAt: 3 });
  tracker.observe({ chain: 'sol', address: 'A', stage: 'migrated', observedAt: 1 });
  const row = tracker.get('sol', 'A');
  assert.deepEqual(row.history.map(item => item.stage), ['completed']);
  assert.equal(row.conflicts.length, 2);
  assert.equal(tracker.stageFor('sol', 'A'), 'completed');
});

test('same-stage observations are idempotent and update only lastObservedAt', () => {
  const tracker = new LifecycleTracker();
  tracker.observe({ chain: 'sol', address: 'A', stage: 'new_creation', observedAt: 1 });
  tracker.observe({ chain: 'sol', address: 'A', stage: 'new_creation', observedAt: 2 });
  assert.equal(tracker.get('sol', 'A').history.length, 1);
  assert.equal(tracker.get('sol', 'A').history[0].lastObservedAt, 2);
});

test('lifecycle keys isolate chains and signal is not a lifecycle state', () => {
  const tracker = new LifecycleTracker();
  tracker.observe({ chain: 'sol', address: 'A', stage: 'completed', observedAt: 1 });
  tracker.observe({ chain: 'bsc', address: 'A', stage: 'new_creation', observedAt: 2 });
  assert.equal(tracker.stageFor('sol', 'A'), 'completed');
  assert.equal(tracker.stageFor('bsc', 'A'), 'new_creation');
  assert.throws(() => tracker.observe({ chain: 'sol', address: 'A', stage: 'signal', observedAt: 3 }), error => error.code === 'SIGNAL_NOT_LIFECYCLE');
});

test('lifecycle snapshot restores without sharing mutable history', () => {
  const first = new LifecycleTracker();
  first.observe({ chain: 'sol', address: 'A', stage: 'near_completion', observedAt: 4 });
  const restored = new LifecycleTracker(first.snapshot());
  restored.observe({ chain: 'sol', address: 'A', stage: 'completed', observedAt: 5 });
  assert.deepEqual(first.get('sol', 'A').history.map(row => row.stage), ['near_completion']);
  assert.deepEqual(restored.get('sol', 'A').history.map(row => row.stage), ['near_completion', 'completed']);
});

test('lifecycle stages use distinct audit depths', async () => {
  const client = new GmgnClient();
  const calls = [];
  client.cachedRead = async args => { calls.push(args[1]); return {}; };
  const address = '0x' + '1'.repeat(40);
  await client.auditStage(address, 'new_creation', 1_800_000_000, 'bsc');
  assert.deepEqual(calls, ['info', 'security', 'pool']);
  calls.length = 0;
  await client.auditStage(address, 'near_completion', 1_800_000_000, 'bsc');
  assert.deepEqual(calls, ['info', 'security', 'pool', 'holders', 'traders']);
  calls.length = 0;
  await client.auditStage(address, 'completed', 1_800_000_000, 'bsc');
  assert.deepEqual(calls, ['info', 'security', 'pool', 'holders', 'traders', 'kline']);
});
