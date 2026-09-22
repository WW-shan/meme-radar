import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProductMode } from './product/mode.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
const EVM_CHAINS = Object.freeze(['bsc', 'base', 'eth']);

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function configObject(value, code, label) {
  if (value === undefined || value === null || value === '') return {};
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); }
    catch { throw Object.assign(new Error(`${label} must be valid JSON`), { code }); }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Object.assign(new Error(`${label} must be a JSON object`), { code });
  }
  return parsed;
}

export function parseEvmFactories(value = process.env.RADAR_EVM_FACTORIES) {
  const input = configObject(value, 'INVALID_EVM_FACTORY_CONFIG', 'RADAR_EVM_FACTORIES');
  const unknown = Object.keys(input).filter(chain => !EVM_CHAINS.includes(chain));
  if (unknown.length) throw Object.assign(new Error(`unsupported EVM factory chain: ${unknown.join(',')}`), { code: 'INVALID_EVM_FACTORY_CONFIG' });
  const result = {};
  for (const chain of EVM_CHAINS) {
    const rows = input[chain] ?? [];
    if (!Array.isArray(rows)) throw Object.assign(new Error(`RADAR_EVM_FACTORIES.${chain} must be an array`), { code: 'INVALID_EVM_FACTORY_CONFIG' });
    result[chain] = Object.freeze(rows.map(row => {
      const address = String(row?.address || '');
      const topic = String(row?.topic || '');
      const tokenTopicIndex = row?.tokenTopicIndex === undefined ? 1 : Number(row.tokenTopicIndex);
      if (!/^0x[0-9a-f]{40}$/i.test(address)
        || !/^0x[0-9a-f]{64}$/i.test(topic)
        || !Number.isInteger(tokenTopicIndex) || tokenTopicIndex < 0 || tokenTopicIndex > 3) {
        throw Object.assign(new Error(`invalid EVM factory configuration for ${chain}`), { code: 'INVALID_EVM_FACTORY_CONFIG' });
      }
      const normalized = { address, topic, tokenTopicIndex };
      if (row?.tokenTopicIndexes !== undefined) {
        const indexes = row.tokenTopicIndexes;
        if (!Array.isArray(indexes) || indexes.length === 0 || new Set(indexes).size !== indexes.length
          || indexes.some(index => !Number.isInteger(index) || index < 0 || index > 3)) {
          throw Object.assign(new Error(`invalid EVM token topic indexes for ${chain}`), { code: 'INVALID_EVM_FACTORY_CONFIG' });
        }
        normalized.tokenTopicIndexes = Object.freeze([...indexes]);
      }
      if (row?.excludeTokens !== undefined) {
        if (!Array.isArray(row.excludeTokens)
          || row.excludeTokens.some(value => !/^0x[0-9a-f]{40}$/i.test(String(value)))) {
          throw Object.assign(new Error(`invalid EVM excluded tokens for ${chain}`), { code: 'INVALID_EVM_FACTORY_CONFIG' });
        }
        normalized.excludeTokens = Object.freeze(row.excludeTokens.map(String));
      }
      return Object.freeze(normalized);
    }));
  }
  return Object.freeze(result);
}

export function parseEvmStartBlocks(value = process.env.RADAR_EVM_START_BLOCKS) {
  const input = configObject(value, 'INVALID_EVM_START_BLOCKS', 'RADAR_EVM_START_BLOCKS');
  const unknown = Object.keys(input).filter(chain => !EVM_CHAINS.includes(chain));
  if (unknown.length) throw Object.assign(new Error(`unsupported EVM start block chain: ${unknown.join(',')}`), { code: 'INVALID_EVM_START_BLOCKS' });
  const result = {};
  for (const chain of EVM_CHAINS) {
    const block = input[chain] ?? 0;
    if (!Number.isSafeInteger(block) || block < 0) {
      throw Object.assign(new Error(`invalid EVM start block for ${chain}`), { code: 'INVALID_EVM_START_BLOCKS' });
    }
    result[chain] = block;
  }
  return Object.freeze(result);
}

export const config = Object.freeze({
  productMode: resolveProductMode(process.env.RADAR_PRODUCT_MODE || 'risk-radar'),
  chainEventsEnabled: process.env.RADAR_CHAIN_EVENTS === '1',
  solanaRpcUrl: String(process.env.SOLANA_RPC_URL || ''),
  solanaMigrationAuthority: String(process.env.SOLANA_MIGRATION_AUTHORITY || ''),
  solanaMigrationProgram: String(process.env.SOLANA_MIGRATION_PROGRAM || ''),
  evmRpcUrls: Object.freeze({
    bsc: String(process.env.BSC_RPC_URL || ''),
    base: String(process.env.BASE_RPC_URL || ''),
    eth: String(process.env.ETH_RPC_URL || '')
  }),
  evmFactories: parseEvmFactories(),
  evmStartBlocks: parseEvmStartBlocks(),
  chain: 'robinhood',
  supportedChains: Object.freeze(['sol', 'bsc', 'base', 'eth', 'robinhood', 'arc', 'stable']),
  port: boundedInteger(process.env.RADAR_PORT, 3791, 1024, 65_535),
  scanIntervalMs: boundedInteger(process.env.SCAN_INTERVAL_MS, 120_000, 30_000, 30 * 60_000),
  maxDeepAuditsPerCycle: boundedInteger(process.env.MAX_DEEP_AUDITS_PER_CYCLE, 6, 1, 12),
  auditCycleBudgetMs: 80_000,
  outcomeReadsPerCycle: 4,
  xReviewMode: 'manual',
  minAgeSec: 5 * 60,
  maxAgeSec: 7 * 86400,
  discoveryMinMarketCap: 10_000,
  discoveryMaxMarketCap: 150_000,
  priorityMinMarketCap: 20_000,
  priorityMaxMarketCap: 80_000,
  minLiquidity: 3_000,
  strictLiquidity: 8_000,
  maxRugRatio: 0.20,
  maxTop10Rate: 0.30,
  maxInsiderRate: 0.15,
  maxBundlerRate: 0.15,
  maxSniperHoldRate: 0.08,
  maxBotHoldRate: 0.20,
  maxLinkedHoldRate: 0.10,
  maxBuyTax: 0.05,
  maxSellTax: 0.05,
  maxTaxAsymmetry: 0.02,
  minLpLockedRate: 0.80,
  minOrdinaryWallets: 8,
  dynamicRecheckMs: 2 * 60_000,
  chainPassRecheckMs: 5 * 60_000,
  hardRejectRecheckMs: 6 * 60 * 60_000,
  queueRetentionMs: 24 * 60 * 60_000,
  candidateRetentionMs: 2 * 60 * 60_000,
  staleCandidateMs: 10 * 60_000,
  outcomeRetentionMs: 7 * 24 * 60 * 60_000,
  stateDir: path.join(ROOT, 'state'),
  publicDir: path.join(ROOT, 'public')
});
