import test from 'node:test';
import assert from 'node:assert/strict';
import { partitionRows } from '../lib/data.ts';
import {
  buildReviewListing,
  candidateScope,
  filterReviewSamples,
  reviewCounts,
} from '../lib/sample-review.ts';
import { precisionRecall } from '../lib/precision-recall.ts';
import { calibrateOkRate, summarizeThreshold } from '../lib/threshold.ts';

function sample(index, score, group) {
  return {
    index,
    score,
    group,
    row: { sample_id: `sample-${index}`, score: String(score) },
  };
}
const ids = (samples) => samples.map((s) => s.index);
const reference = (operator, direction = 'high', okGroup = 'A') => ({
  okGroup,
  rule: { threshold: 0, operator, direction },
});
const labeled = [
  sample(0, -1, 'A'),
  sample(1, 0, 'A'),
  sample(2, 1, 'A'),
  sample(3, -1, 'B'),
  sample(4, 0, 'B'),
  sample(5, 1, 'B'),
];

test('candidate scope distinguishes a range-only, search-only, and combined empty result', () => {
  const ref = reference('gt');
  const yes = () => true;
  const no = () => false;
  for (const [range, search, expected] of [
    [no, yes, { total: 1, inRange: 0, current: 0, recovery: 'range' }],
    [yes, no, { total: 1, inRange: 1, current: 0, recovery: 'search' }],
    [no, no, { total: 1, inRange: 0, current: 0, recovery: 'both' }],
    [yes, yes, { total: 1, inRange: 1, current: 1, recovery: null }],
  ])
    assert.deepEqual(
      candidateScope(labeled, 'false-positive', ref, range, search),
      expected,
    );
});

test('recovery clears only the constraint needed to reveal candidates, even with two active filters', () => {
  const scope = candidateScope(
    labeled,
    'false-negative',
    reference('gt'),
    (s) => s.index === 3,
    (s) => s.index === 4,
  );
  assert.deepEqual(scope, {
    total: 2,
    inRange: 1,
    current: 0,
    recovery: 'range',
  });
  // Keeping the ID search while clearing range really reveals the promised row.
  assert.deepEqual(
    ids(
      filterReviewSamples(labeled, 'false-negative', reference('gt')).filter(
        (s) => s.index === 4,
      ),
    ),
    [4],
  );
});

test('whole-comparison zero is not mistaken for a hidden candidate; missing and ignored scores stay out', () => {
  const retained = labeled
    .filter((s) => s.index !== 2)
    .concat(sample(6, NaN, 'A'));
  assert.deepEqual(
    candidateScope(
      retained,
      'false-positive',
      reference('gt'),
      () => false,
      () => false,
    ),
    { total: 0, inRange: 0, current: 0, recovery: null },
  );
  assert.equal(
    candidateScope(
      labeled,
      'all',
      reference('gt'),
      () => true,
      () => true,
    ),
    null,
  );
  assert.equal(
    candidateScope(
      labeled,
      'false-positive',
      null,
      () => true,
      () => true,
    ),
    null,
  );
});

test('scope uses the selected OK group and low-score direction at the boundary', () => {
  assert.deepEqual(
    candidateScope(
      labeled,
      'false-positive',
      reference('lte', 'low', 'B'),
      (s) => s.score === 0,
      () => true,
    ),
    { total: 2, inRange: 1, current: 1, recovery: null },
  );
});

test('all four operators give the correct FP/FN candidates at equality', () => {
  const cases = [
    ['gt', 'high', [2], [3, 4]],
    ['gte', 'high', [1, 2], [3]],
    ['lt', 'low', [0], [4, 5]],
    ['lte', 'low', [0, 1], [5]],
  ];
  for (const [operator, direction, fp, fn] of cases) {
    const ref = reference(operator, direction);
    assert.deepEqual(
      ids(filterReviewSamples(labeled, 'false-positive', ref)),
      fp,
    );
    assert.deepEqual(
      ids(filterReviewSamples(labeled, 'false-negative', ref)),
      fn,
    );
    assert.deepEqual(reviewCounts(labeled, ref), {
      all: 6,
      falsePositive: fp.length,
      falseNegative: fn.length,
    });
  }
});

