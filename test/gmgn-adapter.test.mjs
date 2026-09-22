import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { GmgnAdapter, GMGN_ADAPTER_INCOMPATIBLE, GMGN_REQUIRED_METHODS } from '../src/gmgn-adapter.mjs';
import { config } from '../src/config.mjs';
import { Scanner } from '../src/scanner.mjs';
import { RadarState } from '../src/state.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = '1.5.7';

function completeClient(overrides = {}) {
  return Object.fromEntries(GMGN_REQUIRED_METHODS.map(name => [name, async () => ({})]).concat(Object.entries(overrides)));
}

test('adapter probes client.run and importClient injections uniformly', async () => {
  const runAdapter = new GmgnAdapter({ client: { run: async () => ({ ok: true }) } });
  assert.deepEqual(await runAdapter.probe(), {
    status: 'OK',
    code: 'GMGN_ADAPTER_OK',
    injection: 'client.run',
    missing: []
  });

  const imported = completeClient();
  const importAdapter = new GmgnAdapter({ importClient: async () => ({ client: imported, version }) });
  const result = await importAdapter.probe();
  assert.equal(result.status, 'OK');
  assert.equal(result.injection, 'importClient');
  assert.deepEqual(result.missing, []);
});

test('adapter reports a missing export without crashing', async () => {
  const adapter = new GmgnAdapter({ importClient: async () => { throw new Error('missing export'); } });
  const result = await adapter.probe();
  assert.equal(result.status, 'INCOMPATIBLE');
  assert.equal(result.code, GMGN_ADAPTER_INCOMPATIBLE);
  assert.equal(result.reason, 'IMPORT_ERROR');
  assert.deepEqual(result.missing, []);
});

test('adapter reports every missing method for partial and incomplete clients', async () => {
  const missingOne = completeClient();
  delete missingOne.getTokenKline;
  const single = await new GmgnAdapter({ importClient: async () => ({ client: missingOne, version }) }).probe();
  assert.equal(single.status, 'INCOMPATIBLE');
  assert.equal(single.code, GMGN_ADAPTER_INCOMPATIBLE);
  assert.deepEqual(single.missing, ['getTokenKline']);

  const partial = { getTrendingSwaps: async () => ({}), getTrenches: async () => ({}) };
  const result = await new GmgnAdapter({ importClient: async () => ({ client: partial, version }) }).probe();
  assert.equal(result.status, 'INCOMPATIBLE');
  assert.equal(result.reason, 'MISSING_METHODS');
  assert.deepEqual(result.missing, GMGN_REQUIRED_METHODS.filter(name => !partial[name]));
});

test('adapter times out and normalizes a hung client import', async () => {
  const adapter = new GmgnAdapter({ importClient: async () => new Promise(() => {}) });
  const result = await adapter.probe({ timeoutMs: 20 });
  assert.equal(result.status, 'INCOMPATIBLE');
  assert.equal(result.code, GMGN_ADAPTER_INCOMPATIBLE);
  assert.equal(result.reason, 'TIMEOUT');
});

test('adapter rejects an incompatible upstream client version', async () => {
  const adapter = new GmgnAdapter({
    importClient: async () => ({ client: completeClient(), version: '1.4.0' })
  });
  const result = await adapter.probe();
  assert.equal(result.status, 'INCOMPATIBLE');
  assert.equal(result.reason, 'VERSION_INCOMPATIBLE');
  assert.equal(result.expectedVersion, version);
  assert.equal(result.actualVersion, '1.4.0');
});

