import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calibrateOkRate,
  isDetected,
  manualThreshold,
  summarizeThreshold,
} from '../lib/threshold.ts';

test('high-score calibration selects the requested upper tail using a strict boundary', () => {
  const scores = [4, 1, 5, 2, 3];
  const before = [...scores];
  assert.deepEqual(calibrateOkRate(scores, 40, 'high'), {
    method: 'ok-rate',
    rule: { threshold: 3, operator: 'gt', direction: 'high' },
    targetPercent: 40,
    referenceCount: 5,
    detectedCount: 2,
    actualPercent: 40,
  });
  assert.deepEqual(scores, before, 'calibration must not reorder the input');
});

test('low-score calibration selects the lower tail without negating scores', () => {
  assert.deepEqual(calibrateOkRate([-1, -5, -2, -4, -3], 40, 'low'), {
    method: 'ok-rate',
    rule: { threshold: -3, operator: 'lt', direction: 'low' },
    targetPercent: 40,
    referenceCount: 5,
    detectedCount: 2,
    actualPercent: 40,
  });
});

test('zero percent produces zero reference detections in both directions', () => {
  const scores = [-7, 0, 8, 8];
  for (const direction of ['high', 'low']) {
    const c = calibrateOkRate(scores, 0, direction);
    assert.equal(c.detectedCount, 0);
    assert.equal(c.actualPercent, 0);
    assert.equal(c.rule.threshold, direction === 'high' ? 8 : -7);
    assert.equal(c.rule.operator, direction === 'high' ? 'gt' : 'lt');
  }
});

test('ties are kept together even when this leaves the observed rate below target', () => {
  const high = calibrateOkRate([10, 9, 9, 9, 1], 40, 'high');
  assert.deepEqual(high.rule, {
    threshold: 9,
    operator: 'gt',
    direction: 'high',
  });
  assert.equal(high.detectedCount, 1);
  assert.equal(high.actualPercent, 20);
  const low = calibrateOkRate([-10, -9, -9, -9, -1], 40, 'low');
  assert.deepEqual(low.rule, {
    threshold: -9,
    operator: 'lt',
    direction: 'low',
  });
  assert.equal(low.detectedCount, 1);
  assert.equal(low.actualPercent, 20);
});

test('an achievable rate at the end of a tie block is not unnecessarily reduced', () => {
  const high = calibrateOkRate([9, 9, 7, 4, 1], 40, 'high');
  assert.equal(high.rule.threshold, 7);
  assert.equal(high.detectedCount, 2);
  const low = calibrateOkRate([1, 1, 4, 7, 9], 40, 'low');
  assert.equal(low.rule.threshold, 4);
  assert.equal(low.detectedCount, 2);
});

test('constant reference scores can only attain zero or one hundred percent', () => {
  for (const direction of ['high', 'low']) {
    for (const target of [0, 25, 50, 99.99999999999999]) {
      const c = calibrateOkRate([2, 2, 2, 2], target, direction);
      assert.equal(c.detectedCount, 0);
    }
    assert.equal(
      calibrateOkRate([2, 2, 2, 2], 100, direction).detectedCount,
      4,
    );
  }
});

test('fractional sample allowances are rounded down, including very small samples', () => {
  const c = calibrateOkRate([0, 1, 2], 50, 'high');
  assert.equal(c.detectedCount, 1);
  assert.equal(c.actualPercent, 100 / 3);
  assert.equal(calibrateOkRate([0, 1, 2], 33.33, 'high').detectedCount, 0);
  assert.equal(calibrateOkRate([0, 1, 2], 33.34, 'high').detectedCount, 1);
  assert.equal(calibrateOkRate([6], 99, 'low').detectedCount, 0);
  assert.equal(calibrateOkRate([6], 100, 'low').detectedCount, 1);
});

test('decimal percentages at integer count boundaries do not lose a sample to floating point', () => {
  const c = calibrateOkRate(
    Array.from({ length: 10_000 }, (_, i) => i),
    0.57,
    'high',
  );
  assert.equal(c.detectedCount, 57);
  assert.equal(c.actualPercent, 0.57);
  assert.equal(c.rule.threshold, 9942);
});

test('a target just below an attainable rate is never rounded upward', () => {
  const scores = Array.from({ length: 100 }, (_, i) => i);
  const c = calibrateOkRate(scores, 0.9999999999999999, 'high');
  assert.equal(c.detectedCount, 0);
  assert.equal(
    calibrateOkRate(scores, 99.99999999999999, 'high').detectedCount,
    99,
  );
});

