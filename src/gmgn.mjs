import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { legacyGmgnApiKey, normalizeGmgnApiKey } from './gmgn-key-store.mjs';
import { GmgnAdapter } from './gmgn-adapter.mjs';

const execFileAsync = promisify(execFile);

export function gmgnChildEnvironment(source = process.env, apiKey = '', privateKey = '') {
  const allowed = [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'XDG_CONFIG_HOME',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'
  ];
  const env = Object.fromEntries(allowed.filter(key => source[key]).map(key => [key, source[key]]));
  const explicitKey = normalizeGmgnApiKey(apiKey || source.GMGN_API_KEY);
  if (explicitKey) env.GMGN_API_KEY = explicitKey;
  if (typeof privateKey === 'string' && /^-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----\s*$/.test(privateKey)) {
    env.GMGN_PRIVATE_KEY = privateKey;
  }
  return env;
}

function errorSummary(error) {
  return {
    ok: false,
    code: String(error?.code || 'GMGN_REQUEST_FAILED'),
    message: String(error?.message || 'GMGN数据请求失败')
  };
}

function mergeDefined(left = {}, right = {}) {
  const merged = { ...left };
  for (const [key, value] of Object.entries(right || {})) {
    if (value !== undefined && value !== null && value !== '') {
      merged[key] = key === 'link' && typeof value === 'object'
        ? mergeDefined(left?.link || {}, value)
        : value;
    }
  }
  return merged;
}

function unwrap(raw) {
  let value = raw;
  for (let i = 0; i < 3; i++) {
    if (value && typeof value === 'object' && !Array.isArray(value) && value.data != null) value = value.data;
    else break;
  }
  return value;
}

export function normalizeList(raw, keys = ['list', 'rank', 'completed', 'tokens']) {
  const value = unwrap(raw);
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of keys) if (Array.isArray(value[key])) return value[key];
  return [];
}

function retryAfterMs(message) {
  const match = String(message || '').match(/~?(\d+)s\s+remaining/i);
  return Math.min(5 * 60_000, Math.max(30_000, Number(match?.[1] || 30) * 1000));
}

export function requestWeight(args) {
  return ({ holders: 5, traders: 5, trenches: 3, kline: 2 })[args[1]] || 1;
}

export function tokenInfoPrice(info) {
  const value = info?.price?.price ?? info?.price ?? info?.price_usd;
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price : null;
}

export function translateGmgnError(error) {
  let workerCode = '';
  let workerRetryMs = 0;
  try { const parsed = JSON.parse(error?.stderr); workerCode = parsed.code || ''; workerRetryMs = Number(parsed.retryAfterMs) || 0; } catch {}
  const raw = [workerCode, error?.code, error?.status ? `HTTP ${error.status}` : '',
    [401, 403, 429].includes(Number(error?.apiCode)) ? `HTTP ${error.apiCode}` : '',
    error?.stderr || error?.message || error || ''].join(' ');
  let message = '未知错误';
  let code = 'GMGN_REQUEST_FAILED';
  let retryMs = 0;

  if (/RATE_LIMIT_EXCEEDED|GMGN_RATE_LIMITED|HTTP\s*429/i.test(raw)) {
    retryMs = Math.max(workerRetryMs || retryAfterMs(raw), Number(error?.resetAtUnix) * 1000 - Date.now() + 1000 || 0);
    message = `GMGN请求频率超限，已停止本轮后续请求；约${Math.ceil(retryMs / 1000)}秒后可恢复，下一轮会自动重试。`;
    code = 'GMGN_RATE_LIMITED';
  } else if (/HTTP\s*401|GMGN_AUTH_FAILED|UNAUTHORIZED|invalid.*api.?key/i.test(raw)) {
    message = 'GMGN API Key无效或已失效，请重新配置。';
    code = 'GMGN_AUTH_FAILED';
  } else if (/HTTP\s*403|GMGN_PERMISSION_DENIED|FORBIDDEN/i.test(raw)) {
    message = 'GMGN API当前没有读取该数据的权限。';
    code = 'GMGN_PERMISSION_DENIED';
  } else if (/timed?\s*out|GMGN_TIMEOUT|ETIMEDOUT|killed/i.test(raw)) {
    message = 'GMGN数据请求超时，下一轮会自动重试。';
    code = 'GMGN_TIMEOUT';
  } else if (/ENOENT|ERR_MODULE_NOT_FOUND|GMGN_DEPENDENCY_MISSING|not found|Cannot find package/i.test(raw)) {
    message = '运行依赖尚未安装，请运行安装并启动入口。';
    code = 'GMGN_DEPENDENCY_MISSING';
  } else if (/ECONN|ENET|EAI_AGAIN|socket|network|fetch failed|GMGN_NETWORK_ERROR/i.test(raw)) {
    message = '网络暂时无法连接GMGN，下一轮会自动重试。';
    code = 'GMGN_NETWORK_ERROR';
  } else {
    message = 'GMGN数据请求暂时失败，下一轮会自动重试。';
  }

  const translated = new Error(message);
  translated.code = code;
  translated.retryAfterMs = retryMs;
  return translated;
}

