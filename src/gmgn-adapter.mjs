import { executeReadOnly } from './gmgn-readonly-worker.mjs';

const STAGES = new Set(['new_creation', 'near_completion', 'completed']);
const SIGNAL_TYPES = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 17, 18, 19, 20, 21]);

export class GmgnAdapter {
  constructor({ client = null, importClient = null } = {}) {
    this.client = client;
    this.importClient = importClient;
  }

  async run(args) {
    if (typeof this.client?.run === 'function') return this.client.run(args);
    if (typeof this.importClient !== 'function') {
      throw Object.assign(new Error('GMGN adapter is not configured'), { code: 'GMGN_ADAPTER_INCOMPATIBLE' });
    }
    const client = await this.importClient();
    return executeReadOnly(client, args);
  }

  async discoverStage(chain, stage, limit = 80) {
    if (!STAGES.has(stage)) throw new Error('invalid lifecycle stage');
    if (!Number.isInteger(limit) || limit < 1 || limit > 80) throw new Error('invalid lifecycle limit');
    return this.run(['market', 'trenches', '--chain', chain, '--type', stage, '--limit', String(limit), '--raw']);
  }

  async signals(chain, signalTypes, limit = 50) {
    if (!Array.isArray(signalTypes) || !signalTypes.length || signalTypes.some(type => !SIGNAL_TYPES.has(type))) {
      throw new Error('invalid signal types');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('invalid signal limit');
    return this.run(['market', 'signal', '--chain', chain, '--signal-type', signalTypes.join(','), '--limit', String(limit), '--raw']);
  }
}
