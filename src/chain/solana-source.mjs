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

  async poll({ before = '', until = '', limit = 1000, maxPages = 100 } = {}) {
    if (!this.configured()) {
      throw Object.assign(new Error('Solana chain source is not configured'), { code: 'CHAIN_SOURCE_UNCONFIGURED' });
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('invalid Solana signature limit');
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000) throw new Error('invalid Solana page budget');

    const events = [];
    const seenSignatures = new Set();
    let pageBefore = String(before || '');
    let newest = '';
    let hasMore = false;
    let page = 0;
    const drainBacklog = Boolean(until);

    while (page < maxPages) {
      const options = { limit };
      if (pageBefore) options.before = pageBefore;
      if (until) options.until = until;
      const payload = await this.rpc.call('getSignaturesForAddress', [this.migrationAuthority, options]);
      const rows = unwrap(payload) || [];
      if (!Array.isArray(rows)) throw new Error('invalid Solana signature response');

      const unique = new Map();
      for (const row of rows) {
        if (row?.signature && !unique.has(row.signature)) unique.set(row.signature, row);
      }
      const ordered = [...unique.values()];
      const reachedCursor = ordered.some(row => row.signature === until);
      const newRows = reachedCursor ? ordered.slice(0, ordered.findIndex(row => row.signature === until)) : ordered;
      newest ||= ordered[0]?.signature || '';

      for (const row of newRows) {
        if (seenSignatures.has(row.signature)) continue;
        seenSignatures.add(row.signature);
        const txPayload = await this.rpc.call('getTransaction', [row.signature, {
          encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: this.commitment
        }]);
        const transaction = Array.isArray(txPayload) ? txPayload[0]
          : txPayload && Object.hasOwn(txPayload, 'result') ? txPayload.result : txPayload;
        if (transaction === null || transaction === undefined) {
          throw Object.assign(new Error(`Solana transaction is unavailable: ${row.signature}`), { code: 'CHAIN_SOURCE_INCOMPLETE' });
        }
        const event = parseSolanaMigrationTransaction(transaction, {
          programId: this.programId, signature: row.signature, slot: row.slot, blockTime: row.blockTime
        });
        if (event) events.push(event);
      }

      page++;
      hasMore = rows.length === limit && !reachedCursor;
      if (!drainBacklog || !hasMore) break;
      const last = ordered.at(-1)?.signature || '';
      if (!last || last === pageBefore) {
        throw Object.assign(new Error('Solana signature pagination made no progress'), { code: 'CHAIN_SOURCE_INVALID_PAGE' });
      }
      pageBefore = last;
    }

    if (drainBacklog && hasMore && page >= maxPages) {
      throw Object.assign(new Error('Solana migration backlog exceeds the configured page budget'), {
        code: 'CHAIN_SOURCE_BACKLOG_TOO_LARGE'
      });
    }
    return {
      events,
      cursor: newest || String(until || before || ''),
      hasMore
    };
  }
}
