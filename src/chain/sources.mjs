import { JsonRpcClient } from './rpc.mjs';
import { SolanaEventSource } from './solana-source.mjs';
import { EvmEventSource } from './evm-source.mjs';
import { ChainCursorStore } from './cursor-store.mjs';

function unconfigured(message) {
  return Object.assign(new Error(message), { code: 'CHAIN_SOURCE_UNCONFIGURED' });
}

function discoveryRows(events) {
  return (Array.isArray(events) ? events : []).map(event => ({
    ...event,
    address: event?.token?.address || '',
    observedAt: Number(event?.observedAt || Number(event?.blockTime || 0) * 1000 || Date.now())
  })).filter(event => event.address);
}

export function createChainEventSources(config = {}, { fetchImpl = globalThis.fetch, cursorStore = null } = {}) {
  if (config.chainEventsEnabled !== true) return [];
  const cursors = cursorStore || (config.stateDir ? new ChainCursorStore(config.stateDir) : null);
  const sources = [];
  const solanaRpc = new JsonRpcClient(config.solanaRpcUrl, { fetchImpl });
  const solana = new SolanaEventSource({
    rpc: solanaRpc,
    migrationAuthority: config.solanaMigrationAuthority || '',
    programId: config.solanaMigrationProgram || ''
  });
  let solanaCursor = String(cursors?.get('solana-migration') || '');
  sources.push({
    name: 'solana-migration',
    read: async chain => {
      if (chain !== 'sol') throw unconfigured('Solana source only supports sol');
      const result = await solana.poll({ until: solanaCursor });
      if (result.cursor) {
        cursors?.set('solana-migration', result.cursor);
        solanaCursor = result.cursor;
      }
      return { stage: 'migrated', rows: discoveryRows(result.events) };
    }
  });
  for (const chain of ['bsc', 'base', 'eth']) {
    const rpc = new JsonRpcClient(config.evmRpcUrls?.[chain], { fetchImpl });
    const evm = new EvmEventSource({
      rpc,
      factories: { [chain]: config.evmFactories?.[chain] || [] }
    });
    const cursorName = `evm-${chain}-pool`;
    const savedBlock = cursors?.get(cursorName) ?? null;
    let nextBlock = savedBlock === null
      ? Number(config.evmStartBlocks?.[chain] || 0)
      : Number(savedBlock) + 1;
    sources.push({
      name: `evm-${chain}-pool`,
      read: async requestedChain => {
        if (requestedChain !== chain) throw unconfigured(`EVM source only supports ${chain}`);
        const latestBlock = Number(BigInt(await rpc.call('eth_blockNumber')));
        if (!Number.isInteger(latestBlock) || latestBlock < 0) throw new Error('invalid latest block');
        if (latestBlock < nextBlock) return { stage: 'new_creation', rows: [] };
        const result = await evm.poll({ chain, fromBlock: nextBlock, toBlock: latestBlock });
        cursors?.set(cursorName, result.cursor);
        nextBlock = result.cursor + 1;
        return { stage: 'new_creation', rows: discoveryRows(result.events) };
      }
    });
  }
  return sources;
}