test('reference OK can be group B for either score direction', () => {
  const high = reference('gt', 'high', 'B');
  assert.deepEqual(
    ids(filterReviewSamples(labeled, 'false-positive', high)),
    [5],
  );
  assert.deepEqual(
    ids(filterReviewSamples(labeled, 'false-negative', high)),
    [0, 1],
  );
  assert.deepEqual(reviewCounts(labeled, high), {
    all: 6,
    falsePositive: 1,
    falseNegative: 2,
  });
  const low = reference('lte', 'low', 'B');
  assert.deepEqual(
    ids(filterReviewSamples(labeled, 'false-positive', low)),
    [3, 4],
  );
  assert.deepEqual(
    ids(filterReviewSamples(labeled, 'false-negative', low)),
    [2],
  );
});

test('boundary ties remain together and do not depend on row order', () => {
  const tied = [
    sample(7, 0, 'B'),
    sample(3, 0, 'A'),
    sample(8, 0, 'B'),
    sample(4, 0, 'A'),
  ];
  for (const [operator, direction, fp, fn] of [
    ['gt', 'high', 0, 2],
    ['gte', 'high', 2, 0],
    ['lt', 'low', 0, 2],
    ['lte', 'low', 2, 0],
  ]) {
    const ref = reference(operator, direction);
    assert.deepEqual(reviewCounts(tied, ref), {
      all: 4,
      falsePositive: fp,
      falseNegative: fn,
    });
    assert.deepEqual(
      reviewCounts([...tied].reverse(), ref),
      reviewCounts(tied, ref),
    );
  }
  assert.deepEqual(
    ids(filterReviewSamples(tied, 'false-positive', reference('gte'))),
    [3, 4],
  );
});

test('an unavailable threshold leaves all rows accessible but candidates and counts unavailable', () => {
  const all = filterReviewSamples(labeled, 'all', null);
  assert.deepEqual(all, labeled);
  assert.notEqual(all, labeled);
  assert.deepEqual(filterReviewSamples(labeled, 'false-positive', null), []);
  assert.deepEqual(filterReviewSamples(labeled, 'false-negative', null), []);
  assert.deepEqual(reviewCounts(labeled, null), {
    all: 6,
    falsePositive: null,
    falseNegative: null,
  });
});

test('non-finite scores are never FP or FN candidates, including non-detected NaNs', () => {
  const samples = [
    sample(0, 1, 'A'),
    sample(1, -1, 'B'),
    sample(2, NaN, 'A'),
    sample(3, NaN, 'B'),
    sample(4, Infinity, 'A'),
    sample(5, -Infinity, 'B'),
  ];
  const ref = reference('gt');
  assert.deepEqual(
    ids(filterReviewSamples(samples, 'false-positive', ref)),
    [0],
  );
  assert.deepEqual(
    ids(filterReviewSamples(samples, 'false-negative', ref)),
    [1],
  );
  assert.equal(filterReviewSamples(samples, 'all', ref).length, 6);
  assert.deepEqual(reviewCounts(samples, ref), {
    all: 6,
    falsePositive: 1,
    falseNegative: 1,
  });
});

test('empty candidate lists are zero with a rule, distinct from unavailable without one', () => {
  assert.deepEqual(reviewCounts([], reference('gt')), {
    all: 0,
    falsePositive: 0,
    falseNegative: 0,
  });
  assert.deepEqual(reviewCounts([], null), {
    all: 0,
    falsePositive: null,
    falseNegative: null,
  });
  assert.deepEqual(
    filterReviewSamples([], 'false-negative', reference('gt')),
    [],
  );
});

test('filtering preserves original order and object identities without mutating inputs', () => {
  const samples = Object.freeze([
    Object.freeze({
      ...sample(9, 2, 'A'),
      row: Object.freeze({ label: 'keep' }),
    }),
    Object.freeze(sample(5, -1, 'B')),
    Object.freeze(sample(3, 1, 'A')),
  ]);
  const ref = Object.freeze({
    okGroup: 'A',
    rule: Object.freeze({ threshold: 0, operator: 'gt', direction: 'high' }),
  });
  const before = structuredClone(samples);
  const selected = filterReviewSamples(samples, 'false-positive', ref);
  assert.deepEqual(ids(selected), [9, 3]);
  assert.equal(selected[0], samples[0]);
  assert.equal(selected[1], samples[2]);
  reviewCounts(samples, ref);
  assert.deepEqual(samples, before);
});