export function discoveryRequestArgs(chain = 'robinhood') {
  const common = [
    '--chain', chain, '--min-created', '5m', '--max-created', '10080m',
    '--min-marketcap', '10000', '--max-marketcap', '150000', '--min-liquidity', '3000'
  ];
  return {
    trenches: ['market', 'trenches', '--type', 'completed', '--limit', '80', '--filter-preset', 'safe', '--sort-by', 'volume_1h', '--direction', 'desc', ...common, '--raw'],
    trending: ['market', 'trending', '--interval', '5m', '--limit', '100', '--order-by', 'volume', '--direction', 'desc', ...common, '--raw']
  };
}

export class GmgnClient {
  constructor({ binary = process.execPath, workerPath = fileURLToPath(new URL('./gmgn-readonly-worker.mjs', import.meta.url)), timeoutMs = 30_000, minRequestGapMs = 1_100, apiKeyProvider = null, privateKeyProvider = null, legacyKeyProvider = legacyGmgnApiKey } = {}) {
    this.binary = binary;
    this.workerPath = workerPath;
    this.timeoutMs = timeoutMs;
    this.minRequestGapMs = minRequestGapMs;
    this.apiKeyProvider = typeof apiKeyProvider === 'function' ? apiKeyProvider : null;
    this.privateKeyProvider = typeof privateKeyProvider === 'function' ? privateKeyProvider : null;
    this.legacyKeyProvider = legacyKeyProvider;
    this.lastVerifiedKey = '';
    this.lastRequestAt = 0;
    this.nextAllowedAt = 0;
    this.queue = Promise.resolve();
    this.cache = new Map();
    this.keyEpoch = 0;
    this.disabled = false;
    this.backoffFactor = 1;
    this.successStreak = 0;
    this.lastWeight = 1;
    this.metrics = { requests: 0, cacheHits: 0, rateLimits: 0 };
  }

  apiKey() {
    if (this.disabled) return '';
    try { return normalizeGmgnApiKey(this.apiKeyProvider?.()) || normalizeGmgnApiKey(this.legacyKeyProvider?.()); }
    catch { return ''; }
  }

  privateKey() {
    try { return String(this.privateKeyProvider?.() || ''); }
    catch { return ''; }
  }

  childEnvironment(apiKey = this.apiKey(), privateKey = '') {
    return gmgnChildEnvironment(process.env, apiKey, privateKey);
  }

  async run(args, options = {}) {
    const task = this.queue.then(() => this.runNow(args, options));
    this.queue = task.catch(() => {});
    return task;
  }

  async runNow(args, { apiKey = this.apiKey(), privateKey = '', deadline = Infinity, verification = false } = {}) {
    if (this.disabled && !verification) throw translateGmgnError(new Error('invalid api key'));
    const epoch = this.keyEpoch;
    const now = Date.now();
    if (this.nextAllowedAt > now) {
      const waiting = new Error(`GMGN请求频率超限，已停止本轮后续请求；约${Math.ceil((this.nextAllowedAt - now) / 1000)}秒后可恢复，下一轮会自动重试。`);
      waiting.code = 'GMGN_RATE_LIMITED';
      waiting.retryAfterMs = this.nextAllowedAt - now;
      throw waiting;
    }

    const waitMs = Math.max(0, this.lastRequestAt + this.minRequestGapMs * this.lastWeight * this.backoffFactor - now);
    if (waitMs) await delay(waitMs);
    if ((this.disabled && !verification) || epoch !== this.keyEpoch) throw translateGmgnError(new Error('invalid api key'));
    if (Date.now() >= deadline) throw translateGmgnError(new Error('GMGN_TIMEOUT'));
    this.lastRequestAt = Date.now();
    this.lastWeight = requestWeight(args);
    this.metrics.requests++;

    let stdout, stderr;
    try {
      ({ stdout, stderr } = await execFileAsync(this.binary, ['--use-env-proxy', '--dns-result-order=ipv4first', this.workerPath, ...args], {
        timeout: Math.max(1, Math.min(this.timeoutMs, deadline - Date.now())),
        maxBuffer: 10 * 1024 * 1024,
        env: this.childEnvironment(apiKey, privateKey)
      }));
    } catch (error) {
      const translated = translateGmgnError(error);
      if (translated.code === 'GMGN_RATE_LIMITED') {
        this.nextAllowedAt = Date.now() + translated.retryAfterMs;
        this.backoffFactor = Math.min(8, this.backoffFactor * 2);
        this.successStreak = 0;
        this.metrics.rateLimits++;
      }
      throw translated;
    }
    if (stderr?.includes('neutralized')) throw new Error('GMGN检测到可疑代币元数据，已拒绝处理');
    try {
      const data = JSON.parse(stdout);
      if (!this.disabled && epoch === this.keyEpoch) this.lastVerifiedKey = apiKey;
      if (++this.successStreak >= 30) { this.backoffFactor = Math.max(1, this.backoffFactor - 0.25); this.successStreak = 0; }
      return data;
    }
    catch {
      const invalid = new Error('GMGN返回的数据格式无法解析，已丢弃原始响应并等待重试。');
      invalid.code = 'GMGN_INVALID_RESPONSE';
      throw invalid;
    }
  }

