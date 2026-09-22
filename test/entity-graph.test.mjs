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

test('explicit bundle evidence requires provenance and merges deterministically', () => {
  const graph = new EntityGraph();
  graph.addBundle(['wallet-a', 'wallet-b', 'wallet-a'], {
    transactionHash: '0xtx',
    token: 'token-1',
    confidence: .95,
    source: 'same-transaction'
  });
  assert.deepEqual([...graph.clusterFor('wallet-a')].sort(), ['wallet-a', 'wallet-b']);
  assert.equal(graph.bundleCount(['wallet-a', 'wallet-b']), 1);
  assert.equal(graph.evidence().find(row => row.type === 'bundle').transactionHash, '0xtx');
  assert.throws(() => graph.addBundle(['a', 'b'], {}), /bundle provenance/);
  assert.throws(() => graph.addBundle(['a', 'b'], { transactionHash: '0xtx', confidence: .2 }), /bundle confidence/);
});

test('cross-launch cohort evidence requires at least two launches and is queryable', () => {
  const graph = new EntityGraph();
  graph.addLaunchCohort(['wallet-a', 'wallet-b'], ['launch-1', 'launch-2'], { source: 'first-buyers' });
  assert.deepEqual([...graph.clusterFor('wallet-b')].sort(), ['wallet-a', 'wallet-b']);
  assert.equal(graph.launchCohortCount(['wallet-a', 'wallet-b']), 1);
  assert.throws(() => graph.addLaunchCohort(['a', 'b'], ['only-one']), /two launches/);
});

test('entity metrics expose explicit bundle and cohort counts for selected wallets', () => {
  const graph = new EntityGraph();
  graph.addBundle(['wallet-a', 'wallet-b'], { transactionHash: '0xtx', confidence: .95 });
  graph.addLaunchCohort(['wallet-a', 'wallet-c'], ['l1', 'l2']);
  const result = entityMetrics(graph, ['wallet-a', 'wallet-b', 'wallet-c'], { 'wallet-a': .2, 'wallet-b': .1, 'wallet-c': .1 });
  assert.equal(result.bundleCount, 1);
  assert.equal(result.launchCohortCount, 1);
  assert.equal(result.entityWalletCount, 3);
});
