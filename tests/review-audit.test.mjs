import test from 'node:test';
import assert from 'node:assert/strict';
import { partitionRows } from '../lib/data.ts';
import { calibrateOkRate, manualThreshold } from '../lib/threshold.ts';
import { buildReviewListing } from '../lib/sample-review.ts';
import {
  createReviewDecision,
  normalizeReviewReason,
  summarizeReviewComparison,
} from '../lib/review-audit.ts';

const category = {
  kind: 'category',
  column: 'label',
  a: 'normal',
  b: 'anomaly',
};
const records = [
  {
    id: 'high-ok',
    score: '0.4',
    label: 'normal',
    rating: '0',
    condition: 'quiet',
  },
  {
    id: 'ng-high',
    score: '0.8',
    label: 'anomaly',
    rating: '10',
    condition: 'quiet',
  },
  {
    id: 'low-ok',
    score: '0.1',
    label: 'normal',
    rating: '2',
    condition: 'quiet',
  },
  {
    id: 'ng-low',
    score: '0.35',
    label: 'anomaly',
    rating: '8',
    condition: 'quiet',
  },
];
const base = () => partitionRows(records, 'score', category).samples;
const scores = (samples, group) =>
  samples.filter((s) => s.group === group).map((s) => s.score);
const context = (overrides = {}) => ({
  scoreColumn: 'score',
  group: { ...category },
  filter: null,
  okGroup: 'A',
  scoreDirection: 'high',
  threshold: null,
  ...overrides,
});
const near = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-12);

void test('comparison summary preserves full cohort sizes, orientation and trapezoidal PR-AUC', () => {
  const summary = summarizeReviewComparison(base(), 'A', 'high');
  assert.equal(summary.nA, 2);
  assert.equal(summary.nB, 2);
  assert.equal(summary.total, 4);
  assert.equal(summary.positiveFraction, 0.5);
  assert.equal(summary.okGroup, 'A');
  assert.equal(summary.positiveGroup, 'B');
  assert.equal(summary.scoreDirection, 'high');
  near(summary.prAuc, 19 / 24);
  assert.equal(Object.isFrozen(summary), true);
});

void test('group B as reference and low-score detections do not swap cohort counts', () => {
  const samples = partitionRows(
    [
      { score: '1', label: 'normal' },
      { score: '2', label: 'normal' },
      { score: '8', label: 'anomaly' },
      { score: '7', label: 'anomaly' },
      { score: '9', label: 'anomaly' },
    ],
    'score',
    category,
  ).samples;
  const summary = summarizeReviewComparison(samples, 'B', 'low');
  assert.deepEqual(summary, {
    nA: 2,
    nB: 3,
    total: 5,
    prAuc: 1,
    positiveFraction: 2 / 5,
    okGroup: 'B',
    positiveGroup: 'A',
    scoreDirection: 'low',
  });
  const calibration = calibrateOkRate(scores(samples, 'B'), 100, 'low');
  const decision = createReviewDecision(
    samples,
    context({
      okGroup: 'B',
      scoreDirection: 'low',
      threshold: calibration,
    }),
  );
  assert.deepEqual(decision.before, summary);
  assert.deepEqual(decision.threshold.rule, {
    threshold: 9,
    operator: 'lte',
    direction: 'low',
  });
  assert.equal(decision.threshold.targetPercent, 100);
});

void test('non-finite scores and empty cohorts keep valid counts and unavailable AUC', () => {
  const samples = [
    { index: 0, row: {}, group: 'A', score: 1 },
    { index: 1, row: {}, group: 'A', score: NaN },
    { index: 2, row: {}, group: 'B', score: Infinity },
    { index: 3, row: {}, group: 'B', score: -Infinity },
  ];
  for (const okGroup of ['A', 'B']) {
    const summary = summarizeReviewComparison(samples, okGroup, 'high');
    assert.equal(summary.nA, 1);
    assert.equal(summary.nB, 0);
    assert.equal(summary.total, 1);
    assert.equal(summary.prAuc, null);
    assert.equal(summary.positiveFraction, okGroup === 'A' ? 0 : 1);
  }
  const empty = summarizeReviewComparison([], 'A', 'high');
  assert.equal(empty.total, 0);
  assert.equal(empty.prAuc, null);
  assert.equal(empty.positiveFraction, null);
});