test('invalid filters and reference groups cannot silently select a different interpretation', () => {
  for (const filter of ['', 'fp', 'unknown', null]) {
    assert.throws(
      () => filterReviewSamples(labeled, filter, reference('gt')),
      /フィルタ/,
    );
    assert.throws(() => filterReviewSamples(labeled, filter, null), /フィルタ/);
  }
  const bad = reference('gt', 'high', 'unknown');
  assert.throws(
    () => filterReviewSamples(labeled, 'false-positive', bad),
    /基準OK群/,
  );
  assert.throws(() => reviewCounts(labeled, bad), /基準OK群/);
});

const rows = [
  { id: 'a0', score: '1', label: 'normal', condition: 'keep' },
  { id: 'missing-a', score: '', label: 'normal', condition: 'keep' },
  { id: 'b0', score: '4', label: 'anomaly', condition: 'keep' },
  { id: 'missing-b', score: 'NA', label: 'anomaly', condition: 'keep' },
  { id: 'missing-group', score: '2', label: '', condition: 'keep' },
  { id: 'other-group', score: '3', label: 'unknown', condition: 'keep' },
  { id: 'outside-filter', score: '5', label: 'normal', condition: 'other' },
  { id: 'a1', score: '2', label: 'normal', condition: 'keep' },
  { id: 'b1', score: '0', label: 'anomaly', condition: 'keep' },
];
const group = { kind: 'category', column: 'label', a: 'normal', b: 'anomaly' };
const filter = { column: 'condition', value: 'keep' };
const partition = (ignored) =>
  partitionRows(rows, 'score', group, filter, ignored);
const accountedRows = (p) =>
  p.samples.length +
  p.outsideFilter +
  p.missingGroup +
  p.otherGroup +
  p.missingA +
  p.missingB +
  p.ignoredRows;

test('omitting ignored rows preserves prior partitioning and reports zero manual exclusions', () => {
  const result = partitionRows(rows, 'score', group, filter);
  assert.deepEqual(ids(result.samples), [0, 2, 7, 8]);
  assert.equal(result.ignoredRows, 0);
  assert.equal(result.outsideFilter, 1);
  assert.equal(result.missingGroup, 1);
  assert.equal(result.otherGroup, 1);
  assert.equal(result.missingA, 1);
  assert.equal(result.missingB, 1);
  assert.equal(result.membersA, 3);
  assert.equal(result.membersB, 3);
  assert.equal(accountedRows(result), rows.length);
  assert.deepEqual(partition(new Set()), result);
});

test('manual exclusions precede filters and group checks while preserving source indices and rows', () => {
  const ignored = new Set([0, 3, 4, 6, -1, 5000]);
  const originalIgnored = [...ignored];
  const result = partition(ignored);
  assert.equal(
    result.ignoredRows,
    4,
    'count actual skipped rows, not ignored.size',
  );
  assert.deepEqual(ids(result.samples), [2, 7, 8]);
  for (const s of result.samples) assert.equal(s.row, rows[s.index]);
  assert.equal(
    result.outsideFilter,
    0,
    'an excluded row outside the filter is counted only as ignored',
  );
  assert.equal(result.missingGroup, 0);
  assert.equal(result.missingB, 0);
  assert.equal(result.missingA, 1);
  assert.equal(result.otherGroup, 1);
  assert.equal(result.membersA, 2);
  assert.equal(result.membersB, 2);
  assert.equal(accountedRows(result), rows.length);
  assert.deepEqual([...ignored], originalIgnored);
});

test('excluding missing scores removes them from group membership and missingness denominators', () => {
  const result = partition(new Set([1, 3]));
  assert.deepEqual(ids(result.samples), [0, 2, 7, 8]);
  assert.equal(result.missingA, 0);
  assert.equal(result.missingB, 0);
  assert.equal(result.membersA, 2);
  assert.equal(result.membersB, 2);
  assert.equal(result.ignoredRows, 2);
  assert.equal(accountedRows(result), rows.length);
});

test('restoring exclusions recovers the full original partition without relabeling records', () => {
  const before = structuredClone(rows);
  const original = partition();
  const ignored = new Set([0, 2, 7]);
  assert.deepEqual(ids(partition(ignored).samples), [8]);
  ignored.delete(2);
  assert.deepEqual(ids(partition(ignored).samples), [2, 8]);
  ignored.clear();
  const restored = partition(ignored);
  assert.deepEqual(restored, original);
  assert.deepEqual(rows, before);
  for (const s of restored.samples) assert.equal(s.row, rows[s.index]);
});

