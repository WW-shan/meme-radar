export const EXECUTION_MODEL_VERSION = 'execution-model-v1';

const REQUIRED_INPUTS = Object.freeze(['notionalUsd', 'liquidityUsd', 'feeRate', 'priorityUsd', 'mevReserveRate']);

function nonNegativeOrNull(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function unknownResult(reason, extra = {}) {
  return {
    version: EXECUTION_MODEL_VERSION,
    status: 'UNKNOWN',
    readOnly: true,
    executionReady: false,
    reason,
    priceImpact: null,
    effectivePriceImpact: null,
    feeUsd: null,
    priorityUsd: null,
    mevUsd: null,
    netNotionalUsd: null,
    estimatedNetReturn: null,
    exitDataReliable: false,
    ...extra
  };
}

export function estimateExecution(input = {}) {
  const missingInputs = REQUIRED_INPUTS.filter(key => input?.[key] === null || input?.[key] === undefined || input?.[key] === '');
  if (missingInputs.length) return unknownResult('MISSING_INPUTS', { missingInputs });

  const values = Object.fromEntries(REQUIRED_INPUTS.map(key => [key, nonNegativeOrNull(input[key])]));
  const invalidInputs = REQUIRED_INPUTS.filter(key => values[key] === null);
  if (invalidInputs.length) return unknownResult('INVALID_INPUT', { invalidInputs });
  if (values.notionalUsd === 0) return unknownResult('NON_POSITIVE_NOTIONAL');
  if (values.liquidityUsd === 0) return unknownResult('INSUFFICIENT_LIQUIDITY');
  if (input.exitDataReliable === false) return unknownResult('INSUFFICIENT_EXIT_DATA');
  if (input.exitLiquidityUsd !== undefined) {
    const exitLiquidityUsd = nonNegativeOrNull(input.exitLiquidityUsd);
    if (exitLiquidityUsd === null || exitLiquidityUsd === 0) return unknownResult('INSUFFICIENT_EXIT_DATA');
  }

  const priceImpact = values.notionalUsd / values.liquidityUsd * 2;
  const effectivePriceImpact = Math.min(.95, Math.max(0, priceImpact));
  const feeUsd = values.notionalUsd * values.feeRate;
  const mevUsd = values.notionalUsd * values.mevReserveRate;
  const netNotionalUsd = Math.max(0, values.notionalUsd - feeUsd - values.priorityUsd - mevUsd) * (1 - effectivePriceImpact);
  const estimatedNetReturn = netNotionalUsd / values.notionalUsd - 1;
  return {
    version: EXECUTION_MODEL_VERSION,
    status: 'ESTIMATED',
    readOnly: true,
    executionReady: false,
    reason: '只读估算，不代表可执行交易或保证成交',
    priceImpact,
    effectivePriceImpact,
    feeUsd,
    priorityUsd: values.priorityUsd,
    mevUsd,
    netNotionalUsd,
    estimatedNetReturn
  };
}