void test('numeric boundaries, condition and the applied calibration are independent snapshot copies', () => {
  const group = { kind: 'numeric', column: 'rating', upperA: 2, lowerB: 8 };
  const filter = { column: 'condition', value: 'quiet' };
  const samples = partitionRows(
    [
      ...records,
      { score: '99', rating: '5', condition: 'quiet' },
      { score: '99', rating: '10', condition: 'noisy' },
    ],
    'score',
    group,
    filter,
  ).samples;
  const calibration = calibrateOkRate(scores(samples, 'A'), 50, 'high');
  const settings = context({ group, filter, threshold: calibration });
  const snapshot = createReviewDecision(samples, settings);
  const serialized = JSON.stringify(snapshot);
  assert.deepEqual(snapshot.group, group);
  assert.deepEqual(snapshot.filter, filter);
  assert.deepEqual(snapshot.threshold, calibration);
  assert.notEqual(snapshot.group, group);
  assert.notEqual(snapshot.filter, filter);
  assert.notEqual(snapshot.threshold, calibration);
  assert.notEqual(snapshot.threshold.rule, calibration.rule);
  assert.equal(snapshot.before.total, 4);
  near(snapshot.before.prAuc, 19 / 24);
  assert.equal(snapshot.threshold.rule.operator, 'gt');
  assert.equal(snapshot.threshold.targetPercent, 50);

  group.upperA = -100;
  group.lowerB = -10;
  filter.value = 'noisy';
  calibration.rule.threshold = 99;
  calibration.rule.operator = 'gte';
  calibration.targetPercent = 100;
  settings.scoreColumn = 'another-model';
  settings.okGroup = 'B';
  settings.scoreDirection = 'low';
  samples[0].score = 500;
  assert.equal(JSON.stringify(snapshot), serialized);
});

void test('every nested snapshot is immutable without freezing or mutating its source settings', () => {
  const samples = base();
  const settings = context({
    filter: { column: 'condition', value: 'quiet' },
    threshold: calibrateOkRate(scores(samples, 'A'), 0, 'high'),
  });
  const original = structuredClone({ samples, settings });
  const snapshot = createReviewDecision(samples, settings);
  for (const value of [
    snapshot,
    snapshot.group,
    snapshot.filter,
    snapshot.threshold,
    snapshot.threshold.rule,
    snapshot.before,
  ])
    assert.equal(Object.isFrozen(value), true);
  assert.throws(() => {
    snapshot.group.a = 'changed';
  }, TypeError);
  assert.throws(() => {
    snapshot.filter.value = 'changed';
  }, TypeError);
  assert.throws(() => {
    snapshot.threshold.rule.operator = 'gte';
  }, TypeError);
  assert.throws(() => {
    snapshot.threshold.targetPercent = 99;
  }, TypeError);
  assert.throws(() => {
    snapshot.before.prAuc = 1;
  }, TypeError);
  assert.deepEqual({ samples, settings }, original);
  assert.equal(Object.isFrozen(settings.group), false);
  assert.equal(Object.isFrozen(settings.threshold.rule), false);
});

void test('all four threshold operators and original numeric precision survive audit capture', () => {
  const samples = base();
  for (const [direction, target, operator] of [
    ['high', 0, 'gt'],
    ['high', 100, 'gte'],
    ['low', 0, 'lt'],
    ['low', 100, 'lte'],
  ]) {
    const calibration = calibrateOkRate(
      scores(samples, 'A'),
      target,
      direction,
    );
    const snapshot = createReviewDecision(
      samples,
      context({
        scoreDirection: direction,
        threshold: calibration,
      }),
    );
    assert.deepEqual(snapshot.threshold, calibration);
    assert.equal(snapshot.threshold.method, 'ok-rate');
    assert.equal(snapshot.threshold.rule.operator, operator);
    assert.equal(snapshot.threshold.rule.threshold, calibration.rule.threshold);
    assert.equal(snapshot.threshold.actualPercent, target);
  }
});

