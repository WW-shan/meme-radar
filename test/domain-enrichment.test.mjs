import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichDomain } from '../src/enrichment/domain.mjs';
import { SecondaryValidator } from '../src/secondary.mjs';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

function imageResponse(bytes, contentType = 'image/x-icon') {
  return new Response(bytes, { status: 200, headers: { 'content-type': contentType } });
}

test('domain enrichment hashes visual assets without storing remote files', async () => {
  const result = await enrichDomain({
    website: 'https://example.com',
    html: '<html><head><link rel="icon" href="/favicon.ico"></head></html>',
    lookupImpl: publicLookup,
    fetchImpl: async () => imageResponse(Buffer.from('icon-bytes'))
  });
  assert.match(result.faviconHash, /^[a-f0-9]{64}$/);
  assert.equal(result.htmlBytes > 0, true);
  assert.equal(result.hashAlgorithm, 'sha256');
  assert.equal(result.source, 'website');
  assert.equal(result.sharedAsset, false);
});

test('domain enrichment rejects loopback, private, link-local and metadata targets before fetching', async () => {
  for (const website of [
    'http://127.0.0.1/',
    'http://10.0.0.1/',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/'
  ]) {
    let called = false;
    await assert.rejects(() => enrichDomain({
      website,
      html: '<link rel="icon" href="/favicon.ico">',
      fetchImpl: async () => { called = true; return imageResponse(Buffer.from('x')); }
    }), error => error.code === 'SSRF_BLOCKED');
    assert.equal(called, false);
  }
});

test('domain enrichment rejects non-standard ports and dangerous redirects', async () => {
  await assert.rejects(() => enrichDomain({
    website: 'https://example.com:8443',
    html: '<link rel="icon" href="/favicon.ico">',
    lookupImpl: publicLookup,
    fetchImpl: async () => imageResponse(Buffer.from('x'))
  }), error => error.code === 'SSRF_BLOCKED');

  await assert.rejects(() => enrichDomain({
    website: 'https://example.com',
    html: '<link rel="icon" href="/favicon.ico">',
    lookupImpl: publicLookup,
    fetchImpl: async () => new Response('', { status: 302, headers: { location: 'http://127.0.0.1/' } })
  }), error => error.code === 'REDIRECT_BLOCKED');
});

test('domain enrichment enforces MIME, size and timeout limits', async () => {
  await assert.rejects(() => enrichDomain({
    website: 'https://example.com',
    html: '<link rel="icon" href="/favicon.ico">',
    lookupImpl: publicLookup,
    fetchImpl: async () => imageResponse(Buffer.from('not-an-image'), 'text/html')
  }), error => error.code === 'INVALID_CONTENT_TYPE');

  await assert.rejects(() => enrichDomain({
    website: 'https://example.com',
    html: '<link rel="icon" href="/favicon.ico">',
    lookupImpl: publicLookup,
    maxBytes: 4,
    fetchImpl: async () => imageResponse(Buffer.from('too-large'))
  }), error => error.code === 'RESPONSE_TOO_LARGE');

  const never = async (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  await assert.rejects(() => enrichDomain({
    website: 'https://example.com',
    html: '<link rel="icon" href="/favicon.ico">',
    lookupImpl: publicLookup,
    timeoutMs: 5,
    fetchImpl: never
  }), error => error.code === 'TIMEOUT');
});

test('favicon hashes are deterministic and shared assets are evidence only', async () => {
  const options = {
    website: 'https://example.com',
    html: '<link rel="icon" href="/favicon.ico">',
    lookupImpl: publicLookup,
    fetchImpl: async () => imageResponse(Buffer.from('same-bytes'))
  };
  const first = await enrichDomain(options);
  const second = await enrichDomain(options);
  assert.equal(first.faviconHash, second.faviconHash);
  assert.equal(first.templateHash, second.templateHash);

  const shared = await enrichDomain({
    ...options,
    knownAssets: [{ domain: 'other.example', faviconHash: first.faviconHash }]
  });
  assert.equal(shared.sharedAsset, true);
  assert.equal(shared.riskEvidence[0].type, 'SHARED_BRAND_ASSET');
  assert.equal(shared.status, 'OK');
  assert.equal(shared.verdict, undefined);
  assert.match(shared.riskEvidence[0].evidenceNote, /不代表诈骗结论/);
});

test('secondary validation attaches domain reuse evidence without treating it as fraud', async () => {
  const address = '0x' + '4'.repeat(40);
  const fetchImpl = async url => {
    if (url.includes('dexscreener.com')) return new Response(JSON.stringify([{
      chainId: 'bsc', pairAddress: 'pair', url: 'https://dexscreener.com/bsc/pair',
      baseToken: { address, symbol: 'T', name: 'Token' }, priceUsd: '1', marketCap: 50_000,
      liquidity: { usd: 20_000 }, info: { websites: [{ url: 'https://example.com' }] }
    }]), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('gopluslabs.io')) return new Response(JSON.stringify({ code: 1, result: {
      [address]: { is_honeypot: '0', is_open_source: '1', is_mintable: '0', owner_change_balance: '0', hidden_owner: '0', cannot_sell_all: '0', selfdestruct: '0', external_call: '0', slippage_modifiable: '0', personal_slippage_modifiable: '0', transfer_pausable: '0', is_blacklisted: '0', trading_cooldown: '0', buy_tax: '0.01', sell_tax: '0.01' }
    } }), { status: 200, headers: { 'content-type': 'application/json' } });
    return imageResponse(Buffer.from('shared-icon'));
  };
  const first = await enrichDomain({ website: 'https://example.com', html: '<link rel="icon" href="/favicon.ico">', lookupImpl: publicLookup, fetchImpl: async () => imageResponse(Buffer.from('shared-icon')) });
  const result = await new SecondaryValidator({
    fetchImpl,
    domainLookupImpl: publicLookup,
    knownAssets: [{ domain: 'other.example', faviconHash: first.faviconHash }]
  }).validate({
    chain: 'bsc', tokenAddress: address,
    primary: { html: '<link rel="icon" href="/favicon.ico">', market: { website: 'https://example.com' } }
  });
  assert.equal(result.domain.sharedAsset, true);
  assert.equal(result.domain.riskEvidence[0].type, 'SHARED_BRAND_ASSET');
  assert.equal(result.status, 'COMPLETE');
  assert.equal(result.domain.verdict, undefined);
  assert.match(result.domain.riskEvidence[0].evidenceNote, /不代表诈骗结论/);
});
