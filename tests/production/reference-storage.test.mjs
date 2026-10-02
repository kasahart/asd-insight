import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserRepository } from '../../packages/browser-storage/index.ts';
import { WorkspaceController } from '../../src/state/workspace-controller.ts';
import {
  inputMembership,
  logicalDatasetHash,
} from '../../src/state/input-references.ts';
import { withFolderAttributes } from '../../packages/domain/audio-import.ts';
import { datasetRows } from '../../packages/domain/dataset-rows.ts';
import { findAudio } from '../../packages/domain/data.ts';
import {
  deferred,
  fixture,
  rewriteBundle,
  rawDatabase,
  rawTransaction,
} from './storage-helpers.mjs';

function inputs(audioSize = 1024 ** 3) {
  const columns = ['id', 'score', 'group', 'audio_file'];
  const rows = [
    { id: 'a', score: '0.1', group: 'A', audio_file: 'A/a.wav' },
    { id: 'b', score: '0.9', group: 'B', audio_file: 'B/b.wav' },
  ];
  const source = new File(
    [
      columns.join(',') +
        '\n' +
        rows.map((row) => columns.map((c) => row[c]).join(',')).join('\n'),
    ],
    'scores.csv',
  );
  const dataset = { name: source.name, columns, rows, demo: false };
  const state = {
    schemaVersion: 1,
    rowCount: 2,
    score: 'score',
    idColumn: 'id',
    audioColumn: 'audio_file',
    group: { kind: 'category', column: 'WAVフォルダ階層1', a: 'A', b: 'B' },
    adoptedFolderLevels: [1],
    notes: { 1: '調査メモ' },
  };
  const audioFiles = new Map(
    ['A/a.wav', 'B/b.wav'].map((key) => {
      const file = new File(['small'], key.split('/').at(-1), {
        lastModified: 123,
      });
      // Model metadata for GB-scale original inputs without allocating GB of test RAM.
      Object.defineProperty(file, 'size', { value: audioSize });
      file.arrayBuffer = () => {
        throw new Error('WAV bytes must never be read for a reference save');
      };
      return [key, file];
    }),
  );
  return { title: dataset.name, dataset, source, state, audioFiles };
}

test('GB-scale WAV references persist and reopen without audio/source copies; folder membership survives missing audio', async (t) => {
  const env = fixture();
  const repo = await createBrowserRepository(env.options);
  const controller = new WorkspaceController(repo, 60_000);
  const input = inputs();
  await controller.create(input, true);
  const id = controller.getSnapshot().active.record.id;
  controller.setState('query', 'a.wav');
  await controller.flush();
  assert.equal(env.files().length, 0);
  const stored = await repo.loadSession(id);
  assert.equal(stored.dataset.rows.length, 0);
  assert.equal(stored.dataset.externalCSV.rowCount, 2);
  assert.equal(stored.source, undefined);
  assert.equal(stored.audioFiles.size, 0);
  assert.ok(stored.record.bundleBytes < 10_000);
  const bundle = await controller.exportBundle();
  assert.ok(bundle.size < 10_000);
  controller.dispose();
  const reopened = await createBrowserRepository(env.options);
  const next = new WorkspaceController(reopened, 60_000);
  t.after(() => next.dispose());
  await next.open(id);
  assert.equal(next.getSnapshot().active, null);
  assert.ok(next.getSnapshot().pendingResume);
  await next.resumeReference(input.dataset, input.source);
  const active = next.getSnapshot().active;
  assert.equal(active.record.state.notes[1], '調査メモ');
  assert.equal(active.record.state.query, 'a.wav');
  assert.equal(active.audioFiles.size, 0);
  assert.deepEqual(
    datasetRows(
      withFolderAttributes(
        active.dataset,
        'id',
        'audio_file',
        inputMembership(active),
        [1],
      ),
    ).map((row) => row['WAVフォルダ階層1']),
    ['A', 'B'],
  );
  next.updateAudio(new Map([['A/a.wav', input.audioFiles.get('A/a.wav')]]));
  await next.flush();
  assert.equal(next.getSnapshot().active.record.audioReferences.length, 2);
  assert.equal(next.getSnapshot().active.audioFiles.size, 1);
  assert.equal(env.files().length, 0);
});