  async configured() {
    return Boolean(this.apiKey());
  }

  async probe(options = {}) {
    return new GmgnAdapter({ client: this }).probe(options);
  }

  resetCredentials({ disabled = false } = {}) {
    this.keyEpoch++;
    this.disabled = disabled;
    this.cache.clear();
    this.lastVerifiedKey = '';
    // Preserve the provider cooldown: changing/disconnecting keys must not bypass it.
  }

  async cachedRead(args, ttlMs = 0) {
    const epoch = this.keyEpoch;
    const key = JSON.stringify(args);
    const cached = this.cache.get(key);
    if (!this.disabled && cached && cached.epoch === epoch && Date.now() - cached.at < ttlMs) {
      this.metrics.cacheHits++;
      return structuredClone(cached.value);
    }
    const value = await this.run(args);
    if (!this.disabled && epoch === this.keyEpoch) {
      this.cache.set(key, { value, at: Date.now(), epoch });
      if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value);
    }
    return value;
  }

  async priceAt(address, targetAt, chain) {
    // A closed 1m candle nearest the requested horizon, never today's price
    // backfilled into an earlier horizon. The timestamp remains part of the evidence.
    const from = Math.floor((targetAt - 120_000) / 1000);
    const to = Math.floor((targetAt + 60_000) / 1000);
    const raw = await this.run(['market', 'kline', '--chain', chain, '--address', address,
      '--resolution', '1m', '--from', String(from), '--to', String(to), '--raw']);
    const rows = normalizeList(raw).map(row => ({ at: Number(row.time) + 60_000, price: Number(row.close) }))
      .filter(row => Number.isFinite(row.at) && row.at <= Date.now() && Math.abs(row.at - targetAt) <= 60_000 && row.price > 0 && Number.isFinite(row.price))
      .sort((a, b) => Math.abs(a.at - targetAt) - Math.abs(b.at - targetAt));
    return rows[0] ? { ...rows[0], source: 'GMGN_1M_CLOSE' } : null;
  }

  async verifyApiKey(apiKey) {
    const key = normalizeGmgnApiKey(apiKey);
    if (!key) throw translateGmgnError(new Error('invalid api key'));
    // A pending local key proves the user started the mandatory Agent/public-key
    // creation flow. Market scanning itself uses API-key read auth, so verifying
    // through a signed follow-wallet /trade route would waste quota and can lock
    // a fresh account before its first scan.
    if (!this.privateKey()) throw Object.assign(new Error('GMGN onboarding is required'), { code: 'GMGN_ONBOARDING_REQUIRED' });
    const deadline = Date.now() + 45_000;
    let timer;
    try {
      await Promise.race([
        this.run(['auth', 'verify-read', '--raw'], { apiKey: key, deadline, verification: true }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(translateGmgnError(new Error('GMGN_TIMEOUT'))), 45_000); })
      ]);
      return { verified: true };
    } finally { clearTimeout(timer); }
  }

  async discoverStage(chain = 'robinhood', stage = 'completed', limit = 80) {
    if (!['new_creation', 'near_completion', 'completed'].includes(stage)
      || !Number.isInteger(limit) || limit < 1 || limit > 80) throw new Error('Invalid lifecycle discovery request');
    const raw = await this.run(['market', 'trenches', '--chain', chain, '--type', stage, '--limit', String(limit), '--raw']);
    return normalizeList(raw, [stage]);
  }

  async signals(chain = 'robinhood', signalTypes = [], limit = 50) {
    const allowed = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 17, 18, 19, 20, 21]);
    if (!Array.isArray(signalTypes) || !signalTypes.length || signalTypes.some(type => !allowed.has(type))
      || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid signal request');
    const raw = await this.run(['market', 'signal', '--chain', chain, '--signal-type', signalTypes.join(','), '--limit', String(limit), '--raw']);
    return normalizeList(raw, ['list', 'rank', 'tokens']);
  }

  async discover(chain = 'robinhood') {
    const requests = discoveryRequestArgs(chain);
    const [trenches, trending] = await Promise.allSettled([
      this.run(requests.trenches),
      this.run(requests.trending)
    ]);
    const trenchRows = trenches.status === 'fulfilled' ? normalizeList(trenches.value, ['completed']) : [];
    const trendingRows = trending.status === 'fulfilled' ? normalizeList(trending.value, ['rank']) : [];
    this.lastDiscoveryHealth = {
      complete: trenches.status === 'fulfilled' && trending.status === 'fulfilled',
      trenches: trenches.status === 'fulfilled' ? { ok: true, count: trenchRows.length } : errorSummary(trenches.reason),
      trending: trending.status === 'fulfilled' ? { ok: true, count: trendingRows.length } : errorSummary(trending.reason),
      checkedAt: Date.now()
    };
    const rows = [...trenchRows, ...trendingRows];
    if (!rows.length) {
      const failures = [trenches, trending].filter(x => x.status === 'rejected');
      if (failures.length === 2) throw failures[0].reason;
    }
    const merged = new Map();
    for (const row of rows.filter(row => row?.address)) {
      const address = chain === 'sol' ? String(row.address) : String(row.address).toLowerCase();
      merged.set(address, mergeDefined(merged.get(address), row));
    }
    return [...merged.values()];
  }

  async audit(address, nowSec = Math.floor(Date.now() / 1000), chain = 'robinhood', { shouldStopEarly, endpointNames = null, stage = 'completed' } = {}) {
    const base = ['--chain', chain, '--address', address, '--raw'];
    const from = String(nowSec - 20 * 60), to = String(nowSec);
    const allSpecs = [
      ['info', ['token', 'info', ...base]],
      ['security', ['token', 'security', ...base]],
      ['pool', ['token', 'pool', ...base]],
      ['holders', ['token', 'holders', '--chain', chain, '--address', address, '--limit', '100', '--raw']],
      ['traders', ['token', 'traders', '--chain', chain, '--address', address, '--limit', '50', '--raw']],
      ['candles', ['market', 'kline', '--chain', chain, '--address', address, '--resolution', '1m', '--from', from, '--to', to, '--raw']]
    ];
    const allowed = new Set(endpointNames || allSpecs.map(([name]) => name));
    const specs = allSpecs.filter(([name]) => allowed.has(name));
    const staticNames = new Set(['info', 'security', 'pool']);
    const staticSpecs = specs.filter(([name]) => staticNames.has(name));
    const dynamicSpecs = specs.filter(([name]) => !staticNames.has(name));
    const result = {
      info: {}, security: {}, pool: {}, holders: [], traders: [], candles: [],
      _meta: { complete: false, earlyExit: true, stage, endpoints: {}, auditedAt: Date.now() }
    };
    const assign = (name, call) => {
      if (call.status === 'fulfilled') {
        result[name] = ['holders', 'traders', 'candles'].includes(name) ? normalizeList(call.value) : unwrap(call.value) || {};
        result._meta.endpoints[name] = { ok: true };
      } else {
        result._meta.endpoints[name] = errorSummary(call.reason);
      }
    };
    const staticCalls = await Promise.allSettled(staticSpecs.map(([name, args]) => this.cachedRead(args, name === 'security' ? 60_000 : 15_000)));
    staticSpecs.forEach(([name], index) => assign(name, staticCalls[index]));
    if (staticCalls.every(call => call.status === 'fulfilled') && shouldStopEarly?.(result)) return result;

    const dynamicCalls = await Promise.allSettled(dynamicSpecs.map(([, args]) => this.cachedRead(args, 15_000)));
    dynamicSpecs.forEach(([name], index) => assign(name, dynamicCalls[index]));
    const calls = [...staticCalls, ...dynamicCalls];
    result._meta.complete = calls.length > 0 && calls.every(call => call.status === 'fulfilled');
    result._meta.earlyExit = stage !== 'completed' || specs.length < allSpecs.length;
    if (calls.length && calls.every(call => call.status === 'rejected')) {
      const limited = calls.find(call => call.reason?.code === 'GMGN_RATE_LIMITED');
      throw limited?.reason || calls[0].reason;
    }
    return result;
  }

  async auditStage(address, stage, nowSec = Math.floor(Date.now() / 1000), chain = 'robinhood', options = {}) {
    const endpointNames = stage === 'new_creation'
      ? ['info', 'security', 'pool']
      : stage === 'near_completion'
        ? ['info', 'security', 'pool', 'holders', 'traders']
        : null;
    if (endpointNames === null && !['completed', 'migrated'].includes(stage)) throw new Error('Invalid audit stage');
    return this.audit(address, nowSec, chain, { ...options, endpointNames, stage });
  }
}
