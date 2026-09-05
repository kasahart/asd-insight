import test from 'node:test';
import assert from 'node:assert/strict';
import {
  histogram,
  histogramBarCenter,
  histogramRange,
} from '../lib/distribution.ts';
import {
  centralScoreExtent,
  outsideScoreExtent,
} from '../lib/distribution-viewport.ts';

const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
const total = (distribution, key) =>
  distribution.bins.reduce((sum, bin) => sum + bin[key], 0);

test('central display re-bins a long tail without changing the source histogram', () => {
  const a = Object.freeze([...Array.from({ length: 99 }, (_, i) => i), 1e6]);
  const b = Object.freeze([
    ...Array.from({ length: 99 }, (_, i) => i + 10),
    2e6,
  ]);
  const full = histogram(a, b, 24);
  assert.equal(full.bins[0].countA, 99);
  assert.equal(full.bins[0].countB, 99);
  const extent = centralScoreExtent(a, b);
  assert.deepEqual(extent, { min: 1, max: 108 });
  const zoomed = histogram(a, b, 24, extent);
  assert.ok(zoomed.bins.filter((bin) => bin.countA > 0).length > 20);
  assert.ok(zoomed.bins.filter((bin) => bin.countB > 0).length > 20);
  assert.equal(zoomed.nA, full.nA);
  assert.equal(zoomed.nB, full.nB);
  assert.equal(zoomed.medianA, full.medianA);
  assert.equal(zoomed.medianB, full.medianB);
  assert.deepEqual(histogram(a, b, 24), full);
  assert.deepEqual(outsideScoreExtent(a, b, extent), {
    belowA: 1,
    aboveA: 1,
    belowB: 0,
    aboveB: 1,
  });
});

test('visible percentages retain full finite group denominators and do not fold tails', () => {
  const a = [-100, -1, 0, 1, 2, 3, 100, NaN, Infinity];
  const b = [-2, -1, 0, 2, 4, NaN];
  const extent = { min: -1, max: 3 };
  const d = histogram(a, b, 4, extent);
  assert.deepEqual(
    d.bins.map((bin) => bin.countA),
    [1, 1, 1, 2],
  );
  assert.deepEqual(
    d.bins.map((bin) => bin.countB),
    [1, 1, 0, 1],
  );
  assert.equal(d.nA, 7);
  assert.equal(d.nB, 5);
  close(total(d, 'a'), 500 / 7);
  close(total(d, 'b'), 60);
  assert.deepEqual(outsideScoreExtent(a, b, extent), {
    belowA: 1,
    aboveA: 1,
    belowB: 1,
    aboveB: 1,
  });
  assert.equal(histogramBarCenter(d, -100, 'A'), null);
  assert.equal(histogramBarCenter(d, 100, 'A'), null);
});

test('both display boundaries remain visible and internal bin boundaries count once', () => {
  const extent = { min: -2, max: 2 };
  const a = [-3, -2, -1, 0, 1, 2, 3];
  const d = histogram(a, [], 4, extent);
  assert.deepEqual(
    d.bins.map((bin) => bin.countA),
    [1, 1, 1, 2],
  );
  assert.deepEqual(histogramRange(d.bins, -2, 2), {
    lo: -2,
    hi: 2,
    includeHi: true,
  });
  assert.notEqual(histogramBarCenter(d, -2, 'A'), null);
  assert.notEqual(histogramBarCenter(d, 2, 'A'), null);
  assert.equal(d.overlap, null);
});

test('a manually chosen empty display retains counts and full-population medians', () => {
  const d = histogram([-100, -50, 0, 1, 100], [9, 10], 12, {
    min: 50,
    max: 60,
  });
  assert.equal(total(d, 'countA'), 0);
  assert.equal(total(d, 'countB'), 0);
  assert.equal(d.nA, 5);
  assert.equal(d.nB, 2);
  assert.equal(d.medianA, 0);
  assert.equal(d.medianB, 9.5);
  assert.equal(d.min, 50);
  assert.equal(d.max, 60);
});

test('a small distant group is retained even when a pooled percentile would hide it', () => {
  const a = Array.from({ length: 1000 }, (_, i) => i);
  const b = Object.freeze([1e6, 1e6 + 1]);
  const extent = centralScoreExtent(a, b);
  assert.deepEqual(extent, { min: 10, max: 1e6 + 1 });
  const outside = outsideScoreExtent(a, b, extent);
  assert.equal(outside.belowB + outside.aboveB, 0);
  assert.equal(total(histogram(a, b, 24, extent), 'countB'), b.length);
  assert.deepEqual(centralScoreExtent(b, a), extent);
});

test('observed rank boundaries remove a distant one-percent tail without interpolation', () => {
  const a = [...Array(99).fill(0), 1e300];
  const b = [...Array(99).fill(1), 1e300];
  const extent = centralScoreExtent(a, b);
  assert.deepEqual(extent, { min: 0, max: 1 });
  assert.deepEqual(outsideScoreExtent(a, b, extent), {
    belowA: 0,
    aboveA: 1,
    belowB: 0,
    aboveB: 1,
  });
  const d = histogram(a, b, 24, extent);
  close(total(d, 'a'), 99);
  close(total(d, 'b'), 99);
});