test('changed CSV and changed audio metadata cannot replace saved investigation; renamed CSV is accepted', async (t) => {
  const repo = await createBrowserRepository({ mode: 'memory' });
  const controller = new WorkspaceController(repo, 60_000);
  t.after(() => controller.dispose());
  const input = inputs();
  await controller.create(input, true);
  const original = controller.getSnapshot().active.record;
  const bundle = await controller.exportBundle();
  await controller.importBundle(bundle);
  const pending = controller.getSnapshot().pendingResume;
  await assert.rejects(
    controller.resumeReference(
      input.dataset,
      new File(['changed'], 'scores.csv'),
    ),
    /内容が保存時と異なります/,
  );
  assert.equal(
    controller.getSnapshot().pendingResume.record.id,
    pending.record.id,
  );
  assert.equal(controller.getSnapshot().active.record.id, original.id);
  await controller.resumeReference(
    input.dataset,
    new File([input.source], 'moved-and-renamed.csv'),
  );
  assert.throws(
    () =>
      controller.updateAudio(
        new Map([
          ['A/a.wav', new File(['changed'], 'a.wav', { lastModified: 999 })],
        ]),
      ),
    /保存時と異なります/,
  );
  assert.equal(controller.getSnapshot().active.audioFiles.size, 0);
  // A distinct path adds a reference; it never replaces the original explicit CSV path.
  controller.updateAudio(new Map([['a.wav', input.audioFiles.get('A/a.wav')]]));
  await controller.flush();
  assert.equal(
    controller.getSnapshot().active.record.audioReferences.length,
    3,
  );
  assert.ok(
    controller
      .getSnapshot()
      .active.record.audioReferences.some((ref) => ref.key === 'A/a.wav'),
  );
  assert.equal(
    findAudio(
      input.dataset.rows[0],
      0,
      'id',
      'audio_file',
      controller.getSnapshot().active.audioFiles,
    ),
    undefined,
  );
  assert.equal(
    controller.getSnapshot().active.record.state.notes[1],
    '調査メモ',
  );
});

test('failed full save can explicitly copy current notes and all audio references into lightweight storage', async (t) => {
  const repo = await createBrowserRepository({ mode: 'memory' });
  const controller = new WorkspaceController(repo, 60_000);
  t.after(() => controller.dispose());
  const input = inputs(75 * 1024 ** 2);
  await controller.create({
    ...input,
    audioFiles: new Map(),
    state: {
      ...input.state,
      adoptedFolderLevels: [],
      group: { kind: 'category', column: 'group', a: 'A', b: 'B' },
    },
  });
  const fullId = controller.getSnapshot().active.record.id;
  controller.updateAudio(input.audioFiles);
  controller.setState('notes', { 1: '容量超過後も保持' });
  await assert.rejects(controller.flush(), /バックアップ容量/);
  await controller.saveAsReference();
  const active = controller.getSnapshot().active;
  assert.notEqual(active.record.id, fullId);
  assert.equal(active.record.state.notes[1], '容量超過後も保持');
  assert.equal(active.record.audioReferences.length, 2);
  assert.equal(controller.getSnapshot().status, 'saved');
  assert.equal(
    (await repo.loadSession(fullId)).record.audioReferences,
    undefined,
  );
});

