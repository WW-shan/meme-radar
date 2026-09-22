import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

export const DOMAIN_ENRICHMENT_VERSION = 'domain-enrichment-v1';
const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_MAX_HTML_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const ALLOWED_PORTS = Object.freeze({ 'http:': '80', 'https:': '443' });

function failure(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function ipv4Parts(host) {
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.map(Number);
}

function isPrivateAddress(address) {
  const host = String(address || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const ipv4 = ipv4Parts(host);
  if (ipv4) {
    const [a, b, c] = ipv4;
    return a === 0 || a === 10 || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113)
      || (a === 100 && b === 100 && c === 100 && ipv4[3] === 200)
      || a >= 224;
  }
  if (isIP(host) !== 6) return false;
  if (host === '::' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  if (host.startsWith('::ffff:')) {
    const mapped = host.slice('::ffff:'.length);
    if (ipv4Parts(mapped)) return isPrivateAddress(mapped);
    const hexMapped = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mapped);
    if (hexMapped) {
      const high = Number.parseInt(hexMapped[1], 16);
      const low = Number.parseInt(hexMapped[2], 16);
      return isPrivateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
  }
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8') || host.startsWith('fe9')
    || host.startsWith('fea') || host.startsWith('feb') || host.startsWith('ff')) return true;
  return host.startsWith('2001:db8:');
}

async function assertSafeUrl(url, lookupImpl) {
  if (!(url instanceof URL) || !['http:', 'https:'].includes(url.protocol)) throw failure('SSRF_BLOCKED', 'unsupported URL protocol');
  if (url.username || url.password) throw failure('SSRF_BLOCKED', 'URL credentials are not allowed');
  const expectedPort = ALLOWED_PORTS[url.protocol];
  if (url.port && url.port !== expectedPort) throw failure('SSRF_BLOCKED', 'non-standard port');
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')
    || hostname.endsWith('.internal') || hostname === 'metadata') {
    throw failure('SSRF_BLOCKED', 'blocked hostname');
  }
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw failure('SSRF_BLOCKED', 'private or special-use address');
    return;
  }
  if (lookupImpl) {
    let records;
    try { records = await lookupImpl(hostname, { all: true }); }
    catch { throw failure('DNS_LOOKUP_FAILED', 'hostname lookup failed'); }
    const addresses = (Array.isArray(records) ? records : [records]).map(record => record?.address).filter(Boolean);
    if (!addresses.length) throw failure('DNS_LOOKUP_FAILED', 'hostname has no addresses');
    if (addresses.some(isPrivateAddress)) throw failure('SSRF_BLOCKED', 'hostname resolves to a private address');
  }
}

async function readLimitedBytes(response, maxBytes) {
  const contentLength = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw failure('RESPONSE_TOO_LARGE', 'response too large');
  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        total += chunk.byteLength;
        if (total > maxBytes) throw failure('RESPONSE_TOO_LARGE', 'response too large');
        chunks.push(chunk);
      }
    } finally {
      if (total > maxBytes) await reader.cancel().catch(() => {});
    }
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return Buffer.from(combined);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw failure('RESPONSE_TOO_LARGE', 'response too large');
  return bytes;
}

