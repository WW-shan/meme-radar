import test from 'node:test';
import assert from 'node:assert/strict';
import { DiscoveryOrchestrator } from '../src/discovery/orchestrator.mjs';
import { Scanner } from '../src/scanner.mjs';

test('orchestrator keeps lifecycle stages separate, deduplicates, and records health', async () => {
  const sources = [
    { name: 'gmgn-new-a', read: async () => ({ stage: 'new_creation', rows: [{ address: 'A' }, { address: 'A' }] }) },
    { name: 'gmgn-new-b', read: async () => ({ stage: 'new_creation', rows: [{ address: 'A' }, { address: 'B' }] }) },
    { name: 'gmgn-completed', read: async () => ({ stage: 'completed', rows: [{ address: 'A' }] }) }
  ];
  const result = await new DiscoveryOrchestrator(sources).run('sol');
  assert.deepEqual(result.byStage.new_creation.map(row => row.address), ['A', 'B']);
  assert.deepEqual(result.byStage.completed.map(row => row.address), ['A']);
  assert.equal(result.health['gmgn-new-a'].status, 'OK');
  assert.equal(result.health['gmgn-new-a'].count, 1);
  assert.equal(result.summary.complete, true);
});

test('orchestrator isolates source failures and rejects unknown stages', async () => {
  const result = await new DiscoveryOrchestrator([
    { name: 'bad-stage', read: async () => ({ stage: 'unknown', rows: [{ address: 'A' }] }) },
    { name: 'failed', read: async () => { throw Object.assign(new Error('down'), { code: 'SOURCE_DOWN' }); } },
    { name: 'good', read: async () => ({ stage: 'completed', rows: [{ address: 'B' }] }) }
  ]).run('sol');
  assert.deepEqual(result.byStage.completed.map(row => row.address), ['B']);
  assert.equal(result.health['bad-stage'].code, 'UNKNOWN_STAGE');
  assert.equal(result.health.failed.code, 'SOURCE_DOWN');
  assert.equal(result.health.good.status, 'OK');
  assert.equal(result.summary.complete, false);
});

test('orchestrator rejects rows without addresses without dropping the source batch', async () => {
  const result = await new DiscoveryOrchestrator([
    { name: 'invalid-row', read: async () => ({ stage: 'completed', rows: [{ address: '' }, { address: 'B' }] }) }
  ]).run('sol');
  assert.deepEqual(result.byStage.completed, []);
  assert.equal(result.health['invalid-row'].code, 'INVALID_SOURCE_ROW');
});

test('scanner keeps risk-radar on completed discovery and enables staged sources only in early-discovery', async () => {
  const gmgn = {
    discover: async () => [{ address: 'COMPLETED' }],
    discoverStage: async (chain, stage) => [{ address: stage }],
    signals: async () => [{ address: 'SIGNAL' }]
  };
  const scanner = Object.create(Scanner.prototype);
  scanner.gmgn = gmgn;
  scanner.config = { productMode: 'risk-radar' };
  const defaultSources = scanner.discoverySources();
  assert.deepEqual(defaultSources.map(source => source.name), ['gmgn-completed']);
  assert.deepEqual(await defaultSources[0].read('sol'), { stage: 'completed', rows: [{ address: 'COMPLETED' }] });

  scanner.config = { productMode: 'early-discovery' };
  const earlySources = scanner.discoverySources();
  assert.deepEqual(earlySources.map(source => source.name), ['gmgn-completed', 'gmgn-new', 'gmgn-near', 'gmgn-signals']);
});
