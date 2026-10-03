import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  audioPopulation,
  audioIgnoredIndices,
  AUDIO_JOIN_POLICY,
} from '../../packages/domain/audio-population.ts';
import { evaluateDataset } from '../../packages/domain/evaluation.ts';
import { createBrowserRepository } from '../../packages/browser-storage/index.ts';
import { WorkspaceController } from '../../src/state/workspace-controller.ts';
import { fixture } from './storage-helpers.mjs';
const data = (rows) => ({
  name: 'source.csv',
  columns: ['id', 'score', 'group', 'audio_file', 'aux'],
  demo: false,
  rows: rows.map(([audio_file, score, group, aux = '']) => ({
    id: audio_file,
    audio_file,
    score: String(score),
    group,
    aux,
  })),
});
const files = (...keys) =>
  new Map(
    keys.map((key) => [
      key,
      new File(['audio'], key.split('/').at(-1), { lastModified: 123 }),
    ]),
  );
const spec = {
  scoreColumn: 'score',
  group: { kind: 'category', column: 'group', a: 'A', b: 'B' },
  okGroup: 'A',
  direction: 'high',
  comparisonScoreColumn: 'aux',
  threshold: { kind: 'ok-rate', targetPercent: 50 },
  list: { idColumn: 'id', audioColumn: 'audio_file' },
};
const join = (dataset, sources) =>
  audioPopulation(dataset, 'id', 'audio_file', sources);
const evaluate = (dataset, population, manual = new Set(), extra = {}) =>
  evaluateDataset(dataset, {
    ...spec,
    audioExcludedIndices: population.excludedIndices,
    ignoredIndices: [...audioIgnoredIndices(population, manual)],
    ...extra,
  });

test('one audio adopts the first complete source row, without attribute mixing or sorting dependence', () => {
  const dataset = data([
    ['A/a.wav', '1', 'A', ''],
    ['A/a.wav', '999', 'B', '555'],
    ['B/b.wav', '2', 'B', '2'],
  ]);
  const before = structuredClone(dataset);
  const sources = files('B/b.wav', 'A/a.wav');
  const p = join(dataset, sources);
  assert.deepEqual(
    [...p.adopted],
    [
      ['A/a.wav', 0],
      ['B/b.wav', 2],
    ],
  );
  assert.deepEqual(p.duplicates, [
    { index: 1, adoptedIndex: 0, key: 'A/a.wav' },
  ]);
  assert.deepEqual(dataset, before);
  assert.equal(p.inventory[0].key, 'B/b.wav');
  assert.equal(p.inventory[0].rowIndex, 2);
  for (const sort of [
    { column: '__score', desc: true },
    { column: '__sample', desc: false },
  ]) {
    const result = evaluate(dataset, p, new Set(), {
      list: { ...spec.list, sort },
    });
    assert.deepEqual(result.a, [1]);
    assert.deepEqual(result.b, [2]);
    assert.equal(result.summary.total, 2);
    assert.equal(result.baselineSummary.total, 2);
    assert.deepEqual(new Set(result.listing.includedIndices), new Set([0, 2]));
    assert.equal(result.comparison.missingA, 0);
    assert.equal(result.comparison.memberIndices.includes(1), false);
    assert.equal(result.scoreCoverage.total, 2);
    assert.equal(result.scoreCoverage.bothValid, 1);
  }
  assert.equal(
    join(dataset, new Map([...sources].reverse())).signature,
    p.signature,
  );
});

