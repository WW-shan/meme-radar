import test from 'node:test';
import assert from 'node:assert/strict';
import { EntityGraph, entityMetrics } from '../src/analytics/entity-graph.mjs';

test('shared funding and repeated co-buy evidence merge wallets deterministically', () => {
  const graph = new EntityGraph({ minCoBuyEvidence: 2 });
  graph.addFunding('wallet-b', 'source-1');
  graph.addFunding('wallet-a', 'source-1');
  graph.addCoBuy('wallet-b', 'wallet-a', 'token-1');
  graph.addCoBuy('wallet-a', 'wallet-b', 'token-2');
  assert.deepEqual([...graph.clusterFor('wallet-a')].sort(), ['wallet-a', 'wallet-b']);
  assert.equal(graph.coBuyCount(['wallet-a', 'wallet-b']), 2);
  assert.equal(graph.holdRate(['wallet-a', 'wallet-b'], { 'wallet-a': .3, 'wallet-b': .2 }), .5);
});

test('a single noisy co-buy does not merge unrelated wallets', () => {
  const graph = new EntityGraph({ minCoBuyEvidence: 2 });
  graph.addCoBuy('a', 'b', 'noise');
  assert.deepEqual([...graph.clusterFor('a')], ['a']);
  assert.equal(graph.evidence()[0].applied, false);
});

test('unrelated funding sources do not merge wallets', () => {
  const graph = new EntityGraph();
  graph.addFunding('a', 's1');
  graph.addFunding('b', 's2');
  assert.deepEqual([...graph.clusterFor('a')], ['a']);
  assert.deepEqual([...graph.clusterFor('b')], ['b']);
});

test('entity metrics preserve incompleteness and do not treat missing data as safe', () => {
  const graph = new EntityGraph();
  graph.addFunding('a', 's1');
  graph.addFunding('b', 's1');
  const metrics = entityMetrics(graph, ['a', 'b'], { a: .3, b: .2 }, { dataComplete: false });
  assert.equal(metrics.entityHoldRate, .5);
  assert.equal(metrics.bundleHoldRate, .5);
  assert.equal(metrics.entityDataComplete, false);
  assert.equal(metrics.entityWalletCount, 2);
});

test('graph output is independent of insertion order', () => {
  const left = new EntityGraph(); left.addFunding('b', 's'); left.addFunding('a', 's');
  const right = new EntityGraph(); right.addFunding('a', 's'); right.addFunding('b', 's');
  assert.deepEqual([...left.clusterFor('a')].sort(), [...right.clusterFor('a')].sort());
});
