import test from 'node:test';
import assert from 'node:assert/strict';
import { RISK_ENGINE_VERSION, scoreRisk } from '../src/analytics/risk-engine.mjs';
import { toPublicStatus } from '../src/server.mjs';

test('risk engine emits bounded score, confidence and ordered reasons', () => {
  const result = scoreRisk({
    entityHoldRate: .45,
    priorRugRate: .5,
    liquidityUsd: 5000,
    unknownFields: ['top10'],
    freshnessMs: 30_000
  });
  assert.ok(result.score > .5 && result.score <= 1);
  assert.ok(result.confidence > 0 && result.confidence < 1);
  assert.equal(result.version, RISK_ENGINE_VERSION);
  assert.deepEqual(result.reasons.map(row => row.code), ['ENTITY_CONCENTRATION', 'CREATOR_HISTORY', 'LOW_LIQUIDITY', 'UNKNOWN_TOP10']);
  assert.equal(result.band, 'HARD_REJECT');
});

test('fatal evidence overrides probability and unknown fields', () => {
  const result = scoreRisk({ hardFatal: true, fatalReasons: ['HONEYPOT'], unknownFields: ['top10'], freshnessMs: 0 });
  assert.equal(result.score, 1);
  assert.equal(result.confidence, 1);
  assert.equal(result.band, 'HARD_REJECT');
  assert.deepEqual(result.reasons, [{ code: 'HONEYPOT' }]);
});

test('missing and malformed input is deterministic and fail-closed', () => {
  const first = scoreRisk();
  const second = scoreRisk({ entityHoldRate: 'bad', unknownFields: null, freshnessMs: Infinity });
  assert.deepEqual(first, second);
  assert.equal(first.score, 0);
  assert.equal(first.confidence, 1);
  assert.equal(first.band, 'X_REVIEW');
});

test('base wait status cannot be downgraded by a low numeric score', () => {
  const result = scoreRisk({ baseStatus: 'WAIT_RECHECK', entityHoldRate: 0, unknownFields: [] });
  assert.equal(result.band, 'WAIT_RECHECK');
});

test('threshold boundaries are stable', () => {
  assert.equal(scoreRisk({ entityHoldRate: .30 }).band, 'X_REVIEW');
  assert.equal(scoreRisk({ entityHoldRate: .31 }).band, 'X_REVIEW');
  assert.equal(scoreRisk({ entityHoldRate: .31, priorRugRate: .21 }).band, 'WAIT_RECHECK');
  assert.equal(scoreRisk({ entityHoldRate: .31, priorRugRate: .21, liquidityUsd: 7999, unknownFields: ['x'] }).band, 'HARD_REJECT');
});

test('public API exposes only risk whitelist fields', () => {
  const result = toPublicStatus({
    activeChain: 'bsc',
    candidates: [{
      address: '0x1111111111111111111111111111111111111111', chain: 'bsc', status: 'WAIT_RECHECK',
      risk: { version: RISK_ENGINE_VERSION, score: .6, confidence: .7, band: 'WAIT_RECHECK', reasons: [{ code: 'ENTITY_CONCENTRATION', value: .4, raw: 'secret' }], raw: 'secret' }
    }]
  });
  assert.deepEqual(result.candidates[0].risk, {
    version: RISK_ENGINE_VERSION, score: .6, confidence: .7, band: 'WAIT_RECHECK',
    reasons: [{ code: 'ENTITY_CONCENTRATION', value: .4, field: '' }]
  });
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});
