import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserRepository } from '../../packages/browser-storage/index.ts';
import { WorkspaceController } from '../../src/state/workspace-controller.ts';
import { inputMembership } from '../../src/state/input-references.ts';
import { withFolderAttributes } from '../../packages/domain/audio-import.ts';
import { datasetRows } from '../../packages/domain/dataset-rows.ts';
import { deferred, fixture, rewriteBundle } from './storage-helpers.mjs';

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
  assert.throws(
    () =>
      controller.updateAudio(
        new Map([['a.wav', input.audioFiles.get('A/a.wav')]]),
      ),
    /相対パスが保存時と異なります/,
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
