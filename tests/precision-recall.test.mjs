import test from 'node:test';
import assert from 'node:assert/strict';
import { precisionRecall } from '../lib/precision-recall.ts';

const close = (actual, expected) => {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
};

test('perfect separation has area one and retains the full threshold curve', () => {
  const result = precisionRecall([3, 4], [1, 2], 'high');
  assert.equal(result.auc, 1);
  assert.equal(result.positiveCount, 2);
  assert.equal(result.negativeCount, 2);
  assert.equal(result.positiveFraction, 0.5);
  assert.equal(result.distinctScores, 4);
  assert.deepEqual(result.points, [
    { recall: 0, precision: 1, threshold: null, tp: 0, fp: 0 },
    { recall: 0.5, precision: 1, threshold: 4, tp: 1, fp: 0 },
    { recall: 1, precision: 1, threshold: 3, tp: 2, fp: 0 },
    { recall: 1, precision: 2 / 3, threshold: 2, tp: 2, fp: 1 },
    { recall: 1, precision: 0.5, threshold: 1, tp: 2, fp: 2 },
  ]);
});

test('reverse ranking retains zero-recall points and integrates their real precision', () => {
  const result = precisionRecall([1, 2], [3, 4], 'high');
  close(result.auc, 7 / 24);
  assert.deepEqual(result.points, [
    { recall: 0, precision: 1, threshold: null, tp: 0, fp: 0 },
    { recall: 0, precision: 0, threshold: 4, tp: 0, fp: 1 },
    { recall: 0, precision: 0, threshold: 3, tp: 0, fp: 2 },
    { recall: 0.5, precision: 1 / 3, threshold: 2, tp: 1, fp: 2 },
    { recall: 1, precision: 0.5, threshold: 1, tp: 2, fp: 2 },
  ]);
});

test('trapezoidal PR-AUC differs from average precision on a mixed ranking', () => {
  const result = precisionRecall([0.8, 0.35], [0.4, 0.1], 'high');
  close(result.auc, 19 / 24);
  const averagePrecision = (1 + 2 / 3) / 2;
  close(averagePrecision, 5 / 6);
  assert.ok(Math.abs(result.auc - averagePrecision) > 0.04);
  assert.deepEqual(result.points, [
    { recall: 0, precision: 1, threshold: null, tp: 0, fp: 0 },
    { recall: 0.5, precision: 1, threshold: 0.8, tp: 1, fp: 0 },
    { recall: 0.5, precision: 0.5, threshold: 0.4, tp: 1, fp: 1 },
    { recall: 1, precision: 2 / 3, threshold: 0.35, tp: 2, fp: 1 },
    { recall: 1, precision: 0.5, threshold: 0.1, tp: 2, fp: 2 },
  ]);
});

test('ties across and within groups are added together without artificial ranking', () => {
  const result = precisionRecall([1, 1, 0], [1, 0, 0], 'high');
  assert.equal(result.distinctScores, 2);
  assert.deepEqual(result.points, [
    { recall: 0, precision: 1, threshold: null, tp: 0, fp: 0 },
    { recall: 2 / 3, precision: 2 / 3, threshold: 1, tp: 2, fp: 1 },
    { recall: 1, precision: 0.5, threshold: 0, tp: 3, fp: 3 },
  ]);
  close(result.auc, 0.75);
});

test('a balanced constant score has trapezoidal area 0.75, not AP 0.5', () => {
  for (const direction of ['high', 'low']) {
    const result = precisionRecall([7, 7], [7, 7], direction);
    assert.equal(result.auc, 0.75);
    assert.equal(result.distinctScores, 1);
    assert.deepEqual(result.points, [
      { recall: 0, precision: 1, threshold: null, tp: 0, fp: 0 },
      { recall: 1, precision: 0.5, threshold: 7, tp: 2, fp: 2 },
    ]);
  }
});

test('precision uses actual class counts rather than normalizing each group to equal size', () => {
  const result = precisionRecall([7], [7, 7, 7], 'high');
  assert.equal(result.positiveFraction, 0.25);
  assert.equal(result.points.at(-1).precision, 0.25);
  assert.equal(result.auc, 0.625);
});

test('input order does not alter the curve or area when scores contain ties', () => {
  const positive = [2, 2, -1, 0.2];
  const negative = [2, -1, 0.2, 9];
  for (const direction of ['high', 'low']) {
    const result = precisionRecall(positive, negative, direction);
    assert.deepEqual(
      precisionRecall([...positive].reverse(), [9, 0.2, 2, -1], direction),
      result,
    );
  }
});

test('low-score direction uses inclusive ascending thresholds', () => {
  const result = precisionRecall([-4, -3], [-2, -1], 'low');
  assert.equal(result.auc, 1);
  assert.deepEqual(
    result.points.map((p) => p.threshold),
    [null, -4, -3, -2, -1],
  );
  assert.deepEqual(
    result.points.map((p) => [p.tp, p.fp]),
    [
      [0, 0],
      [1, 0],
      [2, 0],
      [2, 1],
      [2, 2],
    ],
  );
  close(precisionRecall([-0.8, -0.35], [-0.4, -0.1], 'low').auc, 19 / 24);
});

test('every reported finite threshold includes all and only its qualifying scores', () => {
  const positive = [-2, -2, 0, 0.1, 3];
  const negative = [-3, -2, 0, 2, 3, 3];
  for (const direction of ['high', 'low']) {
    const result = precisionRecall(positive, negative, direction);
    for (const point of result.points.slice(1)) {
      const included = (score) =>
        direction === 'high'
          ? score >= point.threshold
          : score <= point.threshold;
      assert.equal(point.tp, positive.filter(included).length);
      assert.equal(point.fp, negative.filter(included).length);
      assert.equal(point.recall, point.tp / positive.length);
      assert.equal(point.precision, point.tp / (point.tp + point.fp));
    }
  }
});