test('out-of-range, non-integer and non-numeric ignored keys never skip or count a row', () => {
  const invalid = new Set([
    -1,
    0.5,
    rows.length,
    1000000,
    NaN,
    Infinity,
    -Infinity,
    '1',
  ]);
  assert.deepEqual(partition(invalid), partition());
  const mixed = new Set([...invalid, 2]);
  assert.equal(partition(mixed).ignoredRows, 1);
  assert.deepEqual(ids(partition(mixed).samples), [0, 7, 8]);
});

test('all rows can be excluded and restored without shifting indices', () => {
  const ignored = new Set(rows.map((_, i) => i));
  const result = partition(ignored);
  assert.deepEqual(result.samples, []);
  assert.equal(result.ignoredRows, rows.length);
  for (const field of [
    'outsideFilter',
    'missingGroup',
    'otherGroup',
    'missingA',
    'missingB',
    'membersA',
    'membersB',
  ])
    assert.equal(result[field], 0);
  assert.equal(accountedRows(result), rows.length);
  assert.deepEqual(ids(partition(new Set()).samples), [0, 2, 7, 8]);
});

test('numeric group exclusions do not also count as intermediate or missing values', () => {
  const numericRows = [
    { score: '1', reference: '0' },
    { score: '2', reference: '10' },
    { score: '3', reference: '5' },
    { score: '4', reference: '' },
    { score: '', reference: '0' },
    { score: '8', reference: 'NA' },
  ];
  const result = partitionRows(
    numericRows,
    'score',
    { kind: 'numeric', column: 'reference', upperA: 2, lowerB: 8 },
    null,
    new Set([2, 3, 4]),
  );
  assert.deepEqual(ids(result.samples), [0, 1]);
  assert.equal(result.ignoredRows, 3);
  assert.equal(result.missingGroup, 1);
  assert.equal(result.otherGroup, 0);
  assert.equal(result.missingA, 0);
  assert.equal(result.membersA, 1);
  assert.equal(result.membersB, 1);
  assert.equal(accountedRows(result), numericRows.length);
});

test('candidate review uses the retained rows and reversible exclusion does not edit their scores', () => {
  const original = partition();
  const okScores = original.samples
    .filter((s) => s.group === 'A')
    .map((s) => s.score);
  const calibrated = calibrateOkRate(okScores, 50, 'high');
  const ref = { okGroup: 'A', rule: calibrated.rule };
  assert.deepEqual(
    ids(filterReviewSamples(original.samples, 'false-positive', ref)),
    [7],
  );
  assert.deepEqual(
    ids(filterReviewSamples(original.samples, 'false-negative', ref)),
    [8],
  );
  const excluded = partition(new Set([7]));
  assert.deepEqual(reviewCounts(excluded.samples, ref), {
    all: 3,
    falsePositive: 0,
    falseNegative: 1,
  });
  const recalibrated = calibrateOkRate(
    excluded.samples.filter((s) => s.group === 'A').map((s) => s.score),
    50,
    'high',
  );
  assert.equal(recalibrated.referenceCount, 1);
  assert.equal(recalibrated.actualPercent, 0);
  assert.deepEqual(partition(), original);
  assert.equal(rows[7].label, 'normal');
  assert.equal(rows[7].score, '2');
});

// Deliberately non-contiguous and unsorted indices represent the scoped source
// order. Ignored rows include FP, FN and correctly classified reference rows.
const listingSamples = [
  sample(40, 1, 'A'),
  sample(3, -1, 'B'),
  sample(91, -1, 'A'),
  sample(12, 1, 'B'),
  sample(77, 0, 'B'),
  sample(8, 1, 'A'),
];

test('listing interleaves ignored rows in source order without adding them to active counts', () => {
  const result = buildReviewListing(
    listingSamples,
    new Set([40, 91, 77]),
    'all',
    reference('gt'),
  );
  assert.deepEqual(ids(result.included), [3, 12, 8]);
  assert.deepEqual(ids(result.listed), [40, 3, 91, 12, 77, 8]);
  assert.deepEqual(ids(result.ignored), [40, 91, 77]);
  assert.deepEqual(result.counts, {
    all: 3,
    falsePositive: 1,
    falseNegative: 1,
  });
  for (const s of result.listed) {
    const original = listingSamples.find((row) => row.index === s.index);
    assert.equal(s, original);
    assert.equal(s.row, original.row);
  }
});

