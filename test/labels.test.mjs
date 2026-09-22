import test from 'node:test';
import assert from 'node:assert/strict';
import { LABEL_VERSION, assignLabel, migrateLabel } from '../src/evaluation/labels.mjs';

test('labels use only evidence after observation cutoff and through the horizon boundary', () => {
  const label = assignLabel({
    observedAt: 1000,
    horizonAt: 2000,
    observations: [
      { at: 1000, price: .1 },
      { at: 1500, price: .4 },
      { at: 2000, price: .2 },
      { at: 2100, price: .05 }
    ],
    baselinePrice: 1,
    successThreshold: 2
  });
  assert.equal(label.status, 'LABELED');
  assert.equal(label.rug, true);
  assert.equal(label.success, false);
  assert.equal(label.evidenceCount, 2);
  assert.equal(label.labeledAt, 2000);
  assert.equal(label.cutoff, 2000);
  assert.equal(label.version, LABEL_VERSION);
});

test('zero evidence and missing baseline price are explicitly unknown', () => {
  const empty = assignLabel({ observedAt: 1000, horizonAt: 2000, observations: [], baselinePrice: 1 });
  assert.equal(empty.status, 'UNKNOWN');
  assert.equal(empty.reason, 'INSUFFICIENT_EVIDENCE');
  assert.equal(empty.label, 'UNKNOWN');
  assert.equal(empty.rug, null);
  assert.equal(empty.success, null);

  const noBaseline = assignLabel({ observedAt: 1000, horizonAt: 2000, observations: [{ at: 1500, price: 2 }] });
  assert.equal(noBaseline.status, 'UNKNOWN');
  assert.equal(noBaseline.reason, 'MISSING_BASELINE_PRICE');
  assert.equal(noBaseline.label, 'UNKNOWN');
});

test('duplicate and out-of-order observations are deterministic and counted once per timestamp', () => {
  const label = assignLabel({
    observedAt: 0,
    horizonAt: 100,
    observations: [
      { at: 80, price: .6 },
      { at: 20, price: 2.5 },
      { at: 20, price: 2.5 },
      { at: 80, price: .6 }
    ],
    baselinePrice: 1,
    successThreshold: 2
  });
  assert.equal(label.status, 'LABELED');
  assert.equal(label.evidenceCount, 2);
  assert.equal(label.success, true);
  assert.equal(label.rug, false);
});

test('conflicting duplicate observations fail closed as unknown', () => {
  const label = assignLabel({
    observedAt: 0,
    horizonAt: 100,
    observations: [{ at: 50, price: .4 }, { at: 50, price: .9 }],
    baselinePrice: 1
  });
  assert.equal(label.status, 'UNKNOWN');
  assert.equal(label.reason, 'CONFLICTING_OBSERVATIONS');
  assert.equal(label.rug, null);
  assert.equal(label.success, null);
});

test('label migration preserves cutoff and upgrades legacy labels', () => {
  const migrated = migrateLabel({ observedAt: 10, horizonAt: 20, rug: false, success: true, cutoff: 20 });
  assert.equal(migrated.version, LABEL_VERSION);
  assert.equal(migrated.label, 'SUCCESS');
  assert.equal(migrated.cutoff, 20);
  assert.equal(migrated.migratedFrom, 'unversioned');
});
