import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateExecution } from '../src/execution-model.mjs';
import { createOutcome, estimateOutcomeExecution, updateOutcomePath } from '../src/outcomes.mjs';
import { summarizeOutcomes } from '../src/scanner.mjs';
import { toPublicStatus } from '../src/server.mjs';

const assumptions = Object.freeze({
  notionalUsd: 1_000,
  liquidityUsd: 20_000,
  feeRate: .01,
  priorityUsd: .2,
  mevReserveRate: .02
});

test('execution model subtracts price impact, fees, priority and MEV reserve', () => {
  const result = estimateExecution(assumptions);
  assert.ok(result.effectivePriceImpact > .05);
  assert.equal(result.executionReady, false);
  assert.equal(result.readOnly, true);
  assert.ok(result.netNotionalUsd < 1000);
  assert.ok(result.estimatedNetReturn < 0);
  assert.equal(result.feeUsd, 10);
  assert.equal(result.priorityUsd, .2);
  assert.equal(result.mevUsd, 20);
});

test('execution model returns UNKNOWN and null numeric fields for missing or invalid inputs', () => {
  const missing = estimateExecution({ notionalUsd: 1000, liquidityUsd: 20_000, priorityUsd: .2, mevReserveRate: .02 });
  assert.equal(missing.status, 'UNKNOWN');
  assert.equal(missing.executionReady, false);
  assert.equal(missing.effectivePriceImpact, null);
  assert.equal(missing.feeUsd, null);
  assert.equal(missing.netNotionalUsd, null);
  assert.equal(missing.estimatedNetReturn, null);
  assert.ok(missing.missingInputs.includes('feeRate'));

  const invalid = estimateExecution({ ...assumptions, priorityUsd: -1 });
  assert.equal(invalid.status, 'UNKNOWN');
  assert.ok(invalid.invalidInputs.includes('priorityUsd'));
  assert.equal(invalid.netNotionalUsd, null);
});

test('execution model fails closed for zero liquidity and caps extreme impact', () => {
  const noLiquidity = estimateExecution({ ...assumptions, liquidityUsd: 0 });
  assert.equal(noLiquidity.status, 'UNKNOWN');
  assert.equal(noLiquidity.reason, 'INSUFFICIENT_LIQUIDITY');
  assert.equal(noLiquidity.effectivePriceImpact, null);
  assert.equal(noLiquidity.netNotionalUsd, null);

  const noExit = estimateExecution({ ...assumptions, exitDataReliable: false });
  assert.equal(noExit.status, 'UNKNOWN');
  assert.equal(noExit.reason, 'INSUFFICIENT_EXIT_DATA');
  assert.equal(noExit.netNotionalUsd, null);

  const extreme = estimateExecution({ ...assumptions, notionalUsd: 1_000_000, liquidityUsd: 1 });
  assert.equal(extreme.status, 'ESTIMATED');
  assert.equal(extreme.effectivePriceImpact, .95);
  assert.ok(extreme.netNotionalUsd <= 1_000_000 * .05);
});

test('zero fee, priority and MEV are preserved as real zeroes rather than missing values', () => {
  const result = estimateExecution({ notionalUsd: 1000, liquidityUsd: 20_000, feeRate: 0, priorityUsd: 0, mevReserveRate: 0 });
  assert.equal(result.feeUsd, 0);
  assert.equal(result.priorityUsd, 0);
  assert.equal(result.mevUsd, 0);
  assert.ok(result.netNotionalUsd > 0);
});

test('outcome estimates keep observedReturn separate from estimatedNetReturn and never imply execution', () => {
  const sample = { at: 1, price: 1.2, return: .2, liquidityUsd: 20_000, volume5m: 100, sells5m: 20, failedRead: false, sourceLatencyMs: 10 };
  const estimate = estimateOutcomeExecution(sample, assumptions);
  assert.equal(estimate.observedReturn, .2);
  assert.ok(estimate.estimatedNetReturn < .2);
  assert.equal(estimate.execution.executionReady, false);

  const row = createOutcome({ chain: 'bsc', address: '0x' + '3'.repeat(40), baselineAt: 0, baselinePrice: 1 });
  row.samples.m30 = { ...sample, estimatedNetReturn: estimate.estimatedNetReturn };
  updateOutcomePath(row, [row.samples.m30]);
  const summary = summarizeOutcomes([row]);
  assert.equal(summary.observedReturn, .2);
  assert.ok(summary.estimatedNetReturn < .2);
  assert.equal(summary.executionReady, false);

  const api = toPublicStatus({ outcomeSummary: summary }).outcomeSummary;
  assert.equal(api.observedReturn, .2);
  assert.equal(api.estimatedNetReturn, estimate.estimatedNetReturn);
  assert.equal(api.executionReady, false);
  assert.equal(api.readOnly, true);
  assert.doesNotMatch(JSON.stringify(api), /pnl|guaranteed|executable/i);
});