void test('unset threshold and absent condition remain null rather than becoming implicit defaults', () => {
  const snapshot = createReviewDecision(base(), context());
  assert.equal(snapshot.threshold, null);
  assert.equal(snapshot.filter, null);
  assert.deepEqual(snapshot.group, category);
  assert.equal(snapshot.scoreColumn, 'score');
});

void test('unexcluded baseline stays separate from retained metrics, grey rows and inspection filters', () => {
  const original = base();
  const ignored = new Set([0]);
  const active = partitionRows(
    records,
    'score',
    category,
    null,
    ignored,
  ).samples;
  const baseline = summarizeReviewComparison(original, 'A', 'high');
  const retained = summarizeReviewComparison(active, 'A', 'high');
  assert.equal(baseline.nA, 2);
  assert.equal(retained.nA, 1);
  near(baseline.prAuc, 19 / 24);
  assert.equal(retained.prAuc, 1);

  const calibration = calibrateOkRate(scores(active, 'A'), 0, 'high');
  const ref = { okGroup: 'A', rule: calibration.rule };
  const listing = buildReviewListing(original, ignored, 'false-positive', ref);
  assert.deepEqual(listing.included, []);
  assert.deepEqual(
    listing.listed.map((s) => s.index),
    [0],
  );
  const narrowed = buildReviewListing(
    original.slice(0, 2),
    ignored,
    'all',
    ref,
  );
  assert.equal(narrowed.counts.all, 1);
  const snapshot = createReviewDecision(
    active,
    context({ threshold: calibration }),
  );
  assert.deepEqual(snapshot.before, retained);
  assert.equal(snapshot.before.total, 3);
  assert.deepEqual(summarizeReviewComparison(original, 'A', 'high'), baseline);
  assert.deepEqual(summarizeReviewComparison(active, 'A', 'high'), retained);
});

void test('restore capture uses current settings and the population before restoration, preserving earlier decisions', () => {
  const original = base();
  const ignored = new Set([0]);
  const active = partitionRows(
    records,
    'score',
    category,
    null,
    ignored,
  ).samples;
  const beforeIgnore = createReviewDecision(
    original,
    context({
      threshold: calibrateOkRate(scores(original, 'A'), 0, 'high'),
    }),
  );
  const originalEvidence = JSON.stringify(beforeIgnore);
  const beforeRestore = createReviewDecision(
    active,
    context({
      okGroup: 'B',
      scoreDirection: 'low',
      threshold: null,
    }),
  );
  assert.equal(beforeIgnore.before.nA, 2);
  assert.equal(beforeIgnore.threshold.rule.threshold, 0.4);
  assert.equal(beforeRestore.before.nA, 1);
  assert.equal(beforeRestore.before.nB, 2);
  assert.equal(beforeRestore.before.positiveFraction, 1 / 3);
  assert.equal(beforeRestore.okGroup, 'B');
  assert.equal(beforeRestore.scoreDirection, 'low');
  assert.equal(beforeRestore.threshold, null);
  ignored.clear();
  const restored = partitionRows(
    records,
    'score',
    category,
    null,
    ignored,
  ).samples;
  assert.equal(summarizeReviewComparison(restored, 'B', 'low').nA, 2);
  assert.equal(beforeRestore.before.nA, 1);
  assert.equal(JSON.stringify(beforeIgnore), originalEvidence);
});

void test('restoration from an empty retained population records unavailable metrics without losing its baseline', () => {
  const original = base();
  const active = partitionRows(
    records,
    'score',
    category,
    null,
    new Set([0, 1, 2, 3]),
  ).samples;
  const snapshot = createReviewDecision(active, context());
  assert.equal(snapshot.before.nA, 0);
  assert.equal(snapshot.before.nB, 0);
  assert.equal(snapshot.before.prAuc, null);
  assert.equal(snapshot.before.positiveFraction, null);
  assert.equal(snapshot.threshold, null);
  assert.equal(summarizeReviewComparison(original, 'A', 'high').total, 4);
});