test('FP and FN filters always retain ignored rows but never count them as candidates', () => {
  const ignored = new Set([40, 91, 77]);
  for (const [filter, included, listed] of [
    ['false-positive', [8], [40, 91, 77, 8]],
    ['false-negative', [3], [40, 3, 91, 77]],
  ]) {
    const result = buildReviewListing(
      listingSamples,
      ignored,
      filter,
      reference('gt'),
    );
    assert.deepEqual(ids(result.included), included);
    assert.deepEqual(ids(result.listed), listed);
    assert.deepEqual(ids(result.ignored), [40, 91, 77]);
    assert.deepEqual(result.counts, {
      all: 3,
      falsePositive: 1,
      falseNegative: 1,
    });
  }
});

test('an unavailable threshold does not prevent finding ignored rows to restore', () => {
  const ignored = new Set([40, 91, 77]);
  for (const filter of ['all', 'false-positive', 'false-negative']) {
    const result = buildReviewListing(listingSamples, ignored, filter, null);
    assert.deepEqual(ids(result.included), filter === 'all' ? [3, 12, 8] : []);
    assert.deepEqual(
      ids(result.listed),
      filter === 'all' ? [40, 3, 91, 12, 77, 8] : [40, 91, 77],
    );
    assert.deepEqual(result.counts, {
      all: 3,
      falsePositive: null,
      falseNegative: null,
    });
  }
});

test('excluding every scoped row keeps the whole list restorable with no active denominator', () => {
  const ignored = new Set(ids(listingSamples));
  for (const filter of ['all', 'false-positive', 'false-negative']) {
    for (const ref of [reference('gt'), null]) {
      const result = buildReviewListing(listingSamples, ignored, filter, ref);
      assert.deepEqual(result.included, []);
      assert.deepEqual(result.listed, listingSamples);
      assert.deepEqual(result.ignored, listingSamples);
      assert.deepEqual(result.counts, {
        all: 0,
        falsePositive: ref ? 0 : null,
        falseNegative: ref ? 0 : null,
      });
    }
  }
});

test('restored rows obey the current candidate filter again and full restoration recovers the original list', () => {
  const ignored = new Set([40, 91, 77]);
  const ref = reference('gt');
  ignored.delete(40); // Restored FP becomes an active candidate.
  let result = buildReviewListing(
    listingSamples,
    ignored,
    'false-positive',
    ref,
  );
  assert.deepEqual(ids(result.included), [40, 8]);
  assert.deepEqual(ids(result.listed), [40, 91, 77, 8]);
  assert.deepEqual(result.counts, {
    all: 4,
    falsePositive: 2,
    falseNegative: 1,
  });
  ignored.delete(91); // Restored true negative no longer bypasses the FP filter.
  result = buildReviewListing(listingSamples, ignored, 'false-positive', ref);
  assert.deepEqual(ids(result.listed), [40, 77, 8]);
  assert.deepEqual(result.counts, {
    all: 5,
    falsePositive: 2,
    falseNegative: 1,
  });
  ignored.clear();
  result = buildReviewListing(listingSamples, ignored, 'all', ref);
  assert.deepEqual(result.included, listingSamples);
  assert.deepEqual(result.listed, listingSamples);
  assert.deepEqual(result.ignored, []);
  assert.deepEqual(result.counts, {
    all: 6,
    falsePositive: 2,
    falseNegative: 2,
  });
});

test('ignored and restored rows outside the supplied scope are not injected into its listing', () => {
  const scoped = listingSamples.slice(3);
  const ignored = new Set([40, 91, 77, 999]);
  const before = buildReviewListing(scoped, ignored, 'all', reference('gt'));
  assert.deepEqual(ids(before.listed), [12, 77, 8]);
  assert.deepEqual(ids(before.ignored), [77]);
  assert.deepEqual(before.counts, {
    all: 2,
    falsePositive: 1,
    falseNegative: 0,
  });
  ignored.delete(91);
  assert.deepEqual(
    buildReviewListing(scoped, ignored, 'all', reference('gt')),
    before,
  );
  assert.deepEqual(buildReviewListing([], ignored, 'all', reference('gt')), {
    included: [],
    listed: [],
    ignored: [],
    counts: { all: 0, falsePositive: 0, falseNegative: 0 },
  });
});