test('ties at central bounds stay together rather than trimming individual equal scores', () => {
  const a = [...Array(50).fill(-1), ...Array(49).fill(1), 1000];
  const extent = centralScoreExtent(a, []);
  assert.deepEqual(extent, { min: -1, max: 1 });
  const outside = outsideScoreExtent(a, [], extent);
  assert.equal(outside.belowA, 0);
  assert.equal(outside.aboveA, 1);
  assert.equal(total(histogram(a, [], 24, extent), 'countA'), 99);
});

test('small cohorts, empty inputs, and tied central values do not invent a zoom range', () => {
  for (const [a, b] of [
    [[], []],
    [[NaN, Infinity], [-Infinity]],
    [[0], [10]],
    [Array.from({ length: 99 }, (_, i) => i), []],
    [Array(100).fill(4), Array(100).fill(4)],
    [[...Array(99).fill(4), 1e6], []],
    [Array(100).fill(0), Array(100).fill(1)],
  ])
    assert.equal(centralScoreExtent(a, b), null);
});

test('the small-sample guard uses finite observations, not missing rows', () => {
  const a = [
    ...Array.from({ length: 99 }, (_, i) => i),
    ...Array(100).fill(NaN),
  ];
  assert.equal(centralScoreExtent(a, []), null);
  a.push(Infinity, -Infinity);
  assert.equal(centralScoreExtent(a, []), null);
});

test('negative and zero scores use an ordinary shared axis without logarithmic shifting', () => {
  const a = Array.from({ length: 101 }, (_, i) => i - 50);
  const b = [0];
  const extent = centralScoreExtent(a, b);
  assert.deepEqual(extent, { min: -49, max: 49 });
  assert.deepEqual(outsideScoreExtent(a, b, extent), {
    belowA: 1,
    aboveA: 1,
    belowB: 0,
    aboveB: 0,
  });
  assert.equal(total(histogram(a, b, 24, extent), 'countB'), 1);
});

test('invalid and unrepresentable explicit domains fail instead of producing plausible bins', () => {
  for (const extent of [
    { min: NaN, max: 1 },
    { min: 0, max: Infinity },
    { min: 1, max: 0 },
    { min: 1, max: 1 },
    { min: -1e308, max: 1e308 },
    { min: 0, max: Number.MIN_VALUE },
    { min: 1, max: 1 + Number.EPSILON },
  ])
    assert.throws(() => histogram([0, 1], [], 24, extent), /範囲|差/);
  assert.throws(() => outsideScoreExtent([1], [], { min: 1, max: 1 }), /範囲/);
  assert.throws(
    () => outsideScoreExtent([1], [], { min: -1e308, max: 1e308 }),
    /範囲/,
  );
});

test('automatic extents reject overflowing spans and numerically collapsed central bins', () => {
  assert.equal(
    centralScoreExtent(Array(100).fill(-1e308), Array(100).fill(1e308)),
    null,
  );
  const adjacent = 1 + Number.EPSILON;
  assert.equal(
    centralScoreExtent(
      [...Array(49).fill(1), ...Array(50).fill(adjacent), 1e6],
      [],
    ),
    null,
  );
  assert.equal(
    centralScoreExtent(
      [...Array(49).fill(0), ...Array(50).fill(Number.MIN_VALUE), 1],
      [],
    ),
    null,
  );
});

test('visible counts plus both tails conserve each finite cohort across bin counts', () => {
  const a = [-1e100, -2, -1, -0, 0.2, 0.2, 0.75, 1, 2, 1e100, NaN];
  const b = [Infinity, -Infinity, -1, -0.75, -0.5, 0, 0.5, 1];
  const extent = { min: -1, max: 1 };
  const outside = outsideScoreExtent(a, b, extent);
  for (const count of [2, 12, 24, 48, 96, 128]) {
    const d = histogram(a, b, count, extent);
    assert.equal(total(d, 'countA') + outside.belowA + outside.aboveA, d.nA);
    assert.equal(total(d, 'countB') + outside.belowB + outside.aboveB, d.nB);
    close(
      total(d, 'a') + (100 * (outside.belowA + outside.aboveA)) / d.nA,
      100,
    );
    close(
      total(d, 'b') + (100 * (outside.belowB + outside.aboveB)) / d.nB,
      100,
    );
    assert.equal(d.bins.at(-1).hi, 1);
  }
});

test('omitting the display domain preserves full-range and constant-data behavior', () => {
  assert.deepEqual(
    histogram([0, 1, 2], [1], 12),
    histogram([0, 1, 2], [1], 12, undefined),
  );
  const d = histogram([4, 4], [4], 24);
  assert.ok(d.min < 4 && d.max > 4);
  assert.equal(d.overlap, 100);
  assert.equal(total(d, 'countA'), 2);
  assert.equal(total(d, 'countB'), 1);
});
