import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateDataset,
  validateDataset,
} from '../../packages/domain/evaluation.ts';
import { histogram } from '../../packages/domain/distribution.ts';
import { calibrateOkRate } from '../../packages/domain/threshold.ts';
import { CSVColumnCountError } from '../../packages/domain/csv-diagnostics.ts';
import { createEvaluationRuntime } from '../../packages/domain/evaluation-runtime.ts';
import {
  createTable,
  getCoreRowModel,
  getSortedRowModel,
} from '@tanstack/table-core';
import { finiteNumber } from '../../packages/domain/distribution.ts';

const make = (rows) => ({
  name: 'synthetic.csv',
  demo: false,
  columns: ['name', 'score', 'label', 'machine', 'aux'],
  rows: rows.map(([name, score, label, machine = 'keep', aux = score]) => ({
    name,
    score: String(score),
    label,
    machine,
    aux: String(aux),
  })),
});
const spec = {
  scoreColumn: 'score',
  group: { kind: 'category', column: 'label', a: 'OK', b: 'NG' },
  okGroup: 'A',
  direction: 'high',
  bins: 4,
};

test('automatic and explicit extents reject collapsed floating-point bins instead of hiding a cohort', () => {
  for (const [lo, hi] of [
    [1, 1 + Number.EPSILON],
    [1e12, 1e12 + 0.001],
  ]) {
    assert.throws(() => histogram([lo], [hi], 24), /差が小さすぎ/);
    assert.throws(
      () => histogram([lo], [hi], 24, { min: lo, max: hi }),
      /差が小さすぎ/,
    );
    const expanded = histogram([lo], [hi], 24, { min: lo - 1, max: hi + 1 });
    assert.equal(
      expanded.bins.reduce((n, bin) => n + bin.countA + bin.countB, 0),
      2,
    );
    assert.ok(expanded.bins.every((bin) => bin.lo < bin.hi));
  }
});

test('one evaluation conserves exclusion/missingness counts and separates review rows from denominators', () => {
  const dataset = make([
    ['a', 0, 'OK'],
    ['b', 1, 'OK', 'keep', ''],
    ['c', 2, 'OK'],
    ['d', 1.5, 'NG'],
    ['e', 3, 'NG'],
    ['f', 'NA', 'NG', 'keep', 5],
    ['g', 4, 'OK', 'outside'],
    ['h', 7, 'NG', 'outside'],
    ['i', 8, ''],
    ['j', 9, 'other'],
    ['k', 'bad', 'OK', 'keep', 10],
    ['l', 'Infinity', 'NG', 'keep', ''],
  ]);
  const original = structuredClone(dataset);
  const result = evaluateDataset(dataset, {
    ...spec,
    conditionFilter: { column: 'machine', value: 'keep' },
    ignoredIndices: [2, 6],
    comparisonScoreColumn: 'aux',
    threshold: { kind: 'ok-rate', targetPercent: 50 },
    list: {
      range: { lo: 0, hi: 2, includeHi: true },
      decisionFilter: 'false-positive',
    },
  });
  const p = result.comparison;
  assert.deepEqual(
    [
      p.ignoredRows,
      p.outsideFilter,
      p.missingGroup,
      p.otherGroup,
      p.missingA,
      p.missingB,
    ],
    [2, 1, 1, 1, 1, 2],
  );
  assert.equal(
    p.ignoredRows +
      p.outsideFilter +
      p.missingGroup +
      p.otherGroup +
      p.missingA +
      p.missingB +
      p.samples.length,
    dataset.rows.length,
  );
  assert.deepEqual(p.memberIndices, [0, 1, 3, 4, 5, 10, 11]);
  assert.equal(result.distribution.nA, 2);
  assert.equal(result.distribution.nB, 2);
  assert.equal(result.evaluation.auc, 1);
  assert.equal(result.baselineSummary.total, 5);
  assert.ok(result.baselineSummary.prAuc < result.evaluation.auc);
  assert.deepEqual(result.thresholdReport.calibration.rule, {
    threshold: 0,
    operator: 'gt',
    direction: 'high',
  });
  assert.equal(result.thresholdReport.groupA.detectedPercent, 50);
  assert.equal(result.thresholdReport.groupB.notDetectedPercent, 0);
  assert.deepEqual(result.listing.includedIndices, [1]);
  assert.deepEqual(result.listing.listedIndices, [1, 2]);
  assert.deepEqual(result.listing.ignoredIndices, [2]);
  assert.deepEqual(result.listing.counts, {
    all: 3,
    falsePositive: 1,
    falseNegative: 0,
  });
  assert.deepEqual(result.scoreCoverage, {
    total: 7,
    primaryValid: 4,
    comparisonValid: 5,
    bothValid: 3,
    primaryOnly: 1,
    comparisonOnly: 2,
    bothMissing: 1,
  });
  assert.ok(p.samples.every((sample) => !Object.hasOwn(sample, 'row')));
  assert.deepEqual(dataset, original);
});