test('100001 unique input references fit a lightweight bundle independent of audio bytes', async (t) => {
  const repo = await createBrowserRepository({ mode: 'memory' });
  t.after(() => repo.close());
  const input = inputs();
  const audioReferences = Array.from({ length: 100001 }, (_, i) => ({
    key: `group/${i}.wav`,
    name: `${i}.wav`,
    size: 1024 ** 3,
    lastModified: 123,
  }));
  const record = await repo.createSession({
    title: 'large',
    dataset: {
      ...input.dataset,
      rows: [],
      externalCSV: { hash: 'a'.repeat(64), size: 7_000_000, rowCount: 100001 },
    },
    state: {},
    audioReferences,
  });
  assert.ok(record.bundleBytes < 20 * 1024 ** 2);
  const bundle = await repo.exportBundle(record.id);
  const restored = await repo.importBundle(bundle);
  assert.equal(restored.record.audioReferences.length, 100001);
  assert.equal(restored.dataset.rows.length, 0);
  assert.equal(restored.audioFiles.size, 0);
});

test('reference formats reject duplicate paths, input bytes and total metadata quota while leaving the prior session intact', async (t) => {
  const baseline = await createBrowserRepository({ mode: 'memory' });
  const input = inputs();
  const ref = {
    title: 'ref',
    dataset: {
      ...input.dataset,
      rows: [],
      externalCSV: {
        hash: 'b'.repeat(64),
        size: input.source.size,
        rowCount: 2,
      },
    },
    state: {},
    audioReferences: [],
  };
  const first = await baseline.createSession(ref);
  baseline.close();
  const repo = await createBrowserRepository({
    mode: 'memory',
    maxTotalBytes: first.bundleBytes + 16,
  });
  t.after(() => repo.close());
  const saved = await repo.createSession(ref);
  await assert.rejects(
    repo.createSession(ref),
    (error) => error.code === 'QUOTA',
  );
  const entry = { key: 'a.wav', name: 'a.wav', size: 100, lastModified: 123 };
  await assert.rejects(
    repo.createSession({ ...ref, audioReferences: [entry, entry] }),
    /不正・重複/,
  );
  await assert.rejects(
    repo.createSession({ ...ref, source: input.source }),
    /本体/,
  );
  await assert.rejects(
    repo.saveSession(saved.id, {
      expectedRevision: 1,
      operationId: 'wrong-mode',
      state: {},
      audioFiles: new Map(),
    }),
    /一致しません/,
  );
  assert.deepEqual((await repo.loadSession(saved.id)).record, saved);
});

test('edits during a lightweight copy remain on the original screen and are not marked saved', async (t) => {
  const repo = await createBrowserRepository({ mode: 'memory' });
  const controller = new WorkspaceController(repo, 60_000);
  t.after(() => controller.dispose());
  const input = inputs();
  await controller.create(input, true);
  const originalId = controller.getSnapshot().active.record.id;
  const started = deferred(),
    release = deferred();
  const read = input.source.arrayBuffer.bind(input.source);
  input.source.arrayBuffer = async () => {
    started.resolve();
    await release.promise;
    return read();
  };
  const copy = controller.saveAsReference();
  await started.promise;
  controller.setState('notes', { 1: 'コピー中の追加編集' });
  release.resolve();
  await assert.rejects(copy, /追加編集は元の画面に残っています/);
  assert.equal(controller.getSnapshot().active.record.id, originalId);
  assert.equal(
    controller.getSnapshot().active.record.state.notes[1],
    'コピー中の追加編集',
  );
  assert.equal(controller.getSnapshot().status, 'unsaved');
  const created = (await repo.listSessions()).find(
    (record) => record.id !== originalId,
  );
  assert.equal(created.state.notes[1], '調査メモ');
  await controller.flush();
  assert.equal(
    (await repo.loadSession(originalId)).record.state.notes[1],
    'コピー中の追加編集',
  );
});

test('malformed reference backups never replace existing analyses', async (t) => {
  const repo = await createBrowserRepository({ mode: 'memory' });
  t.after(() => repo.close());
  const input = inputs();
  const record = await repo.createSession({
    title: 'ref',
    dataset: {
      ...input.dataset,
      rows: [],
      externalCSV: {
        hash: 'b'.repeat(64),
        size: input.source.size,
        rowCount: 2,
      },
    },
    state: {},
    audioReferences: [],
  });
  const bundle = await repo.exportBundle(record.id);
  for (const mutate of [
    (meta) => {
      meta.version = 1;
    },
    (meta) => {
      delete meta.audioReferences;
    },
    (meta) => {
      const entry = { key: 'a.wav', name: 'a.wav', size: 1, lastModified: 123 };
      meta.audioReferences = [entry, entry];
    },
  ])
    await assert.rejects(
      repo.importBundle(await rewriteBundle(bundle, mutate)),
      (error) => error.code === 'CORRUPT',
    );
  assert.equal((await repo.listSessions()).length, 1);
  assert.deepEqual((await repo.loadSession(record.id)).record, record);
});