async function fetchAsset(url, {
  fetchImpl,
  lookupImpl,
  timeoutMs,
  maxBytes,
  accept,
  contentTypes
}) {
  const target = new URL(url);
  await assertSafeUrl(target, lookupImpl);
  if (typeof fetchImpl !== 'function') throw failure('FETCH_FAILED', 'fetch implementation is required');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(target.href, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: { Accept: accept }
    });
    if (!response || typeof response.ok !== 'boolean') throw failure('FETCH_FAILED', 'invalid response');
    if (response.redirected === true || (response.status >= 300 && response.status < 400)) {
      throw failure('REDIRECT_BLOCKED', 'redirects are not allowed');
    }
    if (response.url && new URL(response.url).origin !== target.origin) throw failure('REDIRECT_BLOCKED', 'cross-origin response');
    if (!response.ok) throw failure(`HTTP_${Number(response.status) || 0}`, 'upstream HTTP error');
    const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase().split(';')[0].trim();
    if (!contentTypes.some(type => type.endsWith('/*') ? contentType.startsWith(type.slice(0, -1)) : contentType === type)) {
      throw failure('INVALID_CONTENT_TYPE', 'unexpected content type');
    }
    return await readLimitedBytes(response, maxBytes);
  } catch (error) {
    if (controller.signal.aborted && error?.code !== 'RESPONSE_TOO_LARGE') throw failure('TIMEOUT', 'request timed out');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function faviconHref(html, website) {
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const rel = /rel\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] || '';
    if (!/\bicon\b/i.test(rel)) continue;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (href) return new URL(href, website).href;
  }
  return new URL('/favicon.ico', website).href;
}

export async function enrichDomain({
  website,
  html = null,
  fetchImpl = globalThis.fetch,
  lookupImpl = dnsLookup,
  maxBytes = DEFAULT_MAX_BYTES,
  maxHtmlBytes = DEFAULT_MAX_HTML_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  knownAssets = [],
  now = Date.now
} = {}) {
  let site;
  try { site = new URL(String(website || '')); }
  catch { throw failure('INVALID_URL', 'invalid website URL'); }
  await assertSafeUrl(site, lookupImpl);
  const byteLimit = Math.max(1, Number(maxBytes) || DEFAULT_MAX_BYTES);
  const htmlLimit = Math.max(1, Number(maxHtmlBytes) || DEFAULT_MAX_HTML_BYTES);
  const timeout = Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
  let sourceHtml = html;
  if (sourceHtml === null || sourceHtml === undefined) {
    const bytes = await fetchAsset(site.href, {
      fetchImpl, lookupImpl, timeoutMs: timeout, maxBytes: htmlLimit,
      accept: 'text/html,application/xhtml+xml',
      contentTypes: ['text/html', 'application/xhtml+xml']
    });
    sourceHtml = new TextDecoder().decode(bytes);
  }
  const htmlText = String(sourceHtml);
  const htmlBytes = Buffer.byteLength(htmlText, 'utf8');
  if (htmlBytes > htmlLimit) throw failure('RESPONSE_TOO_LARGE', 'HTML response too large');
  const iconUrl = faviconHref(htmlText, site);
  const bytes = await fetchAsset(iconUrl, {
    fetchImpl, lookupImpl, timeoutMs: timeout, maxBytes: byteLimit,
    accept: 'image/*',
    contentTypes: ['image/*']
  });
  const faviconHash = crypto.createHash('sha256').update(bytes).digest('hex');
  const templateHash = crypto.createHash('sha256').update(htmlText.replace(/\s+/g, ' ').trim()).digest('hex');
  const hostname = site.hostname.toLowerCase().replace(/^www\./, '');
  const matches = (Array.isArray(knownAssets) ? knownAssets : []).filter(asset =>
    (asset?.faviconHash && asset.faviconHash === faviconHash)
    || (asset?.templateHash && asset.templateHash === templateHash)
    || (asset?.domain && String(asset.domain).toLowerCase().replace(/^www\./, '') === hostname));
  const riskEvidence = matches.length ? [{
    type: 'SHARED_BRAND_ASSET',
    domain: hostname,
    matchedDomain: matches.map(asset => String(asset.domain || '')).filter(Boolean).slice(0, 10),
    faviconHash,
    templateHash,
    evidenceNote: '共享域名、模板或视觉资产仅作为复用证据，不代表诈骗结论。'
  }] : [];
  return {
    version: DOMAIN_ENRICHMENT_VERSION,
    status: 'OK',
    source: 'website',
    website: site.href,
    faviconUrl: iconUrl,
    faviconHash,
    templateHash,
    hashAlgorithm: 'sha256',
    htmlBytes,
    collectedAt: now(),
    sharedAsset: riskEvidence.length > 0,
    riskEvidence,
    errorCode: null
  };
}