test('display crop, bins and list changes never recalibrate or alter global PR', () => {
  const dataset = make([
    ['a', 0, 'OK'],
    ['b', 1, 'OK'],
    ['c', 2, 'NG'],
    ['d', 3, 'NG'],
  ]);
  const input = { ...spec, threshold: { kind: 'ok-rate', targetPercent: 50 } };
  const all = evaluateDataset(dataset, input);
  const narrowed = evaluateDataset(dataset, {
    ...input,
    bins: 20,
    histogramDomain: { min: 0, max: 1.5 },
    list: {
      query: 'c',
      idColumn: 'name',
      range: { lo: 2, hi: 3, includeHi: true },
      decisionFilter: 'false-negative',
    },
  });
  assert.deepEqual(narrowed.evaluation, all.evaluation);
  assert.deepEqual(narrowed.thresholdReport, all.thresholdReport);
  assert.deepEqual(narrowed.comparison, all.comparison);
  assert.equal(narrowed.displayDistribution.nB, 2);
  assert.equal(
    narrowed.displayDistribution.bins.reduce((n, b) => n + b.countB, 0),
    0,
  );
  assert.equal(
    narrowed.distribution.bins.reduce((n, b) => n + b.countB, 0),
    2,
  );
});

test('sample query keeps partial matching by default and supports case-insensitive exact matching', () => {
  const dataset = make([
    ['alpha', 0, 'OK'],
    ['alpha-2', 1, 'OK'],
    ['ALPHA', 2, 'NG'],
    ['beta', 3, 'NG'],
  ]);
  const partial = evaluateDataset(dataset, {
    ...spec,
    list: { idColumn: 'name', query: 'alpha' },
  });
  const exact = evaluateDataset(dataset, {
    ...spec,
    list: { idColumn: 'name', query: 'alpha', queryMode: 'exact' },
  });
  const legacy = evaluateDataset(dataset, {
    ...spec,
    list: { idColumn: 'name', query: 'alpha' },
  });
  assert.deepEqual(partial.listing.listedIndices, [0, 1, 2]);
  assert.deepEqual(exact.listing.listedIndices, [0, 2]);
  assert.deepEqual(legacy.listing.listedIndices, partial.listing.listedIndices);
  assert.throws(
    () =>
      evaluateDataset(dataset, {
        ...spec,
        list: { query: 'alpha', queryMode: 'starts-with' },
      }),
    /一致方法/,
  );
});