test('logical dataset identity and scoped decisions survive full-to-reference copies, reopen and bundle import', async (t) => {
  const repo = await createBrowserRepository({ mode: 'memory' });
  const controller = new WorkspaceController(repo, 60_000);
  t.after(() => controller.dispose());
  const input = inputs();
  const fullInput = {
    ...input,
    audioFiles: new Map(),
    state: {
      ...input.state,
      adoptedFolderLevels: [],
      group: { kind: 'category', column: 'group', a: 'A', b: 'B' },
    },
  };
  await controller.create(fullInput);
  const fullHash = controller.getSnapshot().active.record.datasetHash;
  const thresholdSetting = {
    scope: fullHash,
    selection: { kind: 'ok-rate', targetPercent: 13 },
  };
  const filterDecision = { scope: fullHash, filter: 'false-positive' };
  controller.setState('thresholdSetting', thresholdSetting);
  controller.setState('filterDecision', filterDecision);
  await controller.saveAsReference();
  let active = controller.getSnapshot().active;
  assert.notEqual(active.record.datasetHash, fullHash);
  assert.equal(active.record.logicalDatasetHash, fullHash);
  const stored = await repo.loadSession(active.record.id);
  assert.equal(stored.dataset.externalCSV.logicalDatasetHash, fullHash);
  assert.deepEqual(active.record.state.thresholdSetting, thresholdSetting);
  assert.deepEqual(active.record.state.filterDecision, filterDecision);
  await controller.saveAsCopy();
  assert.equal(
    controller.getSnapshot().active.record.logicalDatasetHash,
    fullHash,
  );
  const bundle = await controller.exportBundle();
  await controller.importBundle(bundle);
  assert.equal(
    controller.getSnapshot().pendingResume.record.logicalDatasetHash,
    fullHash,
  );
  await controller.resumeReference(input.dataset, input.source);
  active = controller.getSnapshot().active;
  assert.equal(active.record.logicalDatasetHash, fullHash);
  assert.deepEqual(active.record.state.thresholdSetting, thresholdSetting);
  assert.deepEqual(active.record.state.filterDecision, filterDecision);
  const next = new WorkspaceController(repo, 60_000);
  await next.open(active.record.id);
  await next.resumeReference(input.dataset, input.source);
  assert.equal(next.getSnapshot().active.record.logicalDatasetHash, fullHash);
  next.dispose();
  // A fresh reference has the same parsed-data identity as a full save.
  const freshRepo = await createBrowserRepository({ mode: 'memory' });
  const fresh = new WorkspaceController(freshRepo, 60_000);
  t.after(() => fresh.dispose());
  await fresh.create(fullInput, true);
  assert.equal(fresh.getSnapshot().active.record.logicalDatasetHash, fullHash);
  const freshBundle = await fresh.exportBundle();
  await assert.rejects(
    freshRepo.importBundle(
      await rewriteBundle(freshBundle, (header) => {
        header.dataset.externalCSV.logicalDatasetHash = 'f'.repeat(64);
      }),
    ),
    { code: 'CORRUPT' },
  );
  await assert.rejects(
    freshRepo.importBundle(
      await rewriteBundle(freshBundle, (header) => {
        header.dataset.externalCSV.logicalDatasetHash = 'invalid';
      }),
    ),
    { code: 'CORRUPT' },
  );
});

