const MODES = Object.freeze({
  'risk-radar': Object.freeze({
    earlyDiscovery: false,
    execution: false,
    lifecycleStages: Object.freeze(['completed', 'migrated']),
    allowedClaims: Object.freeze(['read-only', 'risk-review', 'evidence-tracking'])
  }),
  'early-discovery': Object.freeze({
    earlyDiscovery: true,
    execution: false,
    lifecycleStages: Object.freeze(['new_creation', 'near_completion', 'completed', 'migrated']),
    allowedClaims: Object.freeze(['read-only', 'early-discovery', 'risk-review', 'evidence-tracking'])
  })
});

export function resolveProductMode(value = 'risk-radar') {
  if (!Object.hasOwn(MODES, value)) throw new Error('invalid product mode');
  return value;
}

export function productCapabilities(value = 'risk-radar') {
  return MODES[resolveProductMode(value)];
}
