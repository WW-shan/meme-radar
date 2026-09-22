import crypto from 'node:crypto';

export const SOCIAL_ENRICHMENT_VERSION = 'social-enrichment-v1';
const DAY_MS = 86_400_000;

function finiteOrNull(value, minimum = -Infinity) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum ? number : null;
}

function normalizedHandle(value) {
  const handle = String(value ?? '').trim().replace(/^@/, '');
  return /^[A-Za-z0-9_]{1,15}$/.test(handle) ? handle.toLowerCase() : '';
}

function normalizedText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function fingerprint(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function enrichSocial(input = {}) {
  const handle = normalizedHandle(input.handle);
  const observedAt = finiteOrNull(input.observedAt, 0);
  const accountCreatedAt = finiteOrNull(input.accountCreatedAt, 0);
  const posts = Array.isArray(input.posts) ? input.posts : null;
  const reusedHandles = Array.isArray(input.reusedHandles)
    ? input.reusedHandles.map(normalizedHandle).filter(Boolean)
    : null;
  const validPosts = (posts || []).map((post, index) => {
    const text = normalizedText(post?.text);
    if (!text) return null;
    return {
      at: finiteOrNull(post?.at, 0),
      fingerprint: fingerprint(text),
      length: text.length,
      index
    };
  }).filter(Boolean);
  const uniqueTexts = new Set(validPosts.map(post => post.fingerprint));
  const duplicatePostCount = validPosts.length - uniqueTexts.size;
  const duplicatePostRate = validPosts.length ? duplicatePostCount / validPosts.length : null;
  const ageMs = observedAt !== null && accountCreatedAt !== null ? observedAt - accountCreatedAt : null;
  const accountAgeInvalid = ageMs !== null && ageMs < 0;
  const accountAgeDays = ageMs === null || accountAgeInvalid ? null : Math.floor(ageMs / DAY_MS);
  const reusedHandle = reusedHandles === null || !handle ? null : reusedHandles.includes(handle);
  const followerCount = finiteOrNull(input.followerCount, 0);
  const unknownFields = [];
  if (!handle) unknownFields.push('social.handle');
  if (accountCreatedAt === null) unknownFields.push('social.accountCreatedAt');
  if (observedAt === null) unknownFields.push('social.observedAt');
  if (accountAgeInvalid) unknownFields.push('social.accountCreatedAt');
  if (!posts || validPosts.length === 0) unknownFields.push('social.posts');
  else if (validPosts.length !== posts.length) unknownFields.push('social.posts.invalid');
  if (reusedHandles === null) unknownFields.push('social.reusedHandles');
  if (input.followerCount !== undefined && input.followerCount !== null && followerCount === null) unknownFields.push('social.followerCount');
  const uniqueUnknownFields = [...new Set(unknownFields)];
  const dataComplete = uniqueUnknownFields.length === 0;
  const riskEligible = dataComplete;
  return {
    version: SOCIAL_ENRICHMENT_VERSION,
    handle,
    source: String(input.source || 'provided').trim().slice(0, 80),
    collectedAt: observedAt,
    observedAt,
    accountCreatedAt,
    accountAgeDays,
    accountAgeInvalid,
    followerCount,
    engagement: null,
    postCount: posts?.length || 0,
    validPostCount: validPosts.length,
    duplicatePostCount,
    duplicatePostRate,
    reusedHandle,
    reusedHandleEvidence: reusedHandle === true ? {
      type: 'HANDLE_REUSE',
      handle,
      source: 'reusedHandles'
    } : null,
    contentFingerprints: [...uniqueTexts].slice(0, 20),
    postEvidence: validPosts.slice(0, 20).map(post => ({ at: post.at, fingerprint: post.fingerprint, length: post.length })),
    dataComplete,
    riskEligible,
    unknownFields: uniqueUnknownFields
  };
}