test('legacy references remain readable and mismatched logical identity metadata is rejected', async (t) => {
  const env = fixture();
  const repo = await createBrowserRepository(env.options);
  t.after(() => repo.close());
  const input = inputs();
  const { sha256, encodeJSON } =
    await import('../../packages/browser-storage/validation.ts');
  const legacyInput = {
    title: 'legacy reference',
    dataset: {
      ...input.dataset,
      rows: [],
      externalCSV: {
        hash: await sha256(await input.source.arrayBuffer()),
        size: input.source.size,
        rowCount: 2,
      },
    },
    state: {},
    audioReferences: [],
  };
  const legacy = await repo.createSession(legacyInput);
  assert.equal(
    (await repo.loadSession(legacy.id)).record.logicalDatasetHash,
    undefined,
  );
  assert.equal(logicalDatasetHash(legacy), legacy.datasetHash);
  const imported = await repo.importBundle(await repo.exportBundle(legacy.id));
  assert.equal(logicalDatasetHash(imported.record), legacy.datasetHash);
  const logicalHash = await sha256(encodeJSON(input.dataset));
  const modern = await repo.createSession({
    ...legacyInput,
    dataset: {
      ...legacyInput.dataset,
      externalCSV: {
        ...legacyInput.dataset.externalCSV,
        logicalDatasetHash: logicalHash,
      },
    },
  });
  const db = await rawDatabase(env);
  t.after(() => db.close());
  // This syntactically valid but inconsistent record must not change population scopes.
  await rawTransaction(db, ['sessions'], (tx) =>
    tx.objectStore('sessions').put({
      ...modern,
      logicalDatasetHash: 'f'.repeat(64),
    }),
  );
  await assert.rejects(repo.loadSession(modern.id), { code: 'CORRUPT' });
  assert.equal((await repo.loadSession(legacy.id)).record.id, legacy.id);
});

test('partial reference folders can add distinct paths sharing the same WAV basename', async (t) => {
  const env = fixture();
  const repo = await createBrowserRepository(env.options);
  const controller = new WorkspaceController(repo, 60_000);
  t.after(() => controller.dispose());
  const input = inputs();
  const rows = input.dataset.rows.map((row) => ({
    ...row,
    audio_file: row.group + '/sample.wav',
  }));
  const dataset = { ...input.dataset, rows };
  const source = new File(
    [
      dataset.columns.join(',') +
        '\n' +
        rows
          .map((row) => dataset.columns.map((c) => row[c]).join(','))
          .join('\n'),
    ],
    dataset.name,
  );
  const first = new File(['first'], 'sample.wav', { lastModified: 11 });
  const second = new File(['other recording'], 'sample.wav', {
    lastModified: 22,
  });
  await controller.create(
    {
      ...input,
      dataset,
      source,
      audioFiles: new Map([['A/sample.wav', first]]),
    },
    true,
  );
  const original = controller.getSnapshot().active.record.audioReferences[0];
  await controller.importBundle(await controller.exportBundle());
  await controller.resumeReference(dataset, source);
  controller.updateAudio(new Map([['B/sample.wav', second]]));
  await controller.flush();
  const active = controller.getSnapshot().active;
  assert.equal(active.record.audioReferences.length, 2);
  assert.deepEqual(
    active.record.audioReferences.find((ref) => ref.key === 'A/sample.wav'),
    original,
  );
  assert.equal(
    findAudio(rows[0], 0, 'id', 'audio_file', active.audioFiles),
    undefined,
  );
  assert.equal(
    findAudio(rows[1], 1, 'id', 'audio_file', active.audioFiles),
    second,
  );
  assert.deepEqual(
    datasetRows(
      withFolderAttributes(
        active.dataset,
        'id',
        'audio_file',
        inputMembership(active),
        [1],
      ),
    ).map((row) => row['WAVフォルダ階層1']),
    ['A', 'B'],
  );
  controller.updateAudio(
    new Map([
      ['A/sample.wav', first],
      ['B/sample.wav', second],
    ]),
  );
  await controller.flush();
  assert.equal(controller.getSnapshot().active.audioFiles.size, 2);
  assert.equal(
    (await repo.loadSession(active.record.id)).record.audioReferences.length,
    2,
  );
  assert.equal(
    controller.getSnapshot().active.record.state.notes[1],
    '調査メモ',
  );
  assert.equal(env.files().length, 0);
});