test('tiny percentages written in exponential notation remain a valid zero allowance', () => {
  for (const percent of [1e-7, Number.MIN_VALUE]) {
    const c = calibrateOkRate([0, 1, 2, 3], percent, 'high');
    assert.equal(c.detectedCount, 0);
    assert.equal(c.targetPercent, percent);
  }
});

test('one hundred percent uses inclusive finite boundaries, including extreme values', () => {
  const scores = [-Number.MAX_VALUE, -1, 0, 1, Number.MAX_VALUE];
  for (const direction of ['high', 'low']) {
    const c = calibrateOkRate(scores, 100, direction);
    assert.ok(Number.isFinite(c.rule.threshold));
    assert.equal(
      c.rule.threshold,
      direction === 'high' ? -Number.MAX_VALUE : Number.MAX_VALUE,
    );
    assert.equal(c.rule.operator, direction === 'high' ? 'gte' : 'lte');
    assert.equal(c.detectedCount, scores.length);
    assert.equal(c.actualPercent, 100);
  }
});

test('extreme, subnormal and signed-zero scores keep their numeric ordering and ties', () => {
  const scores = [
    -Number.MAX_VALUE,
    -1,
    -Number.MIN_VALUE,
    -0,
    0,
    Number.MIN_VALUE,
    1,
    Number.MAX_VALUE,
  ];
  const high = calibrateOkRate(scores, 25, 'high');
  const low = calibrateOkRate(scores, 25, 'low');
  assert.equal(high.rule.threshold, Number.MIN_VALUE);
  assert.equal(low.rule.threshold, -Number.MIN_VALUE);
  assert.equal(high.detectedCount, 2);
  assert.equal(low.detectedCount, 2);
  assert.equal(calibrateOkRate(scores, 50, 'high').detectedCount, 3);
  assert.equal(calibrateOkRate(scores, 50, 'low').detectedCount, 3);
});

test('threshold comparisons use original precision, not displayed rounding or epsilon', () => {
  const scores = [0.1, 0.10000000000000002, 0.10000000000000003];
  const c = calibrateOkRate(scores, 40, 'high');
  assert.equal(c.rule.threshold, scores[1]);
  assert.equal(isDetected(scores[0], c.rule), false);
  assert.equal(isDetected(scores[1], c.rule), false);
  assert.equal(isDetected(scores[2], c.rule), true);
  assert.equal(c.detectedCount, 1);
});

test('non-finite reference values are excluded instead of treated as OK or NG', () => {
  const c = calibrateOkRate([NaN, 1, Infinity, 2, -Infinity, 3], 50, 'high');
  assert.equal(c.referenceCount, 3);
  assert.equal(c.detectedCount, 1);
  assert.equal(c.actualPercent, 100 / 3);
  for (const score of [NaN, Infinity, -Infinity]) {
    assert.equal(isDetected(score, c.rule), false);
  }
  assert.deepEqual(summarizeThreshold([NaN, Infinity, -Infinity], c.rule), {
    total: 0,
    detected: 0,
    notDetected: 0,
    detectedPercent: null,
    notDetectedPercent: null,
  });
});

test('summaries keep valid denominators and distinguish non-detections from missing values', () => {
  const rule = { threshold: 3, operator: 'gt', direction: 'high' };
  assert.deepEqual(summarizeThreshold([1, 3, 4, NaN], rule), {
    total: 3,
    detected: 1,
    notDetected: 2,
    detectedPercent: 100 / 3,
    notDetectedPercent: 200 / 3,
  });
  assert.deepEqual(summarizeThreshold([], rule), {
    total: 0,
    detected: 0,
    notDetected: 0,
    detectedPercent: null,
    notDetectedPercent: null,
  });
});

test('all four comparison operators handle equality explicitly', () => {
  const cases = [
    ['gt', 'high', [false, false, true]],
    ['gte', 'high', [false, true, true]],
    ['lt', 'low', [true, false, false]],
    ['lte', 'low', [true, true, false]],
  ];
  for (const [operator, direction, expected] of cases) {
    const rule = { threshold: 0, operator, direction };
    assert.deepEqual(
      [-1, 0, 1].map((score) => isDetected(score, rule)),
      expected,
    );
  }
});

test('evaluation scores do not change the rule or its OK calibration result', () => {
  const c = calibrateOkRate([1, 2, 3, 4], 25, 'high');
  const before = structuredClone(c);
  assert.equal(summarizeThreshold([-100, 0, 3, 100, 1000], c.rule).detected, 2);
  assert.deepEqual(c, before);
  assert.equal(c.rule.threshold, 3);
  assert.equal(c.referenceCount, 4);
});

