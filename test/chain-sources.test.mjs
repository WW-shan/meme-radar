import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SolanaEventSource, parseSolanaMigrationTransaction } from '../src/chain/solana-source.mjs';
import { EvmEventSource } from '../src/chain/evm-source.mjs';
import { createChainEventSources } from '../src/chain/sources.mjs';
import { DiscoveryOrchestrator } from '../src/discovery/orchestrator.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/solana-events.json'), 'utf8'));

test('Solana source parses only verified migration transactions and deduplicates signatures', async () => {
  const calls = [];
  const rpc = {
    call: async (method, params) => {
      calls.push([method, params]);
      if (method === 'getSignaturesForAddress') return { result: fixture.signatures };
      if (method === 'getTransaction') return { result: fixture.transactions[params[0]] || null };
      throw new Error('unexpected method');
    }
  };
  const source = new SolanaEventSource({
    rpc,
    migrationAuthority: 'MIGRATION_AUTHORITY',
    programId: 'MIGRATION_PROGRAM'
  });
  const result = await source.poll({ before: 'cursor-before', limit: 3 });
  assert.equal(result.events.length, 1);
  assert.deepEqual(result.events[0], {
    type: 'migration', chain: 'sol', signature: 'sig-migration-1', slot: 101,
    blockTime: 1800000000, observedAt: 1800000000000,
    token: { address: 'So11111111111111111111111111111111111111112' },
    programId: 'MIGRATION_PROGRAM', readOnly: true
  });
  assert.equal(result.cursor, 'sig-migration-1');
  assert.equal(result.hasMore, true);
  assert.equal(calls.filter(([method]) => method === 'getTransaction').length, 2);
});

test('Solana parser rejects failed, missing, and unrelated migration instructions', () => {
  assert.equal(parseSolanaMigrationTransaction({ meta: { err: { code: 1 } } }, { programId: 'MIGRATION_PROGRAM' }), null);
  assert.equal(parseSolanaMigrationTransaction({ meta: { err: null }, transaction: { message: { instructions: [] } } }, { programId: 'MIGRATION_PROGRAM' }), null);
  assert.equal(parseSolanaMigrationTransaction(fixture.transactions['sig-noise-1'], { programId: 'MIGRATION_PROGRAM' }), null);
});

test('Solana source reports UNCONFIGURED without an RPC or authority', async () => {
  const source = new SolanaEventSource({ migrationAuthority: 'MIGRATION_AUTHORITY', programId: 'MIGRATION_PROGRAM' });
  await assert.rejects(source.poll(), error => error.code === 'CHAIN_SOURCE_UNCONFIGURED');
});

test('Solana source uses until for forward polling and keeps the newest cursor', async () => {
  const calls = [];
  const rpc = { call: async (method, params) => { calls.push([method, params]); return { result: [] }; } };
  const source = new SolanaEventSource({ rpc, migrationAuthority: 'AUTHORITY', programId: 'PROGRAM' });
  const result = await source.poll({ until: 'newest-known-signature' });
  assert.deepEqual(calls[0][1][1], { limit: 1000, until: 'newest-known-signature' });
  assert.equal(result.cursor, 'newest-known-signature');
});

test('EVM source unwraps result, filters factory/topic, decodes token and deduplicates logs', async () => {
  const calls = [];
  const factory = {
    address: '0x1111111111111111111111111111111111111111',
    topic: '0x' + 'aa'.repeat(32),
    decode: log => ({ tokenAddress: '0x' + log.topics[1].slice(-40) })
  };
  const logs = [
    { address: factory.address, topics: [factory.topic, '0x' + '2'.repeat(64)], transactionHash: '0xtx1', blockNumber: '0x10', logIndex: '0x0' },
    { address: '0x' + '9'.repeat(40), topics: [factory.topic], transactionHash: '0xtx2', blockNumber: '0x10', logIndex: '0x1' },
    { address: factory.address, topics: ['0x' + 'bb'.repeat(32)], transactionHash: '0xtx3', blockNumber: '0x10', logIndex: '0x2' },
    { address: factory.address, topics: [factory.topic, '0x' + '2'.repeat(64)], transactionHash: '0xtx1', blockNumber: '0x10', logIndex: '0x0' }
  ];
  const rpc = { call: async (method, params) => { calls.push([method, params]); return { result: logs }; } };
  const source = new EvmEventSource({ rpc, factories: { bsc: [factory] } });
  const result = await source.poll({ chain: 'bsc', fromBlock: 1, toBlock: 2 });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].type, 'pool_created');
  assert.equal(result.events[0].token.address.toLowerCase(), '0x' + '2'.repeat(40));
  assert.equal(result.events[0].readOnly, true);
  assert.equal(result.cursor, 2);
  assert.deepEqual(calls[0], ['eth_getLogs', [{ address: factory.address, fromBlock: '0x1', toBlock: '0x2', topics: [factory.topic] }]]);
});

