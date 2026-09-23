import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChainCursorStore, openChainCursorStore } from '../src/chain/cursor-store.mjs';
import { createChainEventSources } from '../src/chain/sources.mjs';

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-chain-cursors-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function rpcFetch({ latestBlock }) {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    if (body.method === 'eth_blockNumber') {
      return { ok: true, json: async () => ({ result: `0x${latestBlock.toString(16)}` }) };
    }
    if (body.method === 'eth_getLogs') {
      return { ok: true, json: async () => ({ result: [] }) };
    }
    throw new Error(`unexpected method ${body.method}`);
  };
  return { calls, fetchImpl };
}

test('chain cursor store persists strings and block numbers atomically', t => {
  const directory = temporary(t);
  const store = new ChainCursorStore(directory);
  store.set('solana-migration', '5'.repeat(88));
  store.set('evm-bsc-pool', 12345);

  const restored = new ChainCursorStore(directory);
  assert.equal(restored.get('solana-migration'), '5'.repeat(88));
  assert.equal(restored.get('evm-bsc-pool'), 12345);
  assert.equal(restored.get('missing'), null);
});

test('chain cursor store rejects corruption instead of silently rewinding', t => {
  const directory = temporary(t);
  fs.writeFileSync(path.join(directory, 'chain-cursors.json'), JSON.stringify({ version: 1, cursors: { bad: {} } }));
  assert.throws(() => new ChainCursorStore(directory), error => error.code === 'CHAIN_CURSOR_CORRUPT');
});

test('EVM source resumes from the persisted next block after a restart', async t => {
  const directory = temporary(t);
  const factory = {
    address: '0x1111111111111111111111111111111111111111',
    topic: `0x${'aa'.repeat(32)}`
  };
  const config = {
    chainEventsEnabled: true,
    stateDir: directory,
    evmRpcUrls: { bsc: 'https://rpc.example' },
    evmFactories: { bsc: [factory] },
    evmStartBlocks: { bsc: 10 }
  };

  // Reported heads trail by EVM_HEAD_LAG_BLOCKS (3): safe heads are 12 and 14.
  const first = rpcFetch({ latestBlock: 15 });
  await createChainEventSources(config, { fetchImpl: first.fetchImpl })[1].read('bsc');
  assert.equal(new ChainCursorStore(directory).get('evm-bsc-pool'), 12);

  const second = rpcFetch({ latestBlock: 17 });
  await createChainEventSources(config, { fetchImpl: second.fetchImpl })[1].read('bsc');
  const lookup = second.calls.find(call => call.method === 'eth_getLogs');
  assert.deepEqual(lookup.params[0].fromBlock, '0xd');
  assert.deepEqual(lookup.params[0].toBlock, '0xe');
  assert.equal(new ChainCursorStore(directory).get('evm-bsc-pool'), 14);
});

test('opening a corrupt cursor file quarantines it and resumes from a clean store', t => {
  const directory = temporary(t);
  const file = path.join(directory, 'chain-cursors.json');
  const corruptBytes = JSON.stringify({ version: 1, cursors: { bad: {} } });
  fs.writeFileSync(file, corruptBytes);
  const seen = [];
  const store = openChainCursorStore(directory, { onCorrupt: info => seen.push(info) });

  assert.equal(store.get('evm-bsc-pool'), null);
  store.set('evm-bsc-pool', 7);
  assert.equal(new ChainCursorStore(directory).get('evm-bsc-pool'), 7);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].code, 'CHAIN_CURSOR_CORRUPT');
  assert.equal(seen[0].quarantined.length, 1);
  assert.equal(fs.readFileSync(seen[0].quarantined[0], 'utf8'), corruptBytes,
    'the corrupt file must be preserved for inspection');
});

test('opening a healthy cursor file never quarantines or rewrites it', t => {
  const directory = temporary(t);
  new ChainCursorStore(directory).set('solana-migration', 'sig-1');
  const before = fs.readFileSync(path.join(directory, 'chain-cursors.json'), 'utf8');
  let calls = 0;
  const store = openChainCursorStore(directory, { onCorrupt: () => { calls++; } });

  assert.equal(store.get('solana-migration'), 'sig-1');
  assert.equal(calls, 0);
  assert.deepEqual(fs.readdirSync(directory).sort(), ['chain-cursors.json']);
  assert.equal(fs.readFileSync(path.join(directory, 'chain-cursors.json'), 'utf8'), before);
});
