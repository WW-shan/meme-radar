import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChainCursorStore } from '../src/chain/cursor-store.mjs';
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

  const first = rpcFetch({ latestBlock: 12 });
  await createChainEventSources(config, { fetchImpl: first.fetchImpl })[1].read('bsc');
  assert.equal(new ChainCursorStore(directory).get('evm-bsc-pool'), 12);

  const second = rpcFetch({ latestBlock: 14 });
  await createChainEventSources(config, { fetchImpl: second.fetchImpl })[1].read('bsc');
  const lookup = second.calls.find(call => call.method === 'eth_getLogs');
  assert.deepEqual(lookup.params[0].fromBlock, '0xd');
  assert.deepEqual(lookup.params[0].toBlock, '0xe');
  assert.equal(new ChainCursorStore(directory).get('evm-bsc-pool'), 14);
});
