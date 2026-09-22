export const supportedChains = Object.freeze(['sol', 'bsc', 'base', 'eth', 'robinhood', 'arc', 'stable']);
export const DEX_CHAIN_IDS = Object.freeze({ sol: 'solana', bsc: 'bsc', base: 'base', eth: 'ethereum' });
export const GOPLUS_CHAIN_IDS = Object.freeze({ sol: 'solana', eth: '1', bsc: '56', base: '8453' });

function sourceStatus(map, chain) {
  if (map[chain]) return 'SUPPORTED';
  return supportedChains.includes(chain) ? 'UNSUPPORTED' : 'UNKNOWN';
}

export function coverageFor(chain) {
  const id = String(chain || '').trim().toLowerCase();
  const dexScreener = sourceStatus(DEX_CHAIN_IDS, id);
  const goPlus = sourceStatus(GOPLUS_CHAIN_IDS, id);
  const secondaryVerdict = dexScreener === 'SUPPORTED' || goPlus === 'SUPPORTED' ? 'AVAILABLE' : 'MANUAL_ONLY';
  return { chain: id, dexScreener, goPlus, secondaryVerdict };
}

export const coverageRegistry = Object.freeze(Object.fromEntries(
  supportedChains.map(chain => [chain, Object.freeze(coverageFor(chain))])
));
