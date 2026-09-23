const STAGES = new Set(['new_creation', 'near_completion', 'completed']);
const SIGNAL_TYPES = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 17, 18, 19, 20, 21]);
export const GMGN_SIGNAL_CHAINS = Object.freeze(['sol', 'bsc', 'robinhood', 'arc', 'stable']);
const SIGNAL_CHAINS = new Set(GMGN_SIGNAL_CHAINS);
export const GMGN_ADAPTER_INCOMPATIBLE = 'GMGN_ADAPTER_INCOMPATIBLE';
export const GMGN_ADAPTER_OK = 'GMGN_ADAPTER_OK';
export const GMGN_SUPPORTED_CLIENT_VERSION = '1.5.7';

// Keep this list aligned with gmgn-readonly-worker's allowlist. A client that
// cannot satisfy every scanner read is incompatible as a whole: silently
// discovering the missing capability during an audit would turn an upstream
// schema change into a fabricated empty or safe result.
export const GMGN_REQUIRED_METHODS = Object.freeze([
  'getUserInfo',
  'getTokenInfo',
  'getTokenSecurity',
  'getTokenPoolInfo',
  'getTokenTopHolders',
  'getTokenTopTraders',
  'getTokenKline',
  'getTrendingSwaps',
  'getTrenches',
  'getTokenSignalV2'
]);

function incompatible({ injection, reason, missing = [], actualVersion = '', expectedVersion = '' } = {}) {
  return {
    status: 'INCOMPATIBLE',
    code: GMGN_ADAPTER_INCOMPATIBLE,
    injection,
    reason,
    missing: [...missing],
    ...(actualVersion ? { actualVersion: String(actualVersion) } : {}),
    ...(expectedVersion ? { expectedVersion: String(expectedVersion) } : {})
  };
}

function timeoutError() {
  return Object.assign(new Error('GMGN adapter capability probe timed out'), { code: 'GMGN_ADAPTER_TIMEOUT' });
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError()), timeoutMs); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function importedDescriptor(value) {
  if (value && typeof value === 'object' && value.client && typeof value.client === 'object') {
    return { client: value.client, version: value.version ?? value.packageVersion ?? '' };
  }
  return { client: value, version: value?.version ?? value?.packageVersion ?? '' };
}

function requiredMethodsFor(args = []) {
  const [group, command] = args;
  if (group === 'auth' && command === 'verify-read') return ['getUserInfo'];
  if (group === 'token') {
    return {
      info: ['getTokenInfo'], security: ['getTokenSecurity'], pool: ['getTokenPoolInfo'],
      holders: ['getTokenTopHolders'], traders: ['getTokenTopTraders']
    }[command] || GMGN_REQUIRED_METHODS;
  }
  if (group === 'market') {
    return {
      kline: ['getTokenKline'], trending: ['getTrendingSwaps'],
      trenches: ['getTrenches'], signal: ['getTokenSignalV2']
    }[command] || GMGN_REQUIRED_METHODS;
  }
  return GMGN_REQUIRED_METHODS;
}

export class GmgnAdapter {
  constructor({ client = null, importClient = null } = {}) {
    this.client = client;
    this.importClient = importClient;
  }

  async run(args) {
    if (typeof this.client?.run === 'function') return this.client.run(args);
    const loaded = await this.loadImportedClient({ requiredMethods: requiredMethodsFor(args) });
    if (loaded.status !== 'OK') {
      throw Object.assign(new Error('GMGN adapter is incompatible'), {
        code: GMGN_ADAPTER_INCOMPATIBLE,
        reason: loaded.reason,
        missing: loaded.missing
      });
    }
    const { executeReadOnly } = await import('./gmgn-readonly-worker.mjs');
    return executeReadOnly(loaded.client, args);
  }

  async loadImportedClient({
    timeoutMs = 5_000,
    expectedVersion = GMGN_SUPPORTED_CLIENT_VERSION,
    requiredMethods = GMGN_REQUIRED_METHODS
  } = {}) {
    if (typeof this.importClient !== 'function') {
      return incompatible({
        injection: this.client ? 'client' : 'none',
        reason: this.client ? 'MISSING_RUN_METHOD' : 'MISSING_INJECTION',
        missing: this.client ? ['run'] : ['importClient']
      });
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      return incompatible({ injection: 'importClient', reason: 'INVALID_TIMEOUT', missing: [] });
    }

    let imported;
    try {
      imported = await withTimeout(Promise.resolve().then(() => this.importClient()), timeoutMs);
    } catch (error) {
      return incompatible({
        injection: 'importClient',
        reason: error?.code === 'GMGN_ADAPTER_TIMEOUT' ? 'TIMEOUT' : 'IMPORT_ERROR',
        missing: []
      });
    }

    const { client, version } = importedDescriptor(imported);
    if (!client || typeof client !== 'object') {
      return incompatible({ injection: 'importClient', reason: 'MISSING_EXPORT', missing: [] });
    }
    if (version && expectedVersion && String(version) !== String(expectedVersion)) {
      return incompatible({
        injection: 'importClient',
        reason: 'VERSION_INCOMPATIBLE',
        missing: [],
        actualVersion: version,
        expectedVersion
      });
    }
    const missing = requiredMethods.filter(name => typeof client[name] !== 'function');
    if (missing.length) {
      return incompatible({ injection: 'importClient', reason: 'MISSING_METHODS', missing });
    }
    return { status: 'OK', client, injection: 'importClient', missing: [], version: String(version || '') };
  }

  async probe({ timeoutMs = 5_000, expectedVersion = GMGN_SUPPORTED_CLIENT_VERSION } = {}) {
    if (typeof this.client?.run === 'function') {
      return { status: 'OK', code: GMGN_ADAPTER_OK, injection: 'client.run', missing: [] };
    }
    const loaded = await this.loadImportedClient({ timeoutMs, expectedVersion });
    if (loaded.status !== 'OK') return loaded;
    return {
      status: 'OK',
      code: GMGN_ADAPTER_OK,
      injection: loaded.injection,
      missing: [],
      ...(loaded.version ? { version: loaded.version } : {})
    };
  }

  async discoverStage(chain, stage, limit = 80) {
    if (!STAGES.has(stage)) throw new Error('invalid lifecycle stage');
    if (!Number.isInteger(limit) || limit < 1 || limit > 80) throw new Error('invalid lifecycle limit');
    return this.run(['market', 'trenches', '--chain', chain, '--type', stage, '--limit', String(limit), '--raw']);
  }

  async signals(chain, signalTypes, limit = 50) {
    if (!SIGNAL_CHAINS.has(chain)) throw new Error('invalid signal chain');
    if (!Array.isArray(signalTypes) || !signalTypes.length || signalTypes.some(type => !SIGNAL_TYPES.has(type))) {
      throw new Error('invalid signal types');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('invalid signal limit');
    return this.run(['market', 'signal', '--chain', chain, '--signal-type', signalTypes.join(','), '--limit', String(limit), '--raw']);
  }
}
