import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEvmFactories, parseEvmStartBlocks } from '../src/config.mjs';

const address = `0x${'1'.repeat(40)}`;
const topic = `0x${'a'.repeat(64)}`;

test('EVM factory config accepts validated JSON and freezes normalized entries', () => {
  const parsed = parseEvmFactories(JSON.stringify({
    bsc: [{ address: address.toUpperCase(), topic: topic.toUpperCase(), tokenTopicIndex: 0 }],
    eth: []
  }));
  assert.deepEqual(parsed, {
    bsc: [{ address: address.toUpperCase(), topic: topic.toUpperCase(), tokenTopicIndex: 0 }],
    base: [],
    eth: []
  });
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.bsc), true);
  assert.equal(Object.isFrozen(parsed.bsc[0]), true);
});

test('EVM factory config rejects malformed JSON, chains, addresses and topics', () => {
  for (const raw of [
    '{',
    JSON.stringify({ solana: [{ address, topic }] }),
    JSON.stringify({ bsc: [{ address: '0x1234', topic }] }),
    JSON.stringify({ base: [{ address, topic: '0x1234' }] }),
    JSON.stringify({ eth: [{ address, topic, tokenTopicIndex: 4 }] })
  ]) {
    assert.throws(() => parseEvmFactories(raw), error => error.code === 'INVALID_EVM_FACTORY_CONFIG');
  }
});

test('EVM start blocks are chain-scoped, non-negative safe integers and deterministic', () => {
  assert.deepEqual(parseEvmStartBlocks('{"bsc":123,"eth":0}'), { bsc: 123, base: 0, eth: 0 });
  for (const raw of ['{', '{"bsc":-1}', '{"base":1.5}', '{"sol":1}']) {
    assert.throws(() => parseEvmStartBlocks(raw), error => error.code === 'INVALID_EVM_START_BLOCKS');
  }
});

test('EVM factory config supports quote-token exclusion and both V2 token topics', () => {
  const wbnb = `0x${'b'.repeat(40)}`;
  const parsed = parseEvmFactories(JSON.stringify({
    bsc: [{ address, topic, tokenTopicIndexes: [1, 2], excludeTokens: [wbnb] }]
  }));
  assert.deepEqual(parsed.bsc[0].tokenTopicIndexes, [1, 2]);
  assert.deepEqual(parsed.bsc[0].excludeTokens, [wbnb]);
  assert.equal(Object.isFrozen(parsed.bsc[0].tokenTopicIndexes), true);
  for (const row of [
    { address, topic, tokenTopicIndexes: [] },
    { address, topic, tokenTopicIndexes: [1, 4] },
    { address, topic, excludeTokens: ['0x1234'] }
  ]) {
    assert.throws(() => parseEvmFactories(JSON.stringify({ bsc: [row] })), error => error.code === 'INVALID_EVM_FACTORY_CONFIG');
  }
});
