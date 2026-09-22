import { JsonRpcClient } from './rpc.mjs';
import { SolanaEventSource } from './solana-source.mjs';
import { EvmEventSource } from './evm-source.mjs';

function unconfigured(message) {
  return Object.assign(new Error(message), { code: 'CHAIN_SOURCE_UNCONFIGURED' });
}

export function createChainEventSources(config = {}, { fetchImpl = globalThis.fetch } = {}) {
  if (config.chainEventsEnabled !== true) return [];
  const sources = [];
  const solana = new SolanaEventSource({
    rpc: new JsonRpcClient(config.solanaRpcUrl, { fetchImpl }),
    migrationAuthority: config.solanaMigrationAuthority || '',
    programId: config.solanaMigrationProgram || ''
  });
  sources.push({
    name: 'solana-migration',
    read: async chain => {
      if (chain !== 'sol') throw unconfigured('Solana source only supports sol');
      const result = await solana.poll();
      return { stage: 'migrated', rows: result.events };
    }
  });
  for (const chain of ['bsc', 'base', 'eth']) {
    const evm = new EvmEventSource({
      rpc: new JsonRpcClient(config.evmRpcUrls?.[chain], { fetchImpl }),
      factories: { [chain]: config.evmFactories?.[chain] || [] }
    });
    sources.push({
      name: `evm-${chain}-pool`,
      read: async requestedChain => {
        if (requestedChain !== chain) throw unconfigured(`EVM source only supports ${chain}`);
        const result = await evm.poll({ chain, fromBlock: 0, toBlock: 0 });
        return { stage: 'new_creation', rows: result.events };
      }
    });
  }
  return sources;
}