test('GMGN failure keeps direct chain events alive with deep data explicitly unavailable', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-gmgn-fallback-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const state = new RadarState(directory);
  state.value.activeChain = 'bsc';
  const nowSec = Date.now() / 1000;
  const row = {
    address: '0x' + '7'.repeat(40),
    symbol: 'FALLBACK',
    name: 'Fallback Event',
    market_cap: 50_000,
    creation_timestamp: nowSec - 3_600,
    liquidity: 10_000,
    rug_ratio: 0.1,
    bundler_rate: 0.1,
    rat_trader_amount_rate: 0.1,
    is_wash_trading: false,
    is_honeypot: false
  };
  let audits = 0;
  const gmgn = {
    keyEpoch: 0,
    nextAllowedAt: 0,
    disabled: false,
    metrics: { requests: 0, cacheHits: 0, rateLimits: 0 },
    configured: async () => false,
    discover: async () => { throw Object.assign(new Error('not configured'), { code: 'GMGN_AUTH_REQUIRED' }); },
    audit: async () => { audits++; throw new Error('must not audit without GMGN'); }
  };
  const scanner = new Scanner({
    gmgn,
    state,
    settings: { ...config, chain: 'bsc', maxDeepAuditsPerCycle: 1 },
    chainSources: [{ name: 'evm-bsc-pool', read: async () => ({ stage: 'completed', rows: [row] }) }]
  });

  await scanner.cycle();

  const candidate = state.value.candidates.find(item => item.address === row.address);
  assert.ok(candidate, 'direct chain event must survive GMGN failure');
  assert.equal(audits, 0);
  assert.equal(candidate.status, 'WAIT_RECHECK');
  assert.equal(candidate.deep.availability, 'UNAVAILABLE');
  assert.equal(candidate.deep.chainPass, false);
  assert.equal(candidate.auditHealth.available, false);
  assert.equal(state.value.sourceHealth.discovery.sources['evm-bsc-pool'].status, 'OK');
  assert.equal(state.value.status, 'DEGRADED');
});

test('a configured but incompatible GMGN client falls back without attempting deep audits', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-gmgn-incompatible-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const state = new RadarState(directory);
  state.value.activeChain = 'bsc';
  const nowSec = Date.now() / 1000;
  const row = {
    address: '0x' + '8'.repeat(40),
    symbol: 'INCOMPATIBLE',
    market_cap: 50_000,
    creation_timestamp: nowSec - 3_600,
    liquidity: 10_000,
    rug_ratio: 0.1,
    bundler_rate: 0.1,
    rat_trader_amount_rate: 0.1,
    is_wash_trading: false,
    is_honeypot: false
  };
  let audits = 0;
  const gmgn = {
    keyEpoch: 0,
    nextAllowedAt: 0,
    disabled: false,
    metrics: { requests: 0, cacheHits: 0, rateLimits: 0 },
    configured: async () => true,
    discover: async () => { throw Object.assign(new Error('missing method'), { code: GMGN_ADAPTER_INCOMPATIBLE }); },
    audit: async () => { audits++; throw new Error('incompatible GMGN must not be audited'); }
  };
  const scanner = new Scanner({
    gmgn,
    state,
    settings: { ...config, chain: 'bsc', maxDeepAuditsPerCycle: 1 },
    chainSources: [{ name: 'evm-bsc-pool', read: async () => ({ stage: 'completed', rows: [row] }) }]
  });

  await scanner.cycle();

  const candidate = state.value.candidates.find(item => item.address === row.address);
  assert.ok(candidate);
  assert.equal(audits, 0);
  assert.equal(candidate.deep.availability, 'UNAVAILABLE');
  assert.equal(candidate.auditHealth.code, GMGN_ADAPTER_INCOMPATIBLE);
  assert.equal(state.value.status, 'DEGRADED');
});

test('setup --check prints adapter status, missing methods and fallback sources', async () => {
  const { stdout } = await exec(process.execPath, ['scripts/setup.mjs', '--check'], {
    cwd: root,
    env: { ...process.env, RADAR_CHAIN_EVENTS: '0' }
  });
  assert.match(stdout, /GMGN适配器：OK/);
  assert.match(stdout, /缺失方法：无/);
  assert.match(stdout, /降级来源：/);
  assert.match(stdout, /RADAR_CHAIN_EVENTS/);
});
