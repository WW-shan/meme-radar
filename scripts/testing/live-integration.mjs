#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../../src/config.mjs';
import { JsonRpcClient } from '../../src/chain/rpc.mjs';
import { EvmEventSource } from '../../src/chain/evm-source.mjs';
import { GmgnClient } from '../../src/gmgn.mjs';
import { GmgnKeyStore } from '../../src/gmgn-key-store.mjs';

const PAIR_CREATED = '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9';
const DEFAULT_RPC_URLS = Object.freeze({
  sol: 'https://api.mainnet.solana.com',
  bsc: 'https://bsc-rpc.publicnode.com',
  eth: 'https://ethereum-rpc.publicnode.com',
  base: 'https://mainnet.base.org'
});
const DEFAULT_FACTORIES = Object.freeze({
  bsc: Object.freeze([Object.freeze({
    address: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
    topic: PAIR_CREATED,
    tokenTopicIndexes: Object.freeze([1, 2]),
    excludeTokens: Object.freeze([
      '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
      '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
      '0x55d398326f99059fF775485246999027B3197955'
    ])
  })]),
  eth: Object.freeze([Object.freeze({
    address: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
    topic: PAIR_CREATED,
    tokenTopicIndexes: Object.freeze([1, 2]),
    excludeTokens: Object.freeze([
      '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      '0x6B175474E89094C44Da98b954EedeAC495271d0F'
    ])
  })])
});

function failure(error) {
  return {
    status: 'FAIL',
    errorCode: String(error?.code || 'LIVE_CHECK_FAILED'),
    message: String(error?.message || error || 'unknown error').slice(0, 240)
  };
}

async function checkSolana(url, fetchImpl) {
  const rpc = new JsonRpcClient(url, { fetchImpl });
  const health = await rpc.call('getHealth');
  const slot = Number(await rpc.call('getSlot'));
  if (health !== 'ok' || !Number.isSafeInteger(slot) || slot < 0) throw new Error('invalid Solana RPC response');
  return { status: 'OK', endpoint: url, health, slot };
}

async function checkEvm(chain, url, fetchImpl, blocks) {
  const rpc = new JsonRpcClient(url, { fetchImpl });
  const latestBlock = Number(BigInt(await rpc.call('eth_blockNumber')));
  if (!Number.isSafeInteger(latestBlock) || latestBlock < 0) throw new Error('invalid EVM block number');
  const factories = DEFAULT_FACTORIES[chain] || [];
  if (!factories.length) return { status: 'OK', endpoint: url, latestBlock, events: null, sourceConfigured: false };
  const span = Math.max(1, Math.min(10_000, Number(blocks) || 1000));
  const fromBlock = Math.max(0, latestBlock - span);
  const polled = await new EvmEventSource({ rpc, factories: { [chain]: factories } })
    .poll({ chain, fromBlock, toBlock: latestBlock });
  return {
    status: 'OK',
    endpoint: url,
    latestBlock,
    fromBlock,
    toBlock: latestBlock,
    events: polled.events.length,
    sourceConfigured: true
  };
}

async function checkGmgn(keyProvider, client) {
  const key = await keyProvider();
  if (!key) return { status: 'SKIPPED', reason: 'GMGN project key is not configured' };
  try {
    // GmgnClient reads its key synchronously when it launches each worker. Pass
    // the already-resolved value instead of the async provider, otherwise the
    // Promise is treated as an empty key and live checks falsely report auth failure.
    const gmgn = client || new GmgnClient({ apiKeyProvider: () => key, legacyKeyProvider: () => '' });
    const adapter = await gmgn.probe();
    if (adapter.status !== 'OK') return { status: 'FAIL', errorCode: adapter.code || 'GMGN_ADAPTER_INCOMPATIBLE' };
    const rows = await gmgn.discover('sol');
    if (!Array.isArray(rows)) throw Object.assign(new Error('GMGN discovery did not return a list'), { code: 'GMGN_INVALID_RESPONSE' });
    return { status: 'OK', adapterCode: adapter.code || 'OK', discovered: rows.length };
  } catch (error) {
    return failure(error);
  }
}

export async function runLiveIntegration({
  fetchImpl = globalThis.fetch,
  keyProvider = async () => '',
  gmgnClient = null,
  chains = ['sol', 'bsc', 'eth'],
  blocks = 1000,
  rpcUrls = {}
} = {}) {
  const selected = [...new Set((Array.isArray(chains) ? chains : []).map(chain => String(chain).toLowerCase()))];
  const checks = { solana: null, evm: {}, gmgn: null };
  if (selected.includes('sol')) {
    try { checks.solana = await checkSolana(rpcUrls.sol || DEFAULT_RPC_URLS.sol, fetchImpl); }
    catch (error) { checks.solana = failure(error); }
  }
  for (const chain of selected.filter(value => value !== 'sol')) {
    if (!DEFAULT_RPC_URLS[chain] && !rpcUrls[chain]) {
      checks.evm[chain] = failure(Object.assign(new Error(`unsupported live chain: ${chain}`), { code: 'UNSUPPORTED_CHAIN' }));
      continue;
    }
    try { checks.evm[chain] = await checkEvm(chain, rpcUrls[chain] || DEFAULT_RPC_URLS[chain], fetchImpl, blocks); }
    catch (error) { checks.evm[chain] = failure(error); }
  }
  checks.gmgn = await checkGmgn(keyProvider, gmgnClient);
  const failed = [checks.solana, ...Object.values(checks.evm), checks.gmgn]
    .filter(check => check && check.status === 'FAIL');
  return { ok: failed.length === 0, checkedAt: Date.now(), checks };
}

function parseArgs(argv = []) {
  const args = { chains: ['sol', 'bsc', 'eth'], blocks: 1000 };
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--chains') args.chains = String(argv[++index] || '').split(',').map(value => value.trim()).filter(Boolean);
    else if (token === '--blocks') args.blocks = Number(argv[++index]);
    else throw Object.assign(new Error(`unexpected argument: ${token}`), { code: 'INVALID_ARGUMENT' });
  }
  return args;
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await runLiveIntegration({
      ...args,
      keyProvider: async () => {
        if (!fs.existsSync(path.join(config.stateDir, 'gmgn-api-key'))) return '';
        return new GmgnKeyStore(config.stateDir).get();
      }
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error?.message || 'live integration failed');
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) await main();