test('missing paths, empty references and ambiguous basenames never become successful bindings', () => {
  const dataset = data([
    ['same.wav', '5', 'A'],
    ['a/same.wav', '1', 'A'],
    ['b/same.wav', '2', 'B'],
    ['missing/same.wav', '10', 'B'],
    ['', '9', 'B'],
  ]);
  const p = join(dataset, files('a/same.wav', 'b/same.wav', 'unused.wav'));
  assert.deepEqual(p.excludedIndices, [0, 3, 4]);
  assert.deepEqual(p.ambiguous[0].candidates, ['a/same.wav', 'b/same.wav']);
  assert.equal(p.missing.length, 2);
  assert.equal(
    p.inventory.find((x) => x.key === 'unused.wav').rowIndex,
    undefined,
  );
  assert.equal(p.adopted.size, 2);
  const result = evaluate(dataset, p);
  assert.equal(result.summary.total, 2);
  assert.deepEqual(result.a, [1]);
  assert.deepEqual(result.b, [2]);
  assert.deepEqual(result.baseline.memberIndices, [1, 2]);
  assert.deepEqual(result.comparison.memberIndices, [1, 2]);
});

test('CSV-only, completely unmatched and audio-only attributes are explicit zero-target errors', () => {
  const dataset = data([
    ['a.wav', '1', 'A'],
    ['b.wav', '2', 'B'],
  ]);
  for (const sources of [new Map(), files('other.wav')]) {
    const p = join(dataset, sources);
    assert.equal(p.adopted.size, 0);
    assert.equal(p.missing.length, 2);
    assert.throws(() => evaluate(dataset, p), /解析対象は0件/);
  }
  assert.equal(
    join(dataset, files('other.wav')).inventory[0].rowIndex,
    undefined,
  );
});

test('first-row missing scores/groups remain missing; later rows cannot fill their attributes', () => {
  const dataset = data([
    ['a.wav', '', 'A', '1'],
    ['a.wav', '100', 'A', '2'],
    ['b.wav', '3', '', '3'],
    ['c.wav', '4', 'B', '4'],
  ]);
  const result = evaluate(
    dataset,
    join(dataset, files('a.wav', 'b.wav', 'c.wav')),
    new Set(),
    { threshold: null },
  );
  assert.deepEqual(result.a, []);
  assert.deepEqual(result.b, [4]);
  assert.equal(result.comparison.missingA, 1);
  assert.equal(result.comparison.missingGroup, 1);
  assert.equal(result.thresholdReport, null);
  assert.deepEqual(result.listing.includedIndices, [3]);
  assert.equal(result.summary.total, 1);
});

test('manual exclusions on non-adopted rows still exclude their audio and remain separate records', () => {
  const dataset = data([
    ['a.wav', '1', 'A'],
    ['a.wav', '999', 'B'],
    ['b.wav', '2', 'B'],
  ]);
  const p = join(dataset, files('a.wav', 'b.wav'));
  const manual = new Set([1]);
  assert.deepEqual([...audioIgnoredIndices(p, manual)], [1, 0]);
  assert.deepEqual([...manual], [1]);
  const result = evaluate(dataset, p, manual, { threshold: null });
  assert.deepEqual(result.a, []);
  assert.deepEqual(result.b, [2]);
  assert.equal(result.comparison.ignoredRows, 1);
  assert.equal(result.baselineSummary.total, 2);
  assert.equal(result.summary.total, 1);
  assert.deepEqual(result.listing.ignoredIndices, [0]);
  const missing = join(dataset, files('b.wav'));
  assert.deepEqual([...audioIgnoredIndices(missing, manual)], [1]);
  assert.equal(
    evaluate(dataset, missing, manual, { threshold: null }).summary.total,
    1,
  );
  assert.equal(
    evaluate(dataset, p, manual, { threshold: null }).summary.total,
    1,
  );
});

test('partial reattachment changes every comparison, threshold and displayed subset together', () => {
  const dataset = data([
    ['a.wav', '1', 'A', '1'],
    ['b.wav', '2', 'A', '2'],
    ['c.wav', '3', 'B', '3'],
    ['d.wav', '999', 'B', '999'],
  ]);
  const partial = evaluate(dataset, join(dataset, files('a.wav', 'c.wav')));
  const full = evaluate(
    dataset,
    join(dataset, files('a.wav', 'b.wav', 'c.wav', 'd.wav')),
  );
  assert.deepEqual(partial.a, [1]);
  assert.deepEqual(partial.b, [3]);
  assert.equal(partial.summary.total, 2);
  assert.equal(full.summary.total, 4);
  assert.deepEqual(partial.comparison.memberIndices, [0, 2]);
  assert.deepEqual(partial.listing.includedIndices, [0, 2]);
  assert.equal(
    partial.distribution.bins.reduce((n, b) => n + b.countA + b.countB, 0),
    2,
  );
  assert.notDeepEqual(
    partial.thresholdReport.calibration,
    full.thresholdReport.calibration,
  );
  assert.throws(
    () => evaluateDataset(dataset, { ...spec, audioExcludedIndices: [9] }),
    /現在のデータセット/,
  );
});

