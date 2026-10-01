import test from 'node:test';
import assert from 'node:assert/strict';
import { datasetRows } from '../../packages/domain/dataset-rows.ts';
import {
  withFolderAttributes,
  folderMembershipSignature,
} from '../../packages/domain/audio-import.ts';
import {
  validateDataset,
  evaluateDataset,
} from '../../packages/domain/evaluation.ts';
import {
  parseCSV,
  profileColumns,
  csvText,
} from '../../packages/domain/data.ts';
import { createEvaluationRuntime } from '../../packages/domain/evaluation-runtime.ts';

const source = () => ({
  name: 'source.csv',
  demo: false,
  columns: ['audio', 'score', '__proto__', 'index'],
  rows: [
    JSON.parse(
      '{"audio":"a/device/1.wav","score":"0.1","__proto__":"literal","index":"source-index"}',
    ),
    JSON.parse(
      '{"audio":"b/device/2.wav","score":"0.9","__proto__":"second","index":"other-index"}',
    ),
    JSON.parse(
      '{"audio":"missing.wav","score":"0.5","__proto__":"third","index":"missing-index"}',
    ),
  ],
});
const files = new Map([
  ['a/device/1.wav', {}],
  ['b/device/2.wav', {}],
]);
const spec = {
  scoreColumn: 'score',
  group: { kind: 'category', column: 'WAVフォルダ階層1', a: 'a', b: 'b' },
  okGroup: 'A',
  direction: 'high',
  conditionFilter: { column: 'WAVフォルダ階層2', value: 'device' },
  list: { sort: { column: 'WAVフォルダ階層1', source: 'row', desc: true } },
};

test('sparse columns share frozen source rows, expose named/enumerable cells, and survive wire cloning', () => {
  const base = source();
  const snapshot = structuredClone(base);
  base.rows.forEach(Object.freeze);
  Object.freeze(base.rows);
  const data = withFolderAttributes(base, '', 'audio', files, [1, 2]);
  assert.equal(data.rows, base.rows);
  assert.equal(data.derivedColumns.get('WAVフォルダ階層1').size, 2);
  validateDataset(data);
  const rows = datasetRows(data);
  assert.equal(datasetRows(data), rows);
  assert.equal(rows[0].__proto__, 'literal');
  assert.equal(rows[0].index, 'source-index');
  assert.equal(rows[2]['WAVフォルダ階層1'], '');
  assert.deepEqual(Object.keys(rows[0]), data.columns);
  assert.deepEqual(
    { ...rows[0] },
    { ...base.rows[0], WAVフォルダ階層1: 'a', WAVフォルダ階層2: 'device' },
  );
  assert.throws(() => {
    rows[0].score = 'mutated';
  }, TypeError);
  const copy = structuredClone(data);
  validateDataset(copy);
  assert.deepEqual(profileColumns(copy), profileColumns(data));
  assert.equal(
    folderMembershipSignature(datasetRows(copy), data.columns),
    folderMembershipSignature(rows, data.columns),
  );
  assert.deepEqual(
    parseCSV(csvText(data.columns, rows)).rows,
    rows.map((row) => ({ ...row })),
  );
  assert.deepEqual(
    evaluateDataset(copy, spec),
    evaluateDataset(
      {
        ...data,
        derivedColumns: undefined,
        rows: rows.map((row) => ({ ...row })),
      },
      spec,
    ),
  );
  assert.deepEqual(evaluateDataset(copy, spec).listing.listedIndices, [1, 0]);
  assert.deepEqual(base, snapshot);
});

test('registration rejects invalid sparse indices, cells, collisions and source omissions', () => {
  const base = source();
  const data = withFolderAttributes(base, '', 'audio', files, [1]);
  for (const entries of [
    [[-1, 'a']],
    [[3, 'a']],
    [[0.5, 'a']],
    [['0', 'a']],
    [[0, null]],
  ]) {
    assert.throws(
      () =>
        validateDataset({
          ...data,
          derivedColumns: new Map([['WAVフォルダ階層1', new Map(entries)]]),
        }),
      /派生セル/,
    );
  }
  assert.throws(
    () => validateDataset({ ...data, derivedColumns: {} }),
    /派生列/,
  );
  assert.throws(
    () =>
      validateDataset({
        ...data,
        derivedColumns: new Map([['unknown', new Map()]]),
      }),
    /派生列/,
  );
  assert.throws(
    () =>
      validateDataset({
        ...data,
        rows: data.rows.map((row) => ({ ...row, WAVフォルダ階層1: 'shadow' })),
      }),
    /各行/,
  );
  assert.throws(
    () => validateDataset({ ...data, rows: [{}] }),
    /派生セル|各行/,
  );
});

test('worker updates require the registered base and can clear derived columns', () => {
  const runtime = createEvaluationRuntime();
  let requestId = 0;
  const run = (command) =>
    runtime({ workerGeneration: 1, requestId: ++requestId, command });
  const base = source();
  const data = withFolderAttributes(base, '', 'audio', files, [1]);
  const { rows, ...metadata } = data;
  assert.equal(
    run({ kind: 'profile', datasetKey: 'base', dataset: base }).ok,
    true,
  );
  assert.equal(
    run({
      kind: 'profile',
      datasetKey: 'new',
      datasetUpdate: { baseDatasetKey: 'wrong', dataset: metadata },
    }).error.code,
    'dataset-unavailable',
  );
  assert.equal(
    run({
      kind: 'profile',
      datasetKey: 'new',
      datasetUpdate: { baseDatasetKey: 'base', dataset: metadata },
    }).ok,
    true,
  );
  const { rows: _rows, ...original } = base;
  const result = run({
    kind: 'profile',
    datasetKey: 'reset',
    datasetUpdate: { baseDatasetKey: 'new', dataset: original },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.result.map((p) => p.column),
    base.columns,
  );
});

test('100,001 CSV rows are accepted: the scalability target is not a row limit', () => {
  const data = parseCSV('score,group\n' + '1,A\n'.repeat(100_001));
  assert.equal(data.rows.length, 100_001);
  validateDataset(data);
});
