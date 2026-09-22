function unwrap(payload) {
  return Array.isArray(payload) ? payload : payload?.result;
}

function quantity(value) {
  if (typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value)) return value.toLowerCase();
  if (!Number.isInteger(value) || value < 0) throw new Error('invalid block range');
  return `0x${value.toString(16)}`;
}

function sameHex(left, right) {
  return String(left || '').toLowerCase() === String(right || '').toLowerCase();
}

export class EvmEventSource {
  constructor({ rpc = null, factories = {} } = {}) {
    this.rpc = rpc;
    this.factories = factories;
  }

  configured(chain) {
    return Boolean(this.rpc?.call && Array.isArray(this.factories[chain]) && this.factories[chain].length);
  }

  async poll({ chain, fromBlock, toBlock }) {
    if (!this.configured(chain)) {
      throw Object.assign(new Error(`EVM chain source is not configured for ${chain}`), { code: 'CHAIN_SOURCE_UNCONFIGURED' });
    }
    const from = quantity(fromBlock);
    const to = quantity(toBlock);
    if (BigInt(from) > BigInt(to)) throw new Error('invalid block range');
    const seen = new Set();
    const events = [];
    for (const factory of this.factories[chain]) {
      if (!/^0x[0-9a-f]{40}$/i.test(String(factory.address || '')) || !/^0x[0-9a-f]{64}$/i.test(String(factory.topic || ''))) {
        throw new Error('invalid factory configuration');
      }
      const payload = await this.rpc.call('eth_getLogs', [{ address: factory.address, fromBlock: from, toBlock: to, topics: [factory.topic] }]);
      const logs = unwrap(payload) || [];
      for (const log of logs) {
        if (!sameHex(log?.address, factory.address) || !sameHex(log?.topics?.[0], factory.topic)) continue;
        const decoded = typeof factory.decode === 'function' ? factory.decode(log) : null;
        const topicIndex = Number.isInteger(factory.tokenTopicIndex) ? factory.tokenTopicIndex : 1;
        const topicValue = String(log?.topics?.[topicIndex] || '');
        const inferred = /^0x[0-9a-f]{64}$/i.test(topicValue) ? `0x${topicValue.slice(-40)}` : '';
        const tokenAddress = String(decoded?.tokenAddress || inferred);
        if (!/^0x[0-9a-f]{40}$/i.test(tokenAddress)) continue;
        const key = `${String(log.transactionHash).toLowerCase()}:${String(log.logIndex).toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        events.push({
          type: 'pool_created', chain, transactionHash: log.transactionHash,
          blockNumber: log.blockNumber, logIndex: log.logIndex,
          token: { address: tokenAddress }, factory: factory.address, readOnly: true
        });
      }
    }
    return { events, cursor: Number(BigInt(to)), hasMore: false };
  }
}