test('the chosen rate is maximal among all attainable cuts without exceeding the target', () => {
  const samples = [
    [-3, -3, 0, 2, 2, 2, 6],
    [4, 4, 4],
    [-5, 0, 5, 10],
  ];
  for (const scores of samples) {
    for (const direction of ['high', 'low']) {
      const cuts = [];
      for (const boundary of new Set(scores)) {
        cuts.push(
          scores.filter((s) =>
            direction === 'high' ? s > boundary : s < boundary,
          ).length,
        );
        cuts.push(
          scores.filter((s) =>
            direction === 'high' ? s >= boundary : s <= boundary,
          ).length,
        );
      }
      for (const target of [0, 1, 14.3, 25, 33.33, 50, 66.7, 90, 99.99, 100]) {
        const expected = Math.max(
          ...cuts.filter((n) => (n * 100) / scores.length <= target),
        );
        const c = calibrateOkRate(scores, target, direction);
        assert.equal(
          c.detectedCount,
          expected,
          JSON.stringify({ scores, direction, target }),
        );
        assert.ok(c.actualPercent <= target);
        assert.deepEqual(
          calibrateOkRate([...scores].reverse(), target, direction),
          c,
        );
      }
    }
  }
});

test('invalid rates, directions and empty finite references have clear errors', () => {
  for (const target of [-1, 101, NaN, Infinity, -Infinity, '5', null]) {
    assert.throws(() => calibrateOkRate([1, 2], target, 'high'), /0〜100%/);
  }
  for (const direction of ['', 'HIGH', 'unknown', null]) {
    assert.throws(() => calibrateOkRate([1, 2], 5, direction), /方向/);
  }
  for (const scores of [[], [NaN, Infinity, -Infinity]]) {
    assert.throws(
      () => calibrateOkRate(scores, 5, 'high'),
      /OKデータが1件以上/,
    );
    assert.throws(
      () =>
        manualThreshold(scores, {
          threshold: 0,
          operator: 'gt',
          direction: 'high',
        }),
      /OKデータが1件以上/,
    );
  }
});

test('invalid threshold rules cannot silently reverse the decision direction', () => {
  const invalid = [
    { threshold: Infinity, operator: 'gt', direction: 'high' },
    { threshold: NaN, operator: 'gt', direction: 'high' },
    { threshold: 0, operator: 'lt', direction: 'high' },
    { threshold: 0, operator: 'gt', direction: 'low' },
    { threshold: 0, operator: 'eq', direction: 'high' },
    { threshold: 0, operator: 'gt', direction: 'unknown' },
  ];
  for (const rule of invalid) {
    assert.throws(() => isDetected(1, rule), /しきい値|方向|演算子/);
    assert.throws(
      () => summarizeThreshold([1, 2], rule),
      /しきい値|方向|演算子/,
    );
    assert.throws(() => manualThreshold([1, 2], rule), /しきい値|方向|演算子/);
  }
});

test('manual thresholds retain arbitrary boundaries rather than fitting scores or snapping to bins', () => {
  const scores = [0, 0.3, 0.6, 0.9, 1];
  const rule = {
    threshold: 0.3141592653589793,
    operator: 'gt',
    direction: 'high',
  };
  const result = manualThreshold(scores, rule);
  assert.deepEqual(result, {
    method: 'manual',
    rule,
    targetPercent: null,
    referenceCount: 5,
    detectedCount: 3,
    actualPercent: 60,
  });
  assert.equal(result.rule.threshold, rule.threshold);
  assert.equal(scores.includes(result.rule.threshold), false);
  assert.notEqual(result.rule, rule);
  const otherReference = manualThreshold([-4, -3, -2], rule);
  assert.deepEqual(otherReference.rule, result.rule);
  assert.equal(otherReference.actualPercent, 0);
  assert.equal(otherReference.targetPercent, null);
});

test('manual thresholds preserve all four operators and keep boundary ties together', () => {
  const scores = [-1, 0, 0, 1];
  for (const [operator, direction, detectedCount] of [
    ['gt', 'high', 1],
    ['gte', 'high', 3],
    ['lt', 'low', 1],
    ['lte', 'low', 3],
  ]) {
    const rule = { threshold: 0, operator, direction };
    const result = manualThreshold(scores, rule);
    assert.deepEqual(result.rule, rule);
    assert.equal(result.referenceCount, 4);
    assert.equal(result.detectedCount, detectedCount);
    assert.equal(result.actualPercent, detectedCount * 25);
    assert.deepEqual(manualThreshold([...scores].reverse(), rule), result);
  }
});

