import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichSocial, SOCIAL_ENRICHMENT_VERSION } from '../src/enrichment/social.mjs';
import { socialGate } from '../src/social.mjs';

test('social enrichment reports age, duplicate content and explicit account reuse evidence', () => {
  const result = enrichSocial({
    handle: 'token',
    accountCreatedAt: 1_700_000_000_000,
    observedAt: 1_800_000_000_000,
    posts: [{ text: 'BUY NOW', at: 1 }, { text: 'buy now', at: 2 }],
    reusedHandles: ['token']
  });
  assert.equal(result.version, SOCIAL_ENRICHMENT_VERSION);
  assert.equal(result.accountAgeDays, 1157);
  assert.equal(result.duplicatePostRate, .5);
  assert.equal(result.reusedHandle, true);
  assert.equal(result.reusedHandleEvidence.type, 'HANDLE_REUSE');
  assert.equal(result.dataComplete, true);
  assert.equal(result.riskEligible, true);
  assert.equal(result.followerCount, null);
});

test('missing accounts, times, posts and reuse lists are explicit unknowns', () => {
  const result = enrichSocial({});
  assert.equal(result.accountAgeDays, null);
  assert.equal(result.duplicatePostRate, null);
  assert.equal(result.reusedHandle, null);
  assert.equal(result.dataComplete, false);
  assert.equal(result.riskEligible, false);
  assert.ok(result.unknownFields.includes('social.handle'));
  assert.ok(result.unknownFields.includes('social.accountCreatedAt'));
  assert.ok(result.unknownFields.includes('social.observedAt'));
  assert.ok(result.unknownFields.includes('social.posts'));
  assert.ok(result.unknownFields.includes('social.reusedHandles'));
});

test('negative age, empty posts and invalid duplicate rates never become normal values', () => {
  const negative = enrichSocial({ handle: 'token', accountCreatedAt: 200, observedAt: 100, posts: [{ text: 'x' }], reusedHandles: [] });
  assert.equal(negative.accountAgeDays, null);
  assert.equal(negative.accountAgeInvalid, true);
  assert.equal(negative.riskEligible, false);
  assert.ok(negative.unknownFields.includes('social.accountCreatedAt'));

  const empty = enrichSocial({ handle: 'token', accountCreatedAt: 100, observedAt: 200, posts: [{ text: '   ' }], reusedHandles: [] });
  assert.equal(empty.duplicatePostRate, null);
  assert.equal(empty.riskEligible, false);
  assert.ok(empty.unknownFields.includes('social.posts'));
});

test('social evidence is bounded, deterministic and traceable without fabricated metrics', () => {
  const input = {
    handle: 'token',
    source: 'gmgn-discovery',
    accountCreatedAt: 1_700_000_000_000,
    observedAt: 1_800_000_000_000,
    followerCount: 123,
    posts: [{ text: 'A', at: 1 }, { text: 'A', at: 2 }, { text: 'B', at: 3 }],
    reusedHandles: []
  };
  const first = enrichSocial(input);
  const second = enrichSocial(input);
  assert.deepEqual(first, second);
  assert.equal(first.source, 'gmgn-discovery');
  assert.equal(first.collectedAt, 1_800_000_000_000);
  assert.equal(first.followerCount, 123);
  assert.equal(first.contentFingerprints.length, 2);
  assert.ok(Math.abs(first.duplicatePostRate - 1 / 3) < 1e-12);
  assert.ok(first.contentFingerprints.every(value => /^[a-f0-9]{64}$/.test(value)));
  assert.equal(first.engagement, null);
});

test('socialGate treats reuse as UNVERIFIED evidence and never labels it as fraud', () => {
  const result = socialGate({
    twitter: 'token',
    duplicateSocial: true,
    capability: { available: true, backend: 'agent-reach' },
    accountCreatedAt: 1_700_000_000_000,
    observedAt: 1_800_000_000_000,
    posts: [{ text: 'A' }],
    reusedHandles: ['token']
  });
  assert.equal(result.status, 'UNVERIFIED');
  assert.equal(result.reusedHandle, true);
  assert.equal(result.evidenceType, 'HANDLE_REUSE');
  assert.doesNotMatch(result.reason, /诈骗/);
  assert.equal(result.dataComplete, true);
  assert.equal(result.riskEligible, true);
});

test('incomplete social data is surfaced for risk scoring instead of defaulting to normal', () => {
  const result = socialGate({ twitter: 'token', capability: { available: true, backend: 'agent-reach' } });
  assert.equal(result.riskEligible, false);
  assert.equal(result.dataComplete, false);
  assert.ok(result.unknownFields.includes('social.accountCreatedAt'));
  assert.ok(result.unknownFields.includes('social.posts'));
});
