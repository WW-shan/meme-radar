function pairKey(left, right) {
  return [left, right].sort().join('\u0000');
}

export class EntityGraph {
  constructor({ minCoBuyEvidence = 2 } = {}) {
    this.minCoBuyEvidence = Math.max(1, Number(minCoBuyEvidence) || 2);
    this.parent = new Map();
    this.edges = [];
    this.coBuyCounts = new Map();
  }

  find(value) {
    const key = String(value);
    if (!this.parent.has(key)) this.parent.set(key, key);
    const parent = this.parent.get(key);
    if (parent !== key) this.parent.set(key, this.find(parent));
    return this.parent.get(key);
  }

  union(left, right, evidence = {}) {
    const a = this.find(left), b = this.find(right);
    if (a !== b) this.parent.set(a < b ? b : a, a < b ? a : b);
    this.edges.push({ left: String(left), right: String(right), ...evidence });
  }

  addFunding(wallet, source, evidence = {}) {
    if (!wallet || !source) throw new Error('wallet and funding source are required');
    this.union(wallet, `funding:${source}`, { type: 'shared_funding', source, ...evidence });
  }

  addCoBuy(left, right, token, evidence = {}) {
    if (!left || !right || !token) throw new Error('wallets and token are required');
    const key = pairKey(String(left), String(right));
    const count = (this.coBuyCounts.get(key) || 0) + 1;
    this.coBuyCounts.set(key, count);
    const edge = { type: 'co_buy', token: String(token), count, ...evidence };
    if (count >= this.minCoBuyEvidence) this.union(left, right, edge);
    else this.edges.push({ left: String(left), right: String(right), ...edge, applied: false });
  }

  clusterFor(wallet) {
    const root = this.find(wallet);
    return new Set([...this.parent.keys()].filter(key => !key.startsWith('funding:') && this.find(key) === root));
  }

  coBuyCount(wallets = null) {
    if (!wallets) return [...this.coBuyCounts.values()].reduce((sum, count) => sum + count, 0);
    const allowed = new Set([...wallets].map(String));
    return [...this.coBuyCounts.entries()].filter(([key]) => key.split('\u0000').every(value => allowed.has(value)))
      .reduce((sum, [, count]) => sum + count, 0);
  }

  holdRate(wallets, holdRates = {}) {
    return [...wallets].reduce((sum, wallet) => {
      const value = Number(holdRates[wallet]);
      return sum + (Number.isFinite(value) && value > 0 ? value : 0);
    }, 0);
  }

  evidence() {
    return this.edges.map(row => ({ ...row }));
  }
}

export function entityMetrics(graph, wallets, holdRates, { dataComplete = true } = {}) {
  const cluster = graph.clusterFor(wallets[0] || '');
  const entityWallets = [...cluster].filter(wallet => wallets.includes(wallet));
  const entityHoldRate = graph.holdRate(entityWallets, holdRates);
  const bundleHoldRate = entityWallets.length > 1 ? entityHoldRate : 0;
  return {
    entityHoldRate,
    bundleHoldRate,
    coBuyCount: graph.coBuyCount(wallets),
    entityDataComplete: dataComplete === true,
    entityWalletCount: entityWallets.length,
    entityEvidence: graph.evidence()
  };
}