test('empty groups produce no curve while preserving available counts and fraction', () => {
  assert.deepEqual(precisionRecall([], [], 'high'), {
    auc: null,
    positiveCount: 0,
    negativeCount: 0,
    positiveFraction: null,
    distinctScores: 0,
    points: [],
  });
  assert.deepEqual(precisionRecall([], [1, 1, 2], 'high'), {
    auc: null,
    positiveCount: 0,
    negativeCount: 3,
    positiveFraction: 0,
    distinctScores: 2,
    points: [],
  });
  assert.deepEqual(precisionRecall([1, 1, 2], [], 'low'), {
    auc: null,
    positiveCount: 3,
    negativeCount: 0,
    positiveFraction: 1,
    distinctScores: 2,
    points: [],
  });
});

test('non-finite scores are excluded from counts, thresholds and class fraction', () => {
  const result = precisionRecall(
    [NaN, Infinity, 3, 4],
    [-Infinity, 1, NaN],
    'high',
  );
  assert.deepEqual(result, precisionRecall([3, 4], [1], 'high'));
  assert.equal(result.positiveFraction, 2 / 3);
  assert.deepEqual(precisionRecall([NaN, Infinity], [1], 'low'), {
    auc: null,
    positiveCount: 0,
    negativeCount: 1,
    positiveFraction: 0,
    distinctScores: 1,
    points: [],
  });
  assert.deepEqual(
    precisionRecall([NaN], [-Infinity], 'high'),
    precisionRecall([], [], 'high'),
  );
});

test('input arrays are never sorted or modified in place', () => {
  const positive = Object.freeze([3, 1, 3]);
  const negative = Object.freeze([0, 2, -1]);
  precisionRecall(positive, negative, 'high');
  precisionRecall(positive, negative, 'low');
  assert.deepEqual(positive, [3, 1, 3]);
  assert.deepEqual(negative, [0, 2, -1]);
});

test('extreme finite scores and subnormal values keep their original ordering', () => {
  const high = precisionRecall(
    [Number.MAX_VALUE, Number.MIN_VALUE],
    [-Number.MAX_VALUE, 0],
    'high',
  );
  assert.equal(high.auc, 1);
  assert.deepEqual(
    high.points.map((p) => p.threshold),
    [null, Number.MAX_VALUE, Number.MIN_VALUE, 0, -Number.MAX_VALUE],
  );
  const low = precisionRecall(
    [-Number.MAX_VALUE, -Number.MIN_VALUE],
    [Number.MAX_VALUE, 0],
    'low',
  );
  assert.equal(low.auc, 1);
  assert.deepEqual(
    low.points.map((p) => p.threshold),
    [null, -Number.MAX_VALUE, -Number.MIN_VALUE, 0, Number.MAX_VALUE],
  );
});

test('nearby scores are not rounded into a tie', () => {
  const result = precisionRecall([0.10000000000000002], [0.1], 'high');
  assert.equal(result.distinctScores, 2);
  assert.equal(result.auc, 1);
  assert.equal(result.points[1].threshold, 0.10000000000000002);
  assert.equal(result.points[2].threshold, 0.1);
});

test('positive and negative zero form one deterministic tie', () => {
  const result = precisionRecall([-0], [0], 'high');
  assert.equal(result.distinctScores, 1);
  assert.equal(result.auc, 0.75);
  assert.deepEqual(result, precisionRecall([0], [-0], 'high'));
});

test('uniform replication leaves precision, recall and area unchanged', () => {
  const positive = [0.8, 0.35];
  const negative = [0.4, 0.1];
  const original = precisionRecall(positive, negative, 'high');
  const doubled = precisionRecall(
    [...positive, ...positive],
    [...negative, ...negative],
    'high',
  );
  assert.equal(doubled.auc, original.auc);
  assert.equal(doubled.positiveFraction, original.positiveFraction);
  assert.equal(doubled.distinctScores, original.distinctScores);
  assert.deepEqual(
    doubled.points,
    original.points.map((p) => ({ ...p, tp: p.tp * 2, fp: p.fp * 2 })),
  );
});

test('curve probabilities and area stay bounded with nondecreasing recall', () => {
  for (const direction of ['high', 'low']) {
    const result = precisionRecall(
      [-9, 0, 0, 2, 4, 20],
      [-10, 0, 1, 3, 4, 7, 21],
      direction,
    );
    assert.ok(result.auc >= 0 && result.auc <= 1);
    assert.equal(result.points.length, result.distinctScores + 1);
    for (let i = 0; i < result.points.length; i++) {
      const point = result.points[i];
      assert.ok(point.recall >= 0 && point.recall <= 1);
      assert.ok(point.precision >= 0 && point.precision <= 1);
      if (i) assert.ok(point.recall >= result.points[i - 1].recall);
    }
    const final = result.points.at(-1);
    assert.equal(final.recall, 1);
    assert.equal(final.precision, result.positiveFraction);
    assert.equal(final.tp, result.positiveCount);
    assert.equal(final.fp, result.negativeCount);
  }
});

test('invalid direction is rejected even when both groups are empty', () => {
  for (const direction of ['', 'HIGH', 'descending', null, undefined, 1]) {
    assert.throws(() => precisionRecall([1], [0], direction), /スコア方向/);
    assert.throws(() => precisionRecall([], [], direction), /スコア方向/);
  }
});
