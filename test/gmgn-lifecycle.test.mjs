import test from 'node:test';
import assert from 'node:assert/strict';
import { executeReadOnly } from '../src/gmgn-readonly-worker.mjs';
import { GmgnAdapter } from '../src/gmgn-adapter.mjs';
import { GmgnClient } from '../src/gmgn.mjs';

test('read-only worker accepts all lifecycle trenches stages and signals', async () => {
  const calls = [];
  const client = {
    getTrenches: async (...args) => { calls.push(['trenches', ...args]); return { new_creation: [], near_completion: [], completed: [] }; },
    getTokenSignalV2: async (...args) => { calls.push(['signals', ...args]); return { list: [] }; }
  };
  await executeReadOnly(client, ['market', 'trenches', '--chain', 'sol', '--type', 'new_creation', '--raw']);
  await executeReadOnly(client, ['market', 'trenches', '--chain', 'sol', '--type', 'near_completion', '--raw']);
  await executeReadOnly(client, ['market', 'trenches', '--chain', 'sol', '--type', 'completed', '--raw']);
  await executeReadOnly(client, ['market', 'signal', '--chain', 'sol', '--signal-type', '12,13', '--raw']);
  assert.deepEqual(calls.map(call => call[0]), ['trenches', 'trenches', 'trenches', 'signals']);
  assert.deepEqual(calls[0][2], ['new_creation']);
  assert.deepEqual(calls[3][2], [{ signal_type: [12, 13] }]);
});

test('read-only worker rejects forbidden signal types and invalid stages', async () => {
  const client = new Proxy({}, { get: () => async () => ({}) });
  await assert.rejects(executeReadOnly(client, ['market', 'trenches', '--chain', 'sol', '--type', 'unknown']), /Invalid discovery request/);
  await assert.rejects(executeReadOnly(client, ['market', 'signal', '--chain', 'sol', '--signal-type', '14']), /Invalid signal request/);
  await assert.rejects(executeReadOnly(client, ['market', 'signal', '--chain', 'sol', '--signal-type', '15,16']), /Invalid signal request/);
});

test('adapter supports injected run clients and direct read-only import clients', async () => {
  const runCalls = [];
  const runAdapter = new GmgnAdapter({ client: { run: async args => { runCalls.push(args); return { ok: true }; } } });
  assert.deepEqual(await runAdapter.discoverStage('sol', 'new_creation', 20), { ok: true });
  assert.deepEqual(runCalls[0], ['market', 'trenches', '--chain', 'sol', '--type', 'new_creation', '--limit', '20', '--raw']);

  const importCalls = [];
  const imported = {
    getTrenches: async (...args) => { importCalls.push(args); return { completed: [] }; }
  };
  const importAdapter = new GmgnAdapter({ importClient: async () => imported });
  assert.deepEqual(await importAdapter.discoverStage('sol', 'completed'), { completed: [] });
  assert.deepEqual(importCalls[0], ['sol', ['completed'], undefined, 80, undefined]);
});

test('adapter validates lifecycle arguments before calling a client', async () => {
  const adapter = new GmgnAdapter({ client: { run: async () => ({}) } });
  await assert.rejects(adapter.discoverStage('sol', 'unknown'), /invalid lifecycle stage/);
  await assert.rejects(adapter.discoverStage('sol', 'completed', 81), /invalid lifecycle limit/);
  await assert.rejects(adapter.signals('sol', [14]), /invalid signal types/);
});

test('GmgnClient exposes lifecycle and signal helpers without trading calls', async () => {
  const calls = [];
  const client = new GmgnClient();
  client.run = async args => { calls.push(args); return args[1] === 'signal' ? { list: [{ address: 'A' }] } : { completed: [{ address: 'A' }] }; };
  assert.deepEqual(await client.discoverStage('sol', 'completed'), [{ address: 'A' }]);
  assert.deepEqual(await client.signals('sol', [12]), [{ address: 'A' }]);
  assert.deepEqual(calls.map(args => args[1]), ['trenches', 'signal']);
  await assert.rejects(client.signals('sol', [14]), /Invalid signal request/);
});