test('listing preserves input references and never mutates source arrays, ignored indices or rule', () => {
  const samples = Object.freeze(
    listingSamples.map((s) =>
      Object.freeze({ ...s, row: Object.freeze({ ...s.row }) }),
    ),
  );
  const ignored = new Set([40, 77]);
  const originalIndices = [...ignored];
  const ref = Object.freeze({
    okGroup: 'B',
    rule: Object.freeze({ threshold: 0, operator: 'lte', direction: 'low' }),
  });
  const before = structuredClone(samples);
  const result = buildReviewListing(samples, ignored, 'false-positive', ref);
  assert.deepEqual(ids(result.included), [3]);
  assert.deepEqual(ids(result.listed), [40, 3, 77]);
  assert.deepEqual(result.counts, {
    all: 4,
    falsePositive: 1,
    falseNegative: 1,
  });
  assert.equal(result.included[0], samples[1]);
  assert.equal(result.ignored[0], samples[0]);
  assert.equal(result.listed[1].row, samples[1].row);
  result.listed.reverse();
  result.included.pop();
  assert.deepEqual(ids(result.ignored), [40, 77]);
  assert.deepEqual(samples, before);
  assert.deepEqual([...ignored], originalIndices);
});

test('showing ignored samples cannot put them back into PR-AUC or threshold calibration', () => {
  const source = [
    { id: 'high-ok', score: '0.4', label: 'normal' },
    { id: 'ng-high', score: '0.8', label: 'anomaly' },
    { id: 'low-ok', score: '0.1', label: 'normal' },
    { id: 'ng-low', score: '0.35', label: 'anomaly' },
  ];
  const ignored = new Set([0]);
  const original = partitionRows(source, 'score', group);
  const active = partitionRows(source, 'score', group, null, ignored);
  const groupScores = (samples, name) =>
    samples.filter((s) => s.group === name).map((s) => s.score);
  const auc = (samples) =>
    precisionRecall(
      groupScores(samples, 'B'),
      groupScores(samples, 'A'),
      'high',
    );
  const calibrated = calibrateOkRate(
    groupScores(active.samples, 'A'),
    0,
    'high',
  );
  const ref = { okGroup: 'A', rule: calibrated.rule };
  const result = buildReviewListing(original.samples, ignored, 'all', ref);
  assert.deepEqual(ids(result.listed), [0, 1, 2, 3]);
  assert.deepEqual(ids(result.included), [1, 2, 3]);
  assert.deepEqual(ids(result.included), ids(active.samples));
  assert.deepEqual(result.counts, {
    all: 3,
    falsePositive: 0,
    falseNegative: 0,
  });
  assert.equal(auc(result.included).auc, 1);
  assert.equal(auc(result.included).negativeCount, 1);
  assert.ok(Math.abs(auc(result.listed).auc - 19 / 24) < 1e-12);
  assert.equal(calibrated.referenceCount, 1);
  assert.equal(calibrated.rule.threshold, 0.1);
  assert.equal(
    summarizeThreshold(groupScores(active.samples, 'B'), calibrated.rule)
      .detected,
    2,
  );
  assert.equal(
    calibrateOkRate(groupScores(result.listed, 'A'), 0, 'high').rule.threshold,
    0.4,
  );

  // A candidate filter can leave only the grey row on screen; it is not an FP.
  const candidates = buildReviewListing(
    original.samples,
    ignored,
    'false-positive',
    ref,
  );
  assert.deepEqual(candidates.included, []);
  assert.deepEqual(ids(candidates.listed), [0]);
  assert.equal(candidates.counts.falsePositive, 0);
  const scoped = buildReviewListing(
    original.samples.slice(0, 2),
    ignored,
    'all',
    ref,
  );
  assert.deepEqual(ids(scoped.listed), [0, 1]);
  assert.equal(scoped.counts.all, 1);
  assert.equal(auc(active.samples).positiveCount, 2);
  assert.equal(auc(active.samples).auc, 1);
  assert.equal(partitionRows(source, 'score', group).samples[0].row, source[0]);
  assert.equal(source[0].score, '0.4');
});

