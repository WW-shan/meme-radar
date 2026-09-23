import test from 'node:test';
import assert from 'node:assert/strict';
import { runLiveIntegration } from '../scripts/testing/live-integration.mjs';
import { GmgnClient } from '../src/gmgn.mjs';

function rpcResponse(result) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    status: 200, headers: { 'content-type': 'application/json' }
  });
}

test('live integration reports RPC checks and skips GMGN without a project key', async () => {
  const fetchImpl = async (_url, request) => {
    const { method } = JSON.parse(request.body);
    if (method === 'getHealth') return rpcResponse('ok');
    if (method === 'getSlot') return rpcResponse(123456);
    if (method === 'eth_blockNumber') return rpcResponse('0x64');
    if (method === 'eth_getLogs') return rpcResponse([]);
    throw new Error(`unexpected ${method}`);
  };
  const result = await runLiveIntegration({
    fetchImpl,
    keyProvider: () => '',
    chains: ['sol', 'bsc'],
    blocks: 10,
    rpcUrls: { sol: 'https://sol.example', bsc: 'https://bsc.example' }
  });
  assert.equal(result.ok, true);
  assert.equal(result.checks.solana.status, 'OK');
  assert.equal(result.checks.solana.slot, 123456);
  assert.equal(result.checks.evm.bsc.status, 'OK');
  assert.equal(result.checks.evm.bsc.latestBlock, 100);
  assert.equal(result.checks.gmgn.status, 'SKIPPED');
});

test('live integration fails closed when an enabled RPC is unavailable', async () => {
  const result = await runLiveIntegration({
    fetchImpl: async () => new Response('down', { status: 503 }),
    keyProvider: () => '',
    chains: ['eth'],
    blocks: 10,
    rpcUrls: { eth: 'https://eth.example' }
  });
  assert.equal(result.ok, false);
  assert.equal(result.checks.evm.eth.status, 'FAIL');
  assert.match(result.checks.evm.eth.errorCode, /CHAIN_RPC/);
});

test('live integration resolves an async GMGN key provider before constructing the client', async () => {
  const key = `gmgn_${'a'.repeat(32)}`;
  const originalRun = GmgnClient.prototype.run;
  let seenKey = '';
  GmgnClient.prototype.run = async function () {
    seenKey = this.apiKey();
    return { completed: [], rank: [] };
  };
  try {
    const result = await runLiveIntegration({
      fetchImpl: async () => { throw new Error('unexpected RPC request'); },
      keyProvider: async () => key,
      chains: []
    });
    assert.equal(result.checks.gmgn.status, 'OK');
    assert.equal(seenKey, key);
  } finally {
    GmgnClient.prototype.run = originalRun;
  }
});
