function unwrap(payload) {
  return Array.isArray(payload) ? payload : payload?.result;
}

function instructionsFrom(transaction) {
  const message = transaction?.transaction?.message;
  const outer = Array.isArray(message?.instructions) ? message.instructions : [];
  const inner = Array.isArray(transaction?.meta?.innerInstructions)
    ? transaction.meta.innerInstructions.flatMap(row => Array.isArray(row?.instructions) ? row.instructions : [])
    : [];
  return [...outer, ...inner];
}

export function parseSolanaMigrationTransaction(transaction, { programId, signature = '', slot = 0, blockTime = 0 } = {}) {
  if (!transaction || transaction.meta?.err || !programId) return null;
  for (const instruction of instructionsFrom(transaction)) {
    const instructionProgram = String(instruction?.programId || instruction?.program || '');
    const parsedType = String(instruction?.parsed?.type || instruction?.name || '').toLowerCase();
    const mint = instruction?.parsed?.info?.mint || instruction?.info?.mint;
    if (instructionProgram !== programId || !['migrate', 'migration', 'migrate_to_amm'].includes(parsedType)
      || typeof mint !== 'string' || !mint.trim()) continue;
    return {
      type: 'migration', chain: 'sol', signature, slot, blockTime,
      observedAt: Number(blockTime || 0) * 1000,
      token: { address: mint }, programId: instructionProgram, readOnly: true
    };
  }
  return null;
}

export class SolanaEventSource {
  constructor({ rpc = null, migrationAuthority = '', programId = '', commitment = 'confirmed' } = {}) {
    this.rpc = rpc;
    this.migrationAuthority = migrationAuthority;
    this.programId = programId;
    this.commitment = commitment;
  }

  configured() {
    return Boolean(this.rpc?.call && this.migrationAuthority && this.programId);
  }

  async poll({ before = '', limit = 1000 } = {}) {
    if (!this.configured()) {
      throw Object.assign(new Error('Solana chain source is not configured'), { code: 'CHAIN_SOURCE_UNCONFIGURED' });
    }
    const payload = await this.rpc.call('getSignaturesForAddress', [this.migrationAuthority, { before, limit }]);
    const rows = unwrap(payload) || [];
    const unique = new Map();
    for (const row of rows) if (row?.signature && !unique.has(row.signature)) unique.set(row.signature, row);
    const events = [];
    for (const row of unique.values()) {
      const txPayload = await this.rpc.call('getTransaction', [row.signature, {
        encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: this.commitment
      }]);
      const transaction = Array.isArray(txPayload) ? txPayload[0] : txPayload?.result ?? txPayload;
      const event = parseSolanaMigrationTransaction(transaction, {
        programId: this.programId, signature: row.signature, slot: row.slot, blockTime: row.blockTime
      });
      if (event) events.push(event);
    }
    return {
      events,
      cursor: rows.at(-1)?.signature || before,
      hasMore: rows.length === limit
    };
  }
}