test('discarding a conflicting reference draft drops unmatched/unsaved WAVs and keeps matching saved bindings', async (t) => {
  const env = fixture();
  const firstRepo = await createBrowserRepository(env.options);
  const first = new WorkspaceController(firstRepo, 60_000);
  const input = inputs();
  const stable = input.audioFiles.get('B/b.wav');
  await first.create(
    { ...input, audioFiles: new Map([['B/b.wav', stable]]) },
    true,
  );
  const id = first.getSnapshot().active.record.id;
  const secondRepo = await createBrowserRepository(env.options);
  const second = new WorkspaceController(secondRepo, 60_000);
  t.after(() => {
    first.dispose();
    second.dispose();
  });
  await second.open(id);
  await second.resumeReference(input.dataset, input.source);
  const saved = new File(['saved recording'], 'a.wav', { lastModified: 10 });
  const conflicting = new File(['different local recording'], 'a.wav', {
    lastModified: 20,
  });
  const extra = new File(['unsaved'], 'extra.wav', { lastModified: 30 });
  first.updateAudio(
    new Map([
      ['A/a.wav', saved],
      ['B/b.wav', stable],
    ]),
  );
  first.setState('notes', { 1: 'saved in first tab' });
  second.updateAudio(
    new Map([
      ['A/a.wav', conflicting],
      ['B/b.wav', stable],
      ['C/extra.wav', extra],
    ]),
  );
  second.setState('notes', { 1: 'discard this draft' });
  await first.flush();
  await assert.rejects(second.flush(), { code: 'CONFLICT' });
  assert.equal(second.getSnapshot().conflict, true);
  await second.reloadSaved();
  const active = second.getSnapshot().active;
  assert.equal(second.getSnapshot().status, 'saved');
  assert.equal(second.getSnapshot().conflict, false);
  assert.deepEqual([...active.audioFiles.keys()], ['B/b.wav']);
  assert.equal(active.audioFiles.get('B/b.wav'), stable);
  assert.equal(
    findAudio(input.dataset.rows[0], 0, 'id', 'audio_file', active.audioFiles),
    undefined,
  );
  assert.equal(active.record.state.notes[1], 'saved in first tab');
  assert.equal(
    active.record.audioReferences.find((ref) => ref.key === 'A/a.wav').size,
    saved.size,
  );
  assert.ok(inputMembership(active).has('A/a.wav'));
  assert.equal(
    active.record.audioReferences.some((ref) => ref.key === 'C/extra.wav'),
    false,
  );
  assert.equal(env.files().length, 0);
});

test('new paths cannot make a specifically saved basename row binding ambiguous', async (t) => {
  const repo = await createBrowserRepository({ mode: 'memory' });
  const controller = new WorkspaceController(repo, 60_000);
  t.after(() => controller.dispose());
  const input = inputs();
  const rows = input.dataset.rows.map((row) => ({
    ...row,
    audio_file: row.audio_file.split('/').at(-1),
  }));
  const dataset = { ...input.dataset, rows };
  const source = new File(
    [
      dataset.columns.join(',') +
        '\n' +
        rows
          .map((row) => dataset.columns.map((c) => row[c]).join(','))
          .join('\n'),
    ],
    dataset.name,
  );
  await controller.create({ ...input, dataset, source }, true);
  await controller.importBundle(await controller.exportBundle());
  await controller.resumeReference(dataset, source);
  assert.throws(
    () =>
      controller.updateAudio(
        new Map([['C/a.wav', new File(['other'], 'a.wav')]]),
      ),
    /保存済み対応/,
  );
  assert.equal(controller.getSnapshot().active.audioFiles.size, 0);
  assert.equal(
    controller.getSnapshot().active.record.audioReferences.length,
    2,
  );
  assert.equal(controller.getSnapshot().status, 'saved');
});
