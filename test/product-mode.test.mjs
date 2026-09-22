import test from 'node:test';
import assert from 'node:assert/strict';
import { productCapabilities, resolveProductMode } from '../src/product/mode.mjs';

test('risk radar does not advertise early-sniper capability', () => {
  const caps = productCapabilities('risk-radar');
  assert.equal(caps.earlyDiscovery, false);
  assert.equal(caps.execution, false);
  assert.equal(caps.lifecycleStages.includes('new_creation'), false);
});

test('early discovery enables lifecycle stages but never execution', () => {
  const caps = productCapabilities('early-discovery');
  assert.equal(caps.earlyDiscovery, true);
  assert.equal(caps.execution, false);
  assert.deepEqual(caps.lifecycleStages, ['new_creation', 'near_completion', 'completed', 'migrated']);
});

test('unknown mode fails closed', () => {
  assert.throws(() => resolveProductMode('sniper'), /invalid product mode/);
});

test('default mode is risk-radar and capabilities are immutable', () => {
  assert.equal(resolveProductMode(), 'risk-radar');
  const caps = productCapabilities();
  assert.equal(Object.isFrozen(caps), true);
  assert.equal(Object.isFrozen(caps.lifecycleStages), true);
  assert.equal(Object.isFrozen(caps.allowedClaims), true);
});

test('all modes permanently disable execution', () => {
  for (const mode of ['risk-radar', 'early-discovery']) {
    assert.equal(productCapabilities(mode).execution, false);
  }
});
