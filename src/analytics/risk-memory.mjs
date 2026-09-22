function memoryKey(chain, address) {
  const normalizedAddress = chain === 'sol' ? String(address || '').trim() : String(address || '').trim().toLowerCase();
  return `${chain}:${normalizedAddress}`;
}

function normalizeRow(row = {}, fallbackKey = '') {
  const [fallbackChain, ...fallbackAddress] = String(fallbackKey).split(':');
  const chain = String(row.chain || fallbackChain || '').toLowerCase();
  const address = String(row.address || fallbackAddress.join(':') || '').trim();
  const at = Number(row.at) || 0;
  const expiresAt = Number(row.expiresAt) || 0;
  const permanent = row.permanent === true || expiresAt === 0;
  return {
    ...row,
    key: memoryKey(chain, address),
    chain,
    address,
    code: String(row.code || row.reason || 'RISK_EXCLUSION'),
    confidence: Number.isFinite(Number(row.confidence)) ? Math.max(0, Math.min(1, Number(row.confidence))) : 1,
    at,
    expiresAt,
    permanent,
    version: String(row.version || 'legacy'),
    review: row.review || null
  };
}

export class RiskMemory {
  constructor(rows = []) {
    const source = Array.isArray(rows) ? rows : Object.entries(rows).map(([key, value]) => normalizeRow(value, key));
    this.rows = source.map(row => normalizeRow(row));
  }

  remember(row = {}) {
    const normalized = normalizeRow(row);
    if (!normalized.chain || !normalized.address) throw Object.assign(new Error('invalid risk memory record'), { code: 'INVALID_RISK_MEMORY' });
    const index = this.rows.findIndex(existing => existing.key === normalized.key && existing.code === normalized.code);
    if (index >= 0) this.rows[index] = { ...this.rows[index], ...normalized };
    else this.rows.push(normalized);
    return normalized;
  }

  active(chain, address, now = Date.now()) {
    const key = memoryKey(chain, address);
    return this.rows.find(row => row.key === key && (row.permanent || row.expiresAt > now)) || null;
  }

  snapshot(now = Date.now()) {
    return this.rows.filter(row => row.permanent || row.expiresAt > now).map(row => ({ ...row }));
  }

  toObject(now = Date.now()) {
    return Object.fromEntries(this.snapshot(now).map(row => [row.key, { ...row }]));
  }

  serialize() {
    return this.rows.map(row => ({ ...row }));
  }
}