test('EVM source reports UNCONFIGURED for an unconfigured chain', async () => {
  const source = new EvmEventSource({ rpc: { call: async () => [] }, factories: { bsc: [] } });
  await assert.rejects(source.poll({ chain: 'bsc', fromBlock: 1, toBlock: 2 }), error => error.code === 'CHAIN_SOURCE_UNCONFIGURED');
});

test('chain source factory stays disabled by default and reports UNCONFIGURED when enabled without RPC', async () => {
  assert.deepEqual(createChainEventSources({ chainEventsEnabled: false }), []);
  const sources = createChainEventSources({ chainEventsEnabled: true });
  assert.equal(sources.length, 4);
  const result = await new DiscoveryOrchestrator(sources).run('sol');
  assert.equal(result.health['solana-migration'].status, 'UNCONFIGURED');
  assert.equal(result.summary.complete, false);
  assert.equal(result.summary.unconfigured, true);
});

test('configured Solana and EVM sources emit orchestrator-ready rows through the real RPC client', async () => {
  const solConfig = {
    chainEventsEnabled: true,
    solanaRpcUrl: 'https://sol-rpc.example',
    solanaMigrationAuthority: 'MIGRATION_AUTHORITY',
    solanaMigrationProgram: 'MIGRATION_PROGRAM'
  };
  const solFetch = async (_url, request) => {
    const { method, params } = JSON.parse(request.body);
    const result = method === 'getSignaturesForAddress'
      ? fixture.signatures
      : fixture.transactions[params[0]] || null;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  };
  const solResult = await new DiscoveryOrchestrator(
    createChainEventSources(solConfig, { fetchImpl: solFetch })
  ).run('sol');
  assert.equal(solResult.byStage.migrated.length, 1);
  assert.equal(solResult.byStage.migrated[0].address, 'So11111111111111111111111111111111111111112');
  assert.equal(solResult.health['solana-migration'].status, 'OK');

  const factory = {
    address: '0x1111111111111111111111111111111111111111',
    topic: '0x' + 'aa'.repeat(32)
  };
  const evmConfig = {
    chainEventsEnabled: true,
    evmRpcUrls: { bsc: 'https://bsc-rpc.example' },
    evmFactories: { bsc: [factory] }
  };
  const evmCalls = [];
  const evmFetch = async (_url, request) => {
    const { method, params } = JSON.parse(request.body);
    evmCalls.push([method, params]);
    const result = method === 'eth_blockNumber' ? '0x10' : [{
      address: factory.address,
      topics: [factory.topic, '0x' + '2'.repeat(64)],
      transactionHash: '0xtx1', blockNumber: '0x10', logIndex: '0x0'
    }];
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  };
  const evmResult = await new DiscoveryOrchestrator(
    createChainEventSources(evmConfig, { fetchImpl: evmFetch })
  ).run('bsc');
  assert.equal(evmResult.byStage.new_creation.length, 1);
  assert.equal(evmResult.byStage.new_creation[0].address.toLowerCase(), '0x' + '2'.repeat(40));
  assert.deepEqual(evmCalls[0], ['eth_blockNumber', []]);
  assert.deepEqual(evmCalls[1], ['eth_getLogs', [{
    address: factory.address, fromBlock: '0x0', toBlock: '0x10', topics: [factory.topic]
  }]]);
});
