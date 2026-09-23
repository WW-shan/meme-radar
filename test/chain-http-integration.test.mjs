import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createChainEventSources } from '../src/chain/sources.mjs';
import { SolanaEventSource } from '../src/chain/solana-source.mjs';
import { JsonRpcClient } from '../src/chain/rpc.mjs';
import { ChainCursorStore } from '../src/chain/cursor-store.mjs';
import { DiscoveryOrchestrator } from '../src/discovery/orchestrator.mjs';

async function startRpc(handle) {
  const calls = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      let payload;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        calls.push(body);
        payload = { jsonrpc: '2.0', id: body.id ?? null, result: handle(body, calls.length) };
      } catch (error) {
        payload = { jsonrpc: '2.0', id: null, error: { code: -32000, message: error.message } };
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    calls,
    logs: () => calls.filter(row => row.method === 'eth_getLogs').map(row => row.params[0]),
    close: () => new Promise(resolve => server.close(resolve))
  };
}

function temporaryDirectory(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const factory = {
  address: '0x1111111111111111111111111111111111111111',
  topic: `0x${'aa'.repeat(32)}`
};

function bscLog(blockNumber) {
  return {
    address: factory.address,
    topics: [factory.topic, `0x${'2'.repeat(64)}`],
    transactionHash: `0xtx${blockNumber}`,
    blockNumber: `0x${blockNumber.toString(16)}`,
    logIndex: '0x0'
  };
}

test('EVM source walks a real RPC backlog in contiguous chunks across process restarts', async t => {
  const directory = temporaryDirectory(t, 'radar-evm-http-');
  const latest = 5000;
  const rpc = await startRpc(body => body.method === 'eth_blockNumber'
    ? `0x${latest.toString(16)}`
    : [bscLog(Number(BigInt(body.params[0].fromBlock)))]);
  t.after(() => rpc.close());
  const config = {
    chainEventsEnabled: true,
    stateDir: directory,
    evmRpcUrls: { bsc: rpc.url },
    evmFactories: { bsc: [factory] },
    evmInitialLookbackBlocks: 500,
    evmBlockChunkSize: 100
  };
  const readOnce = async chain => {
    const source = createChainEventSources(config).find(row => row.name === `evm-${chain}-pool`);
    return source.read(chain);
  };
  const first = await readOnce('bsc');
  assert.equal(first.rows[0].address.toLowerCase(), '0x' + '2'.repeat(40));
  assert.ok(first.rows[0].observedAt <= Date.now(), 'discovery rows must never be future dated');
  for (let index = 0; index < 5; index++) await readOnce('bsc');
  const ranges = rpc.logs().map(row => [Number(row.fromBlock), Number(row.toBlock)]);
  // Queries end EVM_HEAD_LAG_BLOCKS (3) behind the reported head.
  assert.deepEqual(ranges[0], [4498, 4597]);
  for (let index = 1; index < ranges.length; index++) {
    assert.equal(ranges[index][0], ranges[index - 1][1] + 1, 'backfill must not skip or overlap blocks');
  }
  assert.deepEqual(ranges.at(-1), [4898, 4997]);
  const settled = await readOnce('bsc');
  assert.deepEqual(settled.rows, []);
  assert.equal(rpc.logs().length, ranges.length, 'a caught-up source must not issue more log queries');
  assert.equal(new ChainCursorStore(directory).get('evm-bsc-pool'), latest - 3);
});

test('EVM source reports a broken RPC endpoint as health ERROR without advancing its cursor', async t => {
  const directory = temporaryDirectory(t, 'radar-evm-broken-');
  const server = http.createServer((request, response) => { response.writeHead(502); response.end('bad gateway'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const config = {
    chainEventsEnabled: true,
    stateDir: directory,
    evmRpcUrls: { bsc: `http://127.0.0.1:${server.address().port}/` },
    evmFactories: { bsc: [factory] }
  };
  const result = await new DiscoveryOrchestrator(createChainEventSources(config)).run('bsc');
  assert.equal(result.health['evm-bsc-pool'].status, 'ERROR');
  assert.equal(result.health['evm-bsc-pool'].code, 'CHAIN_RPC_ERROR');
  assert.deepEqual(result.byStage.new_creation, []);
  assert.equal(result.summary.complete, false);
  assert.equal(new ChainCursorStore(directory).get('evm-bsc-pool'), null);
});

test('RPC client turns a hung endpoint into a timeout instead of hanging the cycle', async t => {
  const server = http.createServer(() => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = new JsonRpcClient(`http://127.0.0.1:${server.address().port}/`, { timeoutMs: 50 });
  await assert.rejects(client.call('eth_blockNumber', []), error => error.code === 'CHAIN_RPC_TIMEOUT');
});

test('RPC client surfaces JSON-RPC error payloads as transport errors', async t => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'rate limited' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = new JsonRpcClient(`http://127.0.0.1:${server.address().port}/`);
  await assert.rejects(client.call('eth_blockNumber', []), error => error.code === 'CHAIN_RPC_ERROR');
});

function migrationTransaction(mint) {
  return {
    meta: { err: null },
    transaction: {
      message: {
        instructions: [{ programId: 'MIGRATION_PROGRAM', parsed: { type: 'migrate', info: { mint } } }]
      }
    }
  };
}

async function startSolanaRpc(signatures) {
  const state = { signatures, transactionCalls: [] };
  const rpc = await startRpc(body => {
    if (body.method === 'getSignaturesForAddress') {
      const [authority, options = {}] = body.params;
      assert.equal(authority, 'MIGRATION_AUTHORITY');
      const start = options.before ? state.signatures.indexOf(options.before) : 0;
      assert.ok(start >= 0, 'before cursor must exist in the stub chain');
      const rows = [];
      for (let index = start; index < state.signatures.length; index++) {
        const signature = state.signatures[index];
        if (signature === options.until || rows.length >= (options.limit || 1000)) break;
        rows.push({ signature, slot: 100 - index, blockTime: 1_800_000_000 });
      }
      return rows;
    }
    if (body.method === 'getTransaction') {
      state.transactionCalls.push(body.params[0]);
      return migrationTransaction(`MINT-${body.params[0]}`);
    }
    throw new Error(`unexpected method ${body.method}`);
  });
  return { ...rpc, state };
}

test('Solana source drains multiple real HTTP pages and never re-reads the cursor signature', async t => {
  const rpc = await startSolanaRpc(['sig-e', 'sig-d', 'sig-c', 'sig-b', 'sig-a']);
  t.after(() => rpc.close());
  const source = new SolanaEventSource({
    rpc: new JsonRpcClient(rpc.url),
    migrationAuthority: 'MIGRATION_AUTHORITY',
    programId: 'MIGRATION_PROGRAM'
  });
  const result = await source.poll({ until: 'sig-c', limit: 2 });
  assert.deepEqual(result.events.map(row => row.token.address), ['MINT-sig-e', 'MINT-sig-d']);
  assert.equal(result.cursor, 'sig-e');
  assert.equal(result.hasMore, false);
  assert.deepEqual(rpc.state.transactionCalls, ['sig-e', 'sig-d']);
  assert.equal(rpc.calls.filter(row => row.method === 'getSignaturesForAddress').length, 2);
});

test('Solana migration cursor survives restarts and stays free of duplicates and gaps', async t => {
  const directory = temporaryDirectory(t, 'radar-sol-http-');
  const rpc = await startSolanaRpc(['sig-e', 'sig-d', 'sig-c', 'sig-b', 'sig-a']);
  t.after(() => rpc.close());
  const config = {
    chainEventsEnabled: true,
    stateDir: directory,
    solanaRpcUrl: rpc.url,
    solanaMigrationAuthority: 'MIGRATION_AUTHORITY',
    solanaMigrationProgram: 'MIGRATION_PROGRAM'
  };
  const readOnce = async () => createChainEventSources(config)
    .find(row => row.name === 'solana-migration').read('sol');
  const first = await readOnce();
  assert.deepEqual(first.rows.map(row => row.address),
    ['MINT-sig-e', 'MINT-sig-d', 'MINT-sig-c', 'MINT-sig-b', 'MINT-sig-a']);
  assert.equal(new ChainCursorStore(directory).get('solana-migration'), 'sig-e');

  rpc.state.signatures.unshift('sig-h', 'sig-g', 'sig-f');
  rpc.state.transactionCalls = [];
  const second = await readOnce();
  assert.deepEqual(second.rows.map(row => row.address), ['MINT-sig-h', 'MINT-sig-g', 'MINT-sig-f']);
  assert.deepEqual(rpc.state.transactionCalls, ['sig-h', 'sig-g', 'sig-f'],
    'the saved cursor signature must never be fetched twice');
  assert.equal(new ChainCursorStore(directory).get('solana-migration'), 'sig-h');

  rpc.state.transactionCalls = [];
  const third = await readOnce();
  assert.deepEqual(third.rows, []);
  assert.deepEqual(rpc.state.transactionCalls, []);
});

test('Solana source keeps its cursor when a migration transaction is unavailable', async t => {
  const directory = temporaryDirectory(t, 'radar-sol-missing-');
  const rpc = await startRpc(body => {
    if (body.method === 'getSignaturesForAddress') {
      return [{ signature: 'sig-new', slot: 1, blockTime: 1_800_000_000 }];
    }
    return null;
  });
  t.after(() => rpc.close());
  const config = {
    chainEventsEnabled: true,
    stateDir: directory,
    solanaRpcUrl: rpc.url,
    solanaMigrationAuthority: 'MIGRATION_AUTHORITY',
    solanaMigrationProgram: 'MIGRATION_PROGRAM'
  };
  new ChainCursorStore(directory).set('solana-migration', 'sig-old');
  const result = await new DiscoveryOrchestrator(createChainEventSources(config)).run('sol');
  assert.equal(result.health['solana-migration'].status, 'ERROR');
  assert.equal(result.health['solana-migration'].code, 'CHAIN_SOURCE_INCOMPLETE');
  assert.deepEqual(result.byStage.migrated, []);
  assert.equal(new ChainCursorStore(directory).get('solana-migration'), 'sig-old');
});

test('chain source factory rejects a corrupt persisted EVM cursor before scanning', async t => {
  const directory = temporaryDirectory(t, 'radar-evm-corrupt-');
  fs.writeFileSync(path.join(directory, 'chain-cursors.json'), JSON.stringify({
    version: 1, cursors: { 'evm-bsc-pool': -5 }
  }));
  const config = {
    chainEventsEnabled: true,
    stateDir: directory,
    evmRpcUrls: { bsc: 'http://127.0.0.1:1/' },
    evmFactories: { bsc: [factory] }
  };
  assert.throws(() => createChainEventSources(config), error => error.code === 'CHAIN_CURSOR_CORRUPT');
  assert.throws(
    () => createChainEventSources(config, { cursorStore: { get: () => 'not-a-block', set: () => {} } }),
    error => error.code === 'CHAIN_CURSOR_CORRUPT'
  );
});