test('manual boundaries can yield zero or one hundred percent with constant reference scores', () => {
  for (const [operator, direction, actualPercent] of [
    ['gt', 'high', 0],
    ['gte', 'high', 100],
    ['lt', 'low', 0],
    ['lte', 'low', 100],
  ]) {
    const result = manualThreshold([2, 2, 2], {
      threshold: 2,
      operator,
      direction,
    });
    assert.equal(result.actualPercent, actualPercent);
    assert.equal(result.detectedCount, actualPercent === 100 ? 3 : 0);
    assert.equal(result.rule.operator, operator);
    assert.equal(result.method, 'manual');
    assert.equal(result.targetPercent, null);
  }
});

test('manual boundaries may lie outside reference scores and remain finite at numeric extremes', () => {
  const reference = [-3, 7];
  for (const [threshold, operator, direction, actualPercent] of [
    [-Number.MAX_VALUE, 'gt', 'high', 100],
    [Number.MAX_VALUE, 'gt', 'high', 0],
    [-Number.MAX_VALUE, 'lt', 'low', 0],
    [Number.MAX_VALUE, 'lt', 'low', 100],
  ]) {
    const result = manualThreshold(reference, {
      threshold,
      operator,
      direction,
    });
    assert.equal(result.rule.threshold, threshold);
    assert.ok(Number.isFinite(result.rule.threshold));
    assert.equal(result.actualPercent, actualPercent);
  }
  const extreme = [-Number.MAX_VALUE, Number.MAX_VALUE];
  assert.equal(
    manualThreshold(extreme, {
      threshold: -Number.MAX_VALUE,
      operator: 'gte',
      direction: 'high',
    }).actualPercent,
    100,
  );
  assert.equal(
    manualThreshold(extreme, {
      threshold: Number.MAX_VALUE,
      operator: 'lte',
      direction: 'low',
    }).actualPercent,
    100,
  );
});

test('manual calibration excludes non-finite OK scores from counts and the denominator', () => {
  const result = manualThreshold([NaN, -Infinity, -1, 0, Infinity, 1], {
    threshold: 0,
    operator: 'gte',
    direction: 'high',
  });
  assert.equal(result.referenceCount, 3);
  assert.equal(result.detectedCount, 2);
  assert.equal(result.actualPercent, 200 / 3);
  assert.equal(result.targetPercent, null);
  assert.equal(
    manualThreshold([NaN, 4, Infinity], {
      threshold: 3,
      operator: 'gt',
      direction: 'high',
    }).actualPercent,
    100,
  );
});

test('manual thresholds preserve adjacent floating-point values and signed zero', () => {
  const boundary = 0.10000000000000002;
  const values = [0.1, boundary, 0.10000000000000003];
  const high = manualThreshold(values, {
    threshold: boundary,
    operator: 'gt',
    direction: 'high',
  });
  const low = manualThreshold(values, {
    threshold: boundary,
    operator: 'lte',
    direction: 'low',
  });
  assert.equal(high.rule.threshold, boundary);
  assert.equal(high.detectedCount, 1);
  assert.equal(low.rule.threshold, boundary);
  assert.equal(low.detectedCount, 2);
  const subnormal = manualThreshold(
    [-Number.MIN_VALUE, -0, 0, Number.MIN_VALUE],
    {
      threshold: -0,
      operator: 'gt',
      direction: 'high',
    },
  );
  assert.ok(Object.is(subnormal.rule.threshold, -0));
  assert.equal(subnormal.detectedCount, 1);
});

test('manual calibration does not mutate or retain a mutable alias to its input rule', () => {
  const scores = Object.freeze([3, 1, 2]);
  const rule = { threshold: 1.5, operator: 'gt', direction: 'high' };
  const before = structuredClone(rule);
  const result = manualThreshold(scores, rule);
  assert.deepEqual(rule, before);
  assert.deepEqual(scores, [3, 1, 2]);
  assert.notEqual(result.rule, rule);
  rule.threshold = 100;
  assert.equal(result.rule.threshold, 1.5);
  assert.equal(result.detectedCount, 2);
  result.rule.operator = 'gte';
  assert.equal(rule.operator, 'gt');
  const frozen = Object.freeze({
    threshold: 2,
    operator: 'lt',
    direction: 'low',
  });
  assert.equal(manualThreshold(scores, frozen).detectedCount, 1);
});

test('manual calibration rejects absent, non-numeric or infinite boundaries', () => {
  for (const rule of [
    null,
    undefined,
    {},
    { threshold: '1', operator: 'gt', direction: 'high' },
    { threshold: -Infinity, operator: 'lt', direction: 'low' },
  ]) {
    assert.throws(() => manualThreshold([1, 2], rule), /しきい値/);
  }
});
