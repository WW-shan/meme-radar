import test from 'node:test';
import assert from 'node:assert/strict';
import { coverageFor, coverageRegistry, supportedChains } from '../src/source-coverage.mjs';
import { SecondaryValidator, secondaryChainSupport } from '../src/secondary.mjs';
import { toPublicStatus } from '../src/server.mjs';

const address = '0x' + '5'.repeat(40);

test('coverage registry covers every supported chain and marks unsupported sources explicitly', () => {
  assert.deepEqual([...supportedChains], ['sol', 'bsc', 'base', 'eth', 'robinhood', 'arc', 'stable']);
  for (const chain of supportedChains) assert.ok(coverageRegistry[chain], chain);
  for (const chain of ['sol', 'bsc', 'base', 'eth']) {
    assert.equal(coverageFor(chain).dexScreener, 'SUPPORTED');
    assert.equal(coverageFor(chain).goPlus, 'SUPPORTED');
    assert.equal(coverageFor(chain).secondaryVerdict, 'AVAILABLE');
  }
  for (const chain of ['robinhood', 'arc', 'stable']) {
    assert.equal(coverageFor(chain).dexScreener, 'UNSUPPORTED');
    assert.equal(coverageFor(chain).goPlus, 'UNSUPPORTED');
    assert.equal(coverageFor(chain).secondaryVerdict, 'MANUAL_ONLY');
  }
  assert.equal(coverageFor('unknown').dexScreener, 'UNKNOWN');
  assert.equal(coverageFor('unknown').goPlus, 'UNKNOWN');
  assert.equal(coverageFor('unknown').secondaryVerdict, 'MANUAL_ONLY');
});

test('coverage registry stays consistent with the real secondary adapters', () => {
  for (const chain of supportedChains) {
    const row = coverageFor(chain);
    assert.equal(row.dexScreener === 'SUPPORTED', Boolean(secondaryChainSupport.dexScreener[chain]));
    assert.equal(row.goPlus === 'SUPPORTED', Boolean(secondaryChainSupport.goPlus[chain]));
  }
});

test('unsupported chains skip all external requests and return stable coverage', async () => {
  let calls = 0;
  const validator = new SecondaryValidator({
    fetchImpl: async () => { calls += 1; throw new Error('must not be called'); }
  });
  const result = await validator.validate({ chain: 'robinhood', tokenAddress: address });
  assert.equal(calls, 0);
  assert.equal(result.sources.dexScreener.status, 'UNSUPPORTED');
  assert.equal(result.sources.goPlus.status, 'UNSUPPORTED');
  assert.equal(result.coverage.secondaryVerdict, 'MANUAL_ONLY');
  assert.equal(result.complete, false);
});

test('public candidate and status expose coverage and never call manual-only sources cross-validated', () => {
  const manual = toPublicStatus({
    coverage: { robinhood: coverageFor('robinhood'), sol: coverageFor('sol') },
    candidates: [{ address, chain: 'robinhood', status: 'X_REVIEW', risk: { score: .2, confidence: .8, band: 'X_REVIEW', reasons: [] } }]
  });
  assert.equal(manual.coverage.robinhood.secondaryVerdict, 'MANUAL_ONLY');
  assert.equal(manual.candidates[0].coverage.secondaryVerdict, 'MANUAL_ONLY');
  assert.notEqual(manual.candidates[0].coverage.secondaryVerdict, 'AVAILABLE');
  assert.equal(manual.coverage.sol.secondaryVerdict, 'AVAILABLE');
});