test('lightweight save/resume retains source rows, rejected-row notes, join policy and manual exclusion without stale audio', async (t) => {
  const env = fixture();
  const repo = await createBrowserRepository(env.options);
  let controller = new WorkspaceController(repo, 60000);
  t.after(() => {
    controller.dispose();
    repo.close();
  });
  const dataset = data([
    ['a.wav', '1', 'A'],
    ['a.wav', '2', 'A'],
    ['b.wav', '3', 'B'],
  ]);
  const source = new File(
    [
      'id,score,group,audio_file,aux\na,1,A,a.wav,\na,2,A,a.wav,\nb,3,B,b.wav,\n',
    ],
    'source.csv',
  );
  await controller.create(
    {
      title: 'source',
      dataset,
      source,
      audioFiles: files('a.wav', 'b.wav'),
      state: {
        schemaVersion: 1,
        rowCount: 3,
        audioJoinPolicy: AUDIO_JOIN_POLICY,
        notes: { 1: '非採用行のメモ' },
        score: 'score',
        idColumn: 'id',
        audioColumn: 'audio_file',
        group: spec.group,
      },
    },
    true,
  );
  const id = controller.getSnapshot().active.record.id;
  await controller.flush();
  controller.dispose();
  controller = new WorkspaceController(
    await createBrowserRepository(env.options),
    60000,
  );
  await controller.open(id);
  assert.ok(controller.getSnapshot().pendingResume);
  await controller.resumeReference(dataset, source);
  const active = controller.getSnapshot().active;
  assert.equal(active.audioFiles.size, 0);
  assert.equal(active.record.state.notes[1], '非採用行のメモ');
  assert.equal(active.record.state.audioJoinPolicy, AUDIO_JOIN_POLICY);
  assert.deepEqual(active.dataset.rows, dataset.rows);
  assert.throws(
    () => evaluate(dataset, join(dataset, active.audioFiles)),
    /解析対象は0件/,
  );
  controller.updateAudio(files('a.wav', 'b.wav'));
  assert.equal(
    evaluate(dataset, join(dataset, controller.getSnapshot().active.audioFiles))
      .summary.total,
    2,
  );
  await controller.flush();
  assert.equal(env.files().length, 0);
  await assert.rejects(
    controller.resumeReference(
      { ...dataset, rows: dataset.rows.slice(1) },
      source,
    ),
    /再開する分析|保存時と異なります/,
  );
});

test('100001-entry inventory joins once per source row without audio byte reads', () => {
  const count = 100001;
  const dataset = data(
    Array.from({ length: count }, (_, i) => [
      `set/${i}.wav`,
      String(i),
      i % 2 ? 'B' : 'A',
    ]),
  );
  const sources = new Map(
    dataset.rows.map((row) => [
      row.audio_file,
      {
        name: row.audio_file.split('/').at(-1),
        arrayBuffer() {
          throw new Error('PCM read');
        },
      },
    ]),
  );
  const started = performance.now();
  const p = join(dataset, sources);
  assert.equal(p.inventory.length, count);
  assert.equal(p.adopted.size, count);
  assert.equal(p.excludedIndices.length, 0);
  assert.ok(p.signature.length < 100);
  console.log(
    JSON.stringify({
      audioPrimaryCount: count,
      joinMs: performance.now() - started,
      scopeBytes: p.signature.length,
      pcmReads: 0,
    }),
  );
});
