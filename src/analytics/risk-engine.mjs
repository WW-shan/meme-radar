export const RISK_ENGINE_VERSION = 'risk-engine-v1';
export const RISK_WEIGHTS = Object.freeze({
  entityConcentration: .25,
  creatorHistory: .20,
  lowLiquidity: .15,
  unknownField: .05,
  freshnessWindowMs: 300_000,
  hardReject: .65,
  waitRecheck: .35
});

const clamp = value => Math.max(0, Math.min(1, Number.isFinite(Number(value)) ? Number(value) : 0));

export function scoreRisk(input = {}) {
  const fatalReasons = Array.isArray(input.fatalReasons) ? input.fatalReasons : [];
  const unknownFields = Array.isArray(input.unknownFields) ? input.unknownFields : [];
  if (input.hardFatal === true || input.baseStatus === 'HARD_REJECT') {
    return {
      version: RISK_ENGINE_VERSION,
      score: 1,
      confidence: 1,
      band: 'HARD_REJECT',
      reasons: fatalReasons.map(code => ({ code: String(code) }))
    };
  }

  const reasons = [];
  let score = 0;
  const entityHoldRate = Number(input.entityHoldRate);
  if (Number.isFinite(entityHoldRate) && entityHoldRate > .30) {
    score += RISK_WEIGHTS.entityConcentration;
    reasons.push({ code: 'ENTITY_CONCENTRATION', value: entityHoldRate });
  }
  const priorRugRate = Number(input.priorRugRate);
  if (Number.isFinite(priorRugRate) && priorRugRate > .20) {
    score += RISK_WEIGHTS.creatorHistory;
    reasons.push({ code: 'CREATOR_HISTORY', value: priorRugRate });
  }
  const liquidityUsd = Number(input.liquidityUsd);
  if (Number.isFinite(liquidityUsd) && liquidityUsd < 8000) {
    score += RISK_WEIGHTS.lowLiquidity;
    reasons.push({ code: 'LOW_LIQUIDITY', value: liquidityUsd });
  }
  for (const field of unknownFields) {
    score += RISK_WEIGHTS.unknownField;
    reasons.push({ code: `UNKNOWN_${String(field).toUpperCase()}`, field: String(field) });
  }

  const rawFreshness = Number(input.freshnessMs);
  const freshnessMs = Number.isFinite(rawFreshness) ? Math.max(0, rawFreshness) : 0;
  const confidence = clamp(1 - unknownFields.length * .10 - Math.min(1, freshnessMs / RISK_WEIGHTS.freshnessWindowMs) * .20);
  score = clamp(score);
  let band = score >= RISK_WEIGHTS.hardReject ? 'HARD_REJECT' : score >= RISK_WEIGHTS.waitRecheck ? 'WAIT_RECHECK' : 'X_REVIEW';
  if (input.baseStatus === 'WAIT_RECHECK' && band === 'X_REVIEW') band = 'WAIT_RECHECK';
  return { version: RISK_ENGINE_VERSION, score, confidence, band, reasons };
}