test('manual equality and low-score semantics are shared by calibration and candidate filtering', () => {
  const dataset = make([
    ['a', 1, 'OK'],
    ['b', 1, 'OK'],
    ['c', 1, 'NG'],
    ['d', 2, 'NG'],
  ]);
  const result = evaluateDataset(dataset, {
    ...spec,
    direction: 'low',
    threshold: {
      kind: 'manual',
      rule: { threshold: 1, operator: 'lte', direction: 'low' },
    },
    list: { decisionFilter: 'false-negative' },
  });
  assert.equal(result.thresholdReport.groupA.detected, 2);
  assert.equal(result.thresholdReport.groupB.notDetected, 1);
  assert.deepEqual(result.listing.includedIndices, [3]);
  assert.throws(
    () =>
      evaluateDataset(dataset, {
        ...spec,
        threshold: {
          kind: 'manual',
          rule: { threshold: 1, operator: 'lte', direction: 'low' },
        },
      }),
    /方向/,
  );
  assert.equal(calibrateOkRate([1, 1, 2, 2], 25, 'high').actualPercent, 0);
});

test('missing OK scores are unavailable, not perfect zero-error calibration', () => {
  const dataset = make([
    ['a', '', 'OK'],
    ['b', 2, 'NG'],
  ]);
  const result = evaluateDataset(dataset, spec);
  assert.equal(result.evaluation.auc, null);
  assert.equal(result.distribution.nA, 0);
  assert.equal(result.comparison.missingA, 1);
  assert.throws(
    () =>
      evaluateDataset(dataset, {
        ...spec,
        threshold: { kind: 'ok-rate', targetPercent: 1 },
      }),
    /1件以上/,
  );
});

test('row aliases retain each actual member index and exclusions only apply to that index', () => {
  const dataset = make([
    ['same', 1, 'OK'],
    ['different', 2, 'NG'],
  ]);
  dataset.rows.splice(1, 0, dataset.rows[0]);
  const result = evaluateDataset(dataset, { ...spec, ignoredIndices: [0] });
  assert.deepEqual(result.comparison.memberIndices, [1, 2]);
  assert.deepEqual(result.baseline.memberIndices, [0, 1, 2]);
});

test('structured input guards reject out-of-version exclusions and unknown fields', () => {
  const dataset = make([
    ['a', 1, 'OK'],
    ['b', 2, 'NG'],
  ]);
  validateDataset(dataset);
  assert.throws(
    () => evaluateDataset(dataset, { ...spec, ignoredIndices: [99] }),
    /現在のデータセット/,
  );
  assert.throws(
    () => evaluateDataset(dataset, { ...spec, scoreColumn: 'absent' }),
    /列がデータセット/,
  );
  assert.throws(
    () => validateDataset({ ...dataset, columns: ['score', 'score'] }),
    /一意/,
  );
  assert.throws(
    () => validateDataset({ ...dataset, rows: [{ score: null }] }),
    /文字列/,
  );
});

test('runtime diagnostics keep CSV row evidence and dataset registration is scoped', () => {
  const runtime = createEvaluationRuntime();
  const run = (command, requestId = 1) =>
    runtime({ workerGeneration: 2, requestId, command });
  const failure = run({
    kind: 'parse-csv',
    name: 'bad.csv',
    text: 'score,label\n1,OK,extra\n2,NG',
  });
  assert.equal(failure.ok, false);
  assert.equal(failure.error.code, 'csv-column-count');
  assert.equal(failure.error.diagnostic.actualColumns, 3);
  assert.ok(
    new CSVColumnCountError(failure.error.diagnostic).message.includes('3列'),
  );
  const dataset = make([
    ['a', 1, 'OK'],
    ['b', 2, 'NG'],
  ]);
  assert.equal(run({ kind: 'profile', datasetKey: 'one', dataset }).ok, true);
  assert.equal(run({ kind: 'evaluate', datasetKey: 'one', spec }).ok, true);
  assert.equal(
    run({ kind: 'evaluate', datasetKey: 'other', spec }).error.code,
    'dataset-unavailable',
  );
});

