import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RiskMemory } from '../src/analytics/risk-memory.mjs';
import { RadarState } from '../src/state.mjs';

test('risk exclusion expires and permanent evidence survives explicit review', () => {
  const memory = new RiskMemory();
  memory.remember({ chain: 'sol', address: 'A', code: 'CHART_COLLAPSE', confidence: .8, at: 1, expiresAt: 100 });
  memory.remember({ chain: 'sol', address: 'B', code: 'MINTABLE', confidence: 1, at: 1, expiresAt: 0, permanent: true });
  assert.equal(memory.active('sol', 'A', 50).code, 'CHART_COLLAPSE');
  assert.equal(memory.active('sol', 'A', 101), null);
  assert.equal(memory.active('sol', 'B', 10_000).code, 'MINTABLE');
  assert.deepEqual(Object.keys(memory.toObject(101)), ['sol:B']);
});

test('risk memory deduplicates the same chain/address/code and preserves review state', () => {
  const memory = new RiskMemory();
  memory.remember({ chain: 'bsc', address: '0xAbC', code: 'CHART_COLLAPSE', at: 1, expiresAt: 10 });
  memory.remember({ chain: 'bsc', address: '0xabc', code: 'CHART_COLLAPSE', at: 2, expiresAt: 20, review: { state: 'revalidated' } });
  assert.equal(memory.serialize().length, 1);
  assert.equal(memory.active('bsc', '0xABC', 15).expiresAt, 20);
  assert.equal(memory.active('bsc', '0xABC', 15).review.state, 'revalidated');
});

test('risk exclusion projection preserves every code and reason for the same address', () => {
  const memory = new RiskMemory();
  memory.remember({ chain: 'sol', address: 'Mint', code: 'MINTABLE', reasons: ['mint authority active'], at: 1, expiresAt: 0 });
  memory.remember({ chain: 'sol', address: 'Mint', code: 'LOW_LIQUIDITY', reasons: ['liquidity below threshold'], at: 2, expiresAt: 0 });
  const projected = memory.toObject(10)['sol:Mint'];
  assert.deepEqual(projected.codes, ['MINTABLE', 'LOW_LIQUIDITY']);
  assert.deepEqual(projected.reasons, ['mint authority active', 'liquidity below threshold']);
});

test('legacy object state migrates to v4 riskMemory without dropping records', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-memory-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'radar.json'), JSON.stringify({
    version: 3,
    riskExclusions: {
      'bsc:0x1111111111111111111111111111111111111111': {
        chain: 'bsc', address: '0x1111111111111111111111111111111111111111', code: 'OLD_RISK', at: 1
      }
    }
  }));
  const state = new RadarState(dir);
  assert.equal(state.value.version, 4);
  assert.equal(state.value.riskMemory.length, 1);
  assert.equal(state.value.riskMemory[0].permanent, true);
  assert.equal(state.value.riskExclusions['bsc:0x1111111111111111111111111111111111111111'].code, 'OLD_RISK');
});

test('risk memory skips malformed persisted rows without losing valid evidence', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-memory-dirty-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'radar.json'), JSON.stringify({
    version: 4,
    riskMemory: [null, 'bad-row', {}, { chain: 'sol', address: 'GoodMint', code: 'KEEP', at: 1 }]
  }));
  const state = new RadarState(dir);
  assert.equal(state.value.riskMemory.length, 1);
  assert.equal(state.value.riskMemory[0].address, 'GoodMint');
  assert.equal(state.value.riskExclusions['sol:GoodMint'].code, 'KEEP');
});

test('migration falls back to legacy exclusions when every v4 risk-memory row is invalid', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-memory-fallback-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'radar.json'), JSON.stringify({
    version: 4,
    riskMemory: [null, {}, 'bad-row'],
    riskExclusions: {
      'bsc:0x1111111111111111111111111111111111111111': {
        chain: 'bsc', address: '0x1111111111111111111111111111111111111111', code: 'LEGACY_KEEP', at: 1
      }
    }
  }));
  const state = new RadarState(dir);
  assert.equal(state.value.riskMemory.length, 1);
  assert.equal(state.value.riskMemory[0].code, 'LEGACY_KEEP');
  assert.equal(state.value.riskExclusions['bsc:0x1111111111111111111111111111111111111111'].code, 'LEGACY_KEEP');
});
