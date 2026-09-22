const OUTCOMES = new Set(['rug', 'success', 'unknown']);

function validAddress(chain, value) {
  const address = String(value || '').trim();
  return chain === 'sol'
    ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)
    : /^0x[0-9a-f]{40}$/i.test(address);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export class CreatorReputation {
  constructor(rows = [], { minimumSamples = 3 } = {}) {
    this.minimumSamples = Math.max(1, Number(minimumSamples) || 3);
    this.rows = Array.isArray(rows) ? rows.map(row => ({ ...row })) : [];
  }

  record(row = {}) {
    const chain = String(row.chain || '').toLowerCase();
    const creator = String(row.creator || '').trim();
    const token = String(row.token || '').trim();
    const observedAt = Number(row.observedAt);
    const outcome = String(row.outcome || 'unknown').toLowerCase();
    if (!['sol', 'bsc', 'base', 'eth'].includes(chain) || !validAddress(chain, creator)
      || !token || !Number.isFinite(observedAt) || observedAt < 0 || !OUTCOMES.has(outcome)) {
      throw Object.assign(new Error('invalid creator history record'), { code: 'INVALID_CREATOR_HISTORY' });
    }
    this.rows.push({ ...row, chain, creator, token, observedAt, outcome });
    return this;
  }

  snapshot(chain, creator, at) {
    const normalizedChain = String(chain || '').toLowerCase();
    const normalizedCreator = String(creator || '').trim();
    const cutoff = Number(at);
    if (!['sol', 'bsc', 'base', 'eth'].includes(normalizedChain) || !validAddress(normalizedChain, normalizedCreator)
      || !Number.isFinite(cutoff) || cutoff < 0) {
      throw Object.assign(new Error('invalid creator snapshot request'), { code: 'INVALID_CREATOR_SNAPSHOT' });
    }
    const prior = this.rows.filter(row => row.chain === normalizedChain && row.creator === normalizedCreator && row.observedAt < cutoff);
    const rugs = prior.filter(row => row.outcome === 'rug');
    const successes = prior.filter(row => row.outcome === 'success').length;
    const rugTimes = rugs.map(row => Number(row.timeToRugMs)).filter(value => Number.isFinite(value) && value >= 0);
    const sampleCount = prior.length;
    const known = sampleCount >= this.minimumSamples;
    return {
      chain: normalizedChain,
      creator: normalizedCreator,
      asOf: cutoff,
      priorLaunches: sampleCount,
      priorRugs: rugs.length,
      priorRugRate: sampleCount ? rugs.length / sampleCount : null,
      priorMedianTimeToRug: median(rugTimes),
      priorSuccessfulLaunches: successes,
      sampleCount,
      confidence: Math.min(1, sampleCount / this.minimumSamples),
      known,
      unknownReason: known ? '' : `insufficient creator history (${sampleCount}/${this.minimumSamples})`
    };
  }

  serialize() {
    return this.rows.map(row => ({ ...row }));
  }
}
