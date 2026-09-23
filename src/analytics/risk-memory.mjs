function memoryKey(chain, address) {
  const normalizedAddress = chain === 'sol' ? String(address || '').trim() : String(address || '').trim().toLowerCase();
  return `${chain}:${normalizedAddress}`;
}

function normalizeRow(row = {}, fallbackKey = '') {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const [fallbackChain, ...fallbackAddress] = String(fallbackKey).split(':');
  const chain = String(row.chain || fallbackChain || '').toLowerCase();
  const address = String(row.address || fallbackAddress.join(':') || '').trim();
  if (!chain || !address) return null;
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
    const source = Array.isArray(rows) ? rows
      : rows && typeof rows === 'object' ? Object.entries(rows).map(([key, value]) => normalizeRow(value, key))
        : [];
    this.rows = source.map(row => normalizeRow(row)).filter(Boolean);
  }

  remember(row = {}) {
    const normalized = normalizeRow(row);
    if (!normalized) throw Object.assign(new Error('invalid risk memory record'), { code: 'INVALID_RISK_MEMORY' });
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
    const grouped = new Map();
    for (const row of this.snapshot(now)) {
      const previous = grouped.get(row.key);
      if (!previous) {
        grouped.set(row.key, {
          ...row,
          codes: [row.code].filter(Boolean),
          reasons: Array.isArray(row.reasons) ? [...row.reasons] : []
        });
        continue;
      }
      grouped.set(row.key, {
        ...previous,
        ...row,
        codes: [...new Set([...(previous.codes || []), row.code].filter(Boolean))],
        reasons: [...new Set([...(previous.reasons || []), ...(Array.isArray(row.reasons) ? row.reasons : [])].filter(Boolean))],
        permanent: previous.permanent || row.permanent,
        confidence: Math.max(Number(previous.confidence) || 0, Number(row.confidence) || 0),
        expiresAt: Math.max(Number(previous.expiresAt) || 0, Number(row.expiresAt) || 0)
      });
    }
    return Object.fromEntries(grouped);
  }

  serialize() {
    return this.rows.map(row => ({ ...row }));
  }
}
