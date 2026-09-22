import { sourceHealthRecord, summarizeSourceHealth } from './source-health.mjs';

const STAGES = Object.freeze(['new_creation', 'near_completion', 'completed', 'migrated', 'signal']);

function addressKey(chain, value) {
  const address = String(value ?? '').trim();
  return `${chain}:${chain === 'sol' ? address : address.toLowerCase()}`;
}

export class DiscoveryOrchestrator {
  constructor(sources = []) {
    this.sources = sources;
  }

  async run(chain) {
    const byStage = Object.fromEntries(STAGES.map(stage => [stage, []]));
    const seen = Object.fromEntries(STAGES.map(stage => [stage, new Set()]));
    const health = {};
    for (const source of this.sources) {
      const startedAt = Date.now();
      try {
        const result = await source.read(chain);
        if (!result || !Object.hasOwn(byStage, result.stage)) {
          throw Object.assign(new Error('unknown source stage'), { code: 'UNKNOWN_STAGE' });
        }
        const rows = Array.isArray(result.rows) ? result.rows : [];
        for (const row of rows) {
          if (!row?.address) throw Object.assign(new Error('source row has no address'), { code: 'INVALID_SOURCE_ROW' });
          const key = addressKey(chain, row.address);
          if (seen[result.stage].has(key)) continue;
          seen[result.stage].add(key);
          byStage[result.stage].push(row);
        }
        health[source.name] = sourceHealthRecord({
          status: 'OK', count: byStage[result.stage].length,
          latencyMs: Date.now() - startedAt, checkedAt: Date.now()
        });
      } catch (error) {
        health[source.name] = sourceHealthRecord({
          status: error.code === 'CHAIN_SOURCE_UNCONFIGURED' ? 'UNCONFIGURED' : 'ERROR',
          count: 0, latencyMs: Date.now() - startedAt,
          code: error.code || 'SOURCE_ERROR', checkedAt: Date.now()
        });
      }
    }
    return { byStage, health, summary: summarizeSourceHealth(health) };
  }
}