test('invalid candidate filters remain errors even when every row is ignored', () => {
  assert.throws(
    () =>
      buildReviewListing(
        listingSamples,
        new Set(ids(listingSamples)),
        'fp',
        null,
      ),
    /フィルタ/,
  );
});

void test('ignored-only listings work without calibration and preserve source row identity', () => {
  const ignored = new Set([40, 91, 77]);
  const before = structuredClone(listingSamples);
  const result = buildReviewListing(listingSamples, ignored, 'ignored', null);
  assert.deepEqual(ids(result.listed), [40, 91, 77]);
  assert.deepEqual(ids(result.ignored), [40, 91, 77]);
  assert.deepEqual(result.included, []);
  assert.deepEqual(result.counts, {
    all: 3,
    falsePositive: null,
    falseNegative: null,
  });
  for (const row of result.listed)
    assert.strictEqual(
      row,
      listingSamples.find((s) => s.index === row.index),
    );
  assert.deepEqual(listingSamples, before);
  assert.deepEqual([...ignored], [40, 91, 77]);
});

void test('ignored-only mode is independent of candidate direction and does not change counts', () => {
  const ignored = new Set([40, 91, 77]);
  for (const operator of ['gt', 'gte', 'lt', 'lte']) {
    for (const okGroup of ['A', 'B']) {
      const ref = reference(
        operator,
        operator.startsWith('lt') ? 'low' : 'high',
        okGroup,
      );
      const all = buildReviewListing(listingSamples, ignored, 'all', ref);
      const result = buildReviewListing(
        listingSamples,
        ignored,
        'ignored',
        ref,
      );
      assert.deepEqual(ids(result.listed), [40, 91, 77]);
      assert.deepEqual(result.included, []);
      assert.deepEqual(result.counts, all.counts);
    }
  }
});

void test('ignored-only mode respects the supplied scope instead of injecting all exclusions', () => {
  const result = buildReviewListing(
    listingSamples.slice(1, 4),
    new Set([40, 91, 77, 999]),
    'ignored',
    null,
  );
  assert.deepEqual(ids(result.listed), [91]);
  assert.equal(result.counts.all, 2);
  assert.deepEqual(result.included, []);
});

void test('restored rows leave ignored-only listings until none remain, without becoming exportable', () => {
  const ignored = new Set([40, 91]);
  ignored.delete(40);
  let result = buildReviewListing(listingSamples, ignored, 'ignored', null);
  assert.deepEqual(ids(result.listed), [91]);
  assert.equal(result.counts.all, 5);
  assert.deepEqual(result.included, []);
  ignored.delete(91);
  result = buildReviewListing(listingSamples, ignored, 'ignored', null);
  assert.deepEqual(result.listed, []);
  assert.deepEqual(result.included, []);
  assert.equal(result.counts.all, listingSamples.length);
  assert.deepEqual(
    ids(buildReviewListing(listingSamples, ignored, 'all', null).listed),
    ids(listingSamples),
  );
});

void test('an ignored-only view of fully excluded data has no retained denominator or export rows', () => {
  const result = buildReviewListing(
    listingSamples,
    new Set(ids(listingSamples)),
    'ignored',
    null,
  );
  assert.deepEqual(ids(result.listed), ids(listingSamples));
  assert.equal(result.counts.all, 0);
  assert.deepEqual(result.included, []);
  assert.deepEqual(
    buildReviewListing([], new Set(), 'ignored', null).listed,
    [],
  );
});

void test('ignored-only filtering leaves the independently computed comparison and calibration unchanged', () => {
  const omitted = new Set([7]);
  const active = partition(omitted);
  const groupScores = (name) =>
    active.samples.filter((s) => s.group === name).map((s) => s.score);
  const calibration = calibrateOkRate(groupScores('A'), 50, 'high');
  const metrics = precisionRecall(groupScores('B'), groupScores('A'), 'high');
  const result = buildReviewListing(partition().samples, omitted, 'ignored', {
    okGroup: 'A',
    rule: calibration.rule,
  });
  assert.deepEqual(ids(result.listed), [7]);
  assert.deepEqual(result.included, []);
  assert.deepEqual(partition(omitted), active);
  assert.deepEqual(calibrateOkRate(groupScores('A'), 50, 'high'), calibration);
  assert.deepEqual(
    precisionRecall(groupScores('B'), groupScores('A'), 'high'),
    metrics,
  );
});