test('worker listing sorts match the existing table for score, group, sample, text and auxiliary numbers', () => {
  const dataset = make([
    ['Part10', 2, 'OK', 'keep', '12'],
    ['part2', 1, 'NG', 'keep', '2'],
    ['Part1', 2, 'NG', 'keep', 'bad'],
    ['part02', 3, 'OK', 'keep', '-0.5'],
    ['部品3', 4, 'OK', 'keep', ''],
    ['部品10', 0, 'NG', 'keep', '12'],
  ]);
  const definitions = [
    { column: '__score', kind: 'number', get: (s) => s.score },
    { column: '__group', kind: 'text', get: (s) => s.group },
    { column: '__sample', kind: 'alphanumeric', get: (s) => s.row.name },
    { column: 'label', kind: 'text', get: (s) => s.row.label },
    {
      column: 'aux',
      kind: 'number',
      get: (s) => finiteNumber(s.row.aux) ?? undefined,
    },
  ];
  const baseline = evaluateDataset(dataset, {
    ...spec,
    ignoredIndices: [0, 5],
  });
  const samples = baseline.baseline.samples.map((s) => ({
    ...s,
    row: dataset.rows[s.index],
  }));
  for (const definition of definitions)
    for (const desc of [false, true]) {
      const table = createTable({
        data: samples,
        columns: [
          {
            id: 'value',
            accessorFn: definition.get,
            sortingFn: definition.kind === 'number' ? 'basic' : definition.kind,
            sortUndefined: 'last',
          },
        ],
        state: { sorting: [{ id: 'value', desc }] },
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        onStateChange() {},
        renderFallbackValue: null,
      });
      const result = evaluateDataset(dataset, {
        ...spec,
        ignoredIndices: [0, 5],
        list: {
          idColumn: 'name',
          sort: { column: definition.column, kind: definition.kind, desc },
        },
      });
      const expected = table
        .getSortedRowModel()
        .rows.map((row) => row.original.index);
      assert.deepEqual(
        result.listing.listedIndices,
        expected,
        `${definition.column} desc=${desc}`,
      );
      assert.deepEqual(
        result.listing.ignoredIndices,
        expected.filter((i) => i === 0 || i === 5),
      );
      assert.deepEqual(
        result.listing.includedIndices,
        expected.filter((i) => i !== 0 && i !== 5),
      );
      assert.deepEqual(result.summary, baseline.summary);
      assert.deepEqual(result.listing.counts, baseline.listing.counts);
      assert.deepEqual(result.distribution, baseline.distribution);
    }
});

test('listing sort keeps ties stable, missing numeric values last, fallback names natural and original headers unambiguous', () => {
  const dataset = make(
    Array.from({ length: 12 }, (_, i) => [
      `n${i}`,
      i,
      i % 2 ? 'NG' : 'OK',
      'keep',
      i % 3 ? 'NA' : '2',
    ]),
  );
  dataset.columns.push('__score');
  dataset.rows.forEach((row, i) => (row.__score = String(12 - i)));
  const named = evaluateDataset(dataset, {
    ...spec,
    list: { sort: { column: '__sample', desc: false } },
  });
  assert.deepEqual(
    named.listing.listedIndices,
    Array.from({ length: 12 }, (_, i) => i),
  );
  const descending = evaluateDataset(dataset, {
    ...spec,
    list: { sort: { column: 'aux', kind: 'number', desc: true } },
  });
  assert.deepEqual(
    descending.listing.listedIndices,
    [0, 3, 6, 9, 1, 2, 4, 5, 7, 8, 10, 11],
  );
  const actualColumn = evaluateDataset(dataset, {
    ...spec,
    list: {
      sort: { column: '__score', source: 'row', kind: 'number', desc: false },
    },
  });
  assert.deepEqual(
    actualColumn.listing.listedIndices,
    Array.from({ length: 12 }, (_, i) => 11 - i),
  );
  assert.throws(
    () =>
      evaluateDataset(dataset, {
        ...spec,
        list: { sort: { column: 'absent', desc: false } },
      }),
    /列がデータセット/,
  );
});