void test('empty review reasons remain explicitly unconfirmed while supplied evidence is preserved', () => {
  for (const reason of ['', ' ', '\n\t', '　']) {
    assert.equal(normalizeReviewReason(reason), '理由未記入（原因未確定）');
  }
  assert.equal(
    normalizeReviewReason('  再検査で確認・記録QC-17  '),
    '再検査で確認・記録QC-17',
  );
  assert.equal(
    normalizeReviewReason('ノイズ疑い\n未確認'),
    'ノイズ疑い\n未確認',
  );
});

void test('invalid group or score orientation cannot silently change audit interpretation', () => {
  assert.throws(
    () => summarizeReviewComparison(base(), 'C', 'high'),
    /基準OK群/,
  );
  assert.throws(() => summarizeReviewComparison([], 'A', 'sideways'), /方向/);
});

void test('audit distinguishes manual placement from rate calibration even at the identical boundary', () => {
  const samples = base();
  const rateCalibration = calibrateOkRate(scores(samples, 'A'), 50, 'high');
  const manualCalibration = manualThreshold(
    scores(samples, 'A'),
    rateCalibration.rule,
  );
  const rateDecision = createReviewDecision(
    samples,
    context({ threshold: rateCalibration }),
  );
  const manualDecision = createReviewDecision(
    samples,
    context({ threshold: manualCalibration }),
  );
  assert.deepEqual(rateDecision.threshold.rule, manualDecision.threshold.rule);
  assert.equal(
    rateDecision.threshold.actualPercent,
    manualDecision.threshold.actualPercent,
  );
  assert.equal(rateDecision.threshold.method, 'ok-rate');
  assert.equal(rateDecision.threshold.targetPercent, 50);
  assert.equal(manualDecision.threshold.method, 'manual');
  assert.equal(manualDecision.threshold.targetPercent, null);
  assert.deepEqual(rateDecision.before, manualDecision.before);
  const exported = JSON.parse(JSON.stringify(manualDecision));
  assert.equal(exported.threshold.method, 'manual');
  assert.ok(Object.hasOwn(exported.threshold, 'targetPercent'));
  assert.equal(exported.threshold.targetPercent, null);
  assert.deepEqual(exported.threshold.rule, manualCalibration.rule);
  manualCalibration.rule.threshold = 99;
  manualCalibration.method = 'ok-rate';
  manualCalibration.targetPercent = 99;
  assert.equal(manualDecision.threshold.rule.threshold, 0.1);
  assert.equal(manualDecision.threshold.method, 'manual');
  assert.equal(manualDecision.threshold.targetPercent, null);
});

void test('manual audit snapshots retain low-score direction, inclusive boundaries and exact values', () => {
  const samples = base();
  const boundary = 0.35000000000000003;
  const calibration = manualThreshold(scores(samples, 'B'), {
    threshold: boundary,
    operator: 'lte',
    direction: 'low',
  });
  const decision = createReviewDecision(
    samples,
    context({
      okGroup: 'B',
      scoreDirection: 'low',
      threshold: calibration,
    }),
  );
  assert.equal(decision.okGroup, 'B');
  assert.equal(decision.scoreDirection, 'low');
  assert.equal(decision.threshold.rule.direction, 'low');
  assert.equal(decision.threshold.rule.operator, 'lte');
  assert.equal(decision.threshold.rule.threshold, boundary);
  assert.equal(decision.threshold.referenceCount, 2);
  assert.equal(decision.threshold.detectedCount, 1);
  assert.equal(decision.threshold.actualPercent, 50);
  assert.equal(decision.threshold.targetPercent, null);
  assert.equal(decision.threshold.method, 'manual');
  assert.notEqual(decision.threshold.rule, calibration.rule);
  assert.ok(Object.isFrozen(decision.threshold));
  assert.ok(Object.isFrozen(decision.threshold.rule));
});
