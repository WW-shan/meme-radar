import { JsonRpcClient } from './rpc.mjs';
import { SolanaEventSource } from './solana-source.mjs';
import { EvmEventSource } from './evm-source.mjs';
import { ChainCursorStore } from './cursor-store.mjs';

export const EVM_HEAD_LAG_BLOCKS = 3;

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
    if (savedBlock !== null && (!Number.isSafeInteger(Number(savedBlock)) || Number(savedBlock) < 0)) {
      throw Object.assign(new Error(`invalid EVM cursor for ${chain}`), { code: 'CHAIN_CURSOR_CORRUPT' });
    }
    const configuredStart = Number(config.evmStartBlocks?.[chain] ?? 0);
    const initialLookbackBlocks = Number.isInteger(config.evmInitialLookbackBlocks)
      && config.evmInitialLookbackBlocks > 0 ? Math.min(1_000_000, config.evmInitialLookbackBlocks) : 1000;
    const blockChunkSize = Number.isInteger(config.evmBlockChunkSize)
      && config.evmBlockChunkSize > 0 ? Math.min(10_000, config.evmBlockChunkSize) : 1000;
    let nextBlock = savedBlock === null ? null : Number(savedBlock) + 1;
    sources.push({
      name: `evm-${chain}-pool`,
      read: async requestedChain => {
        if (requestedChain !== chain) throw unconfigured(`EVM source only supports ${chain}`);
        const reportedHead = Number(BigInt(await rpc.call('eth_blockNumber')));
        if (!Number.isSafeInteger(reportedHead) || reportedHead < 0) throw new Error('invalid latest block');
        // Load-balanced RPCs may answer eth_getLogs from a node behind the one that
        // reported the head; trailing it avoids "block range beyond head" failures.
        const latestBlock = Math.max(0, reportedHead - EVM_HEAD_LAG_BLOCKS);
        if (nextBlock === null) {
          nextBlock = configuredStart > 0
            ? configuredStart
            : Math.max(0, latestBlock - initialLookbackBlocks + 1);
        }
        if (latestBlock < nextBlock) return { stage: 'new_creation', rows: [] };
        const toBlock = Math.min(latestBlock, nextBlock + blockChunkSize - 1);
        const result = await evm.poll({ chain, fromBlock: nextBlock, toBlock });
        cursors?.set(cursorName, result.cursor);
        nextBlock = result.cursor + 1;
        return { stage: 'new_creation', rows: discoveryRows(result.events) };
      }
    });
  }
  return sources;
}
