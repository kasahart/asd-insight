import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBObjectStore } from 'fake-indexeddb';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import {
  createBrowserRepository,
  LIMITS,
} from '../../packages/browser-storage/index.ts';
import { validateApplicationState } from '../../src/state/workspace-controller.ts';
import {
  deferred,
  fixture,
  input,
  rawDatabase,
  rawTransaction,
  rewriteBundle,
} from './storage-helpers.mjs';

const code = (expected) => (error) => error.code === expected;
const bytes = async (file) => [...new Uint8Array(await file.arrayBuffer())];
const contentHash = async (file) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', await file.arrayBuffer()),
    ),
    (part) => part.toString(16).padStart(2, '0'),
  ).join('');

// Use the same public initializer as the session manager. Bundle this small
// module so the test can resolve the app's @domain alias under Node directly.
const productionRoot = fileURLToPath(new URL('../../', import.meta.url));
const initializerBundle = await build({
  stdin: {
    contents:
      "export { createDatasetCandidate, initialWorkspaceState } from './src/lib/dataset-import.ts';",
    loader: 'ts',
    resolveDir: productionRoot,
  },
  absWorkingDir: productionRoot,
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'silent',
});
const { createDatasetCandidate, initialWorkspaceState } = await import(
  `data:text/javascript,${encodeURIComponent(initializerBundle.outputFiles[0].text)}`
);

const audioAnalysis = (sourceName, sourceHash, duration) => ({
  sampleRate: 16_000,
  channels: 1,
  duration,
  recipe: { fft: 2048, window: 'hann' },
  runtimeLockHash: 'a'.repeat(64),
  sourceName,
  sourceHash,
});
const rangePreference = (range, minInput, maxInput) => ({
  range,
  minInput,
  maxInput,
  draftStarted: true,
});
const wavFile = (values, name, lastModified) =>
  new File([new Uint8Array(values)], name, {
    type: 'audio/wav',
    lastModified,
  });

function persistenceState(dataset, audioHashes) {
  const profiles = dataset.columns.map((column) => ({
    column,
    numeric: column === 'score' || column === 'score2',
    values: dataset.rows.map((row) => row[column]),
  }));
  const initial = initialWorkspaceState(
    createDatasetCandidate(dataset, profiles),
  );
  const group = initial.group;
  const decision = {
    scoreColumn: 'score',
    group,
    filter: null,
    okGroup: 'A',
    scoreDirection: 'high',
    threshold: {
      method: 'ok-rate',
      targetPercent: 1,
      rule: { threshold: 0.5, operator: 'gt', direction: 'high' },
      referenceCount: 1,
      detectedCount: 1,
      actualPercent: 100,
    },
    before: {
      nA: 1,
      nB: 1,
      total: 2,
      prAuc: 0.75,
      positiveFraction: 0.5,
      okGroup: 'A',
      positiveGroup: 'B',
      scoreDirection: 'high',
    },
  };
  const excluded = {
    rowIndex: 1,
    reason: 'exclude second sample',
    at: '2026-08-31T00:00:00.000Z',
    groupColumn: 'group',
    groupValue: 'B',
    decision,
  };
  return {
    ...initial,
    notes: { 0: 'keep first note', 1: 'keep excluded note' },
    reviewRecords: { 1: excluded },
    reviewHistory: [{ ...excluded, action: 'ignore' }],
    disclosures: { distribution: true, details: false },
    audioPreferences: {
      volume: 0.5,
      muted: false,
      playbackRate: 1.25,
      gainDb: 6,
    },
    inspectorWidth: 360,
    spectrogramPreferences: {
      time: rangePreference({ min: 0, max: 1 }, '0', '1'),
      frequency: rangePreference({ min: 0, max: 8 }, '0', '8'),
      color: rangePreference({ min: -90, max: 0 }, '-90', '0'),
    },
    tableSorting: [{ id: 'comparison-score:score2', desc: true }],
    pagination: { pageIndex: 0, pageSize: 8 },
    viewport: null,
    thresholdSetting: {
      scope: 'review-scope',
      selection: { kind: 'ok-rate', targetPercent: 1 },
    },
    filterDecision: { filter: 'ignored', scope: 'review-scope' },
    inspectorSelection: { target: 'sample', focus: true },
    audioAnalyses: {
      0: audioAnalysis('s1.wav', audioHashes.s1, 1),
      1: audioAnalysis('s2.wav', audioHashes.s2, 1.5),
    },
  };
}

async function persistenceInput() {
  const dataset = {
    name: 'two-audio.csv',
    columns: ['sample_id', 'score', 'score2', 'group', 'audio_file'],
    rows: [
      {
        sample_id: 's1',
        score: '0.25',
        score2: '0.3',
        group: 'A',
        audio_file: 's1.wav',
      },
      {
        sample_id: 's2',
        score: '0.75',
        score2: '0.7',
        group: 'B',
        audio_file: 's2.wav',
      },
    ],
    demo: false,
  };
  const audioFiles = new Map([
    ['s1', wavFile([82, 73, 70, 70, 1, 2, 3, 4], 's1.wav', 2000)],
    ['s2', wavFile([82, 73, 70, 70, 9, 8, 7, 6], 's2.wav', 3000)],
  ]);
  return {
    title: 'Persistent review',
    dataset,
    source: new File(
      [
        'sample_id,score,score2,group,audio_file\r\n' +
          's1,0.25,0.3,A,s1.wav\r\n' +
          's2,0.75,0.7,B,s2.wav\r\n',
      ],
      'two-audio.csv',
      { type: 'text/csv', lastModified: 1000 },
    ),
    state: persistenceState(dataset, {
      s1: await contentHash(audioFiles.get('s1')),
      s2: await contentHash(audioFiles.get('s2')),
    }),
    audioFiles,
  };
}

test('persistent mode requires explicit capabilities; memory mode is opt-in and never promises persistence', async () => {
  await assert.rejects(
    createBrowserRepository({ indexedDB: {} }),
    code('UNAVAILABLE'),
  );
  const repo = await createBrowserRepository({ mode: 'memory' });
  assert.equal(repo.mode, 'memory');
  assert.equal(repo.capabilities.persistentStorageGranted, false);
  assert.equal(await repo.requestPersistence(), false);
  const record = await repo.createSession(input());
  assert.equal((await repo.listSessions())[0].id, record.id);
  repo.close();
  await assert.rejects(repo.loadSession(record.id), code('CLOSED'));
  const fresh = await createBrowserRepository({ mode: 'memory' });
  assert.deepEqual(await fresh.listSessions(), []);
  fresh.close();
});

test('IDB and OPFS preserve immutable source bytes, audio bindings, generic state and restart identity', async () => {
  const env = fixture();
  const repo = await createBrowserRepository(env.options);
  const original = input();
  const record = await repo.createSession(original);
  original.dataset.rows[0].score = '999';
  original.state.notes.s1 = 'mutated outside';
  const loaded = await repo.loadSession(record.id);
  assert.equal(record.revision, 1);
  assert.equal(loaded.dataset.rows[0].score, '0.25');
  assert.equal(loaded.record.state.notes.s1, 'check');
  assert.equal(
    await loaded.source.text(),
    'sample_id,score,group\r\ns1,0.25,A\r\n',
  );
  assert.equal(loaded.source.lastModified, 1000);
  assert.deepEqual(
    await bytes(loaded.audioFiles.get('s1')),
    [82, 73, 70, 70, 1, 2, 3, 4],
  );
  assert.match(record.source.hash, /^[a-f0-9]{64}$/);
  repo.close();
  const reopened = await createBrowserRepository(env.options);
  assert.deepEqual((await reopened.loadSession(record.id)).record, record);
  assert.equal(env.files().length, 2);
  reopened.close();
});

test('same filename creates independent datasets and import always creates a fresh session', async () => {
  const repo = await createBrowserRepository({ mode: 'memory' });
  const first = await repo.createSession(input());
  const other = input();
  other.dataset.rows[0].score = '0.9';
  const second = await repo.createSession(other);
  const restored = await repo.importBundle(await repo.exportBundle(first.id));
  assert.equal(new Set([first.id, second.id, restored.record.id]).size, 3);
  assert.equal(
    new Set([
      first.datasetVersionId,
      second.datasetVersionId,
      restored.record.datasetVersionId,
    ]).size,
    3,
  );
  assert.notEqual(first.datasetHash, second.datasetHash);
  assert.equal(restored.record.datasetHash, first.datasetHash);
  assert.equal(restored.record.revision, 1);
  repo.close();
});

test('bundle round trip preserves the complete review state, source and two audio bindings without changing the original', async () => {
  const env = fixture();
  const repo = await createBrowserRepository(env.options);
  const original = await repo.createSession(await persistenceInput());
  const before = await repo.loadSession(original.id);
  validateApplicationState(
    before.record.state,
    before.dataset.rows.length,
    before.dataset.columns,
  );
  const bundle = await repo.exportBundle(original.id);
  const restored = await repo.importBundle(bundle);

  assert.notEqual(restored.record.id, original.id);
  assert.notEqual(restored.record.datasetVersionId, original.datasetVersionId);
  assert.deepEqual(restored.dataset, before.dataset);
  assert.deepEqual(restored.record.state, before.record.state);
  assert.equal(restored.record.state.viewport, null);
  assert.deepEqual(restored.record.state.notes, {
    0: 'keep first note',
    1: 'keep excluded note',
  });
  assert.equal(restored.record.state.reviewRecords[1].rowIndex, 1);
  validateApplicationState(
    restored.record.state,
    restored.dataset.rows.length,
    restored.dataset.columns,
  );

  const after = await repo.loadSession(original.id);
  assert.deepEqual(after.record, before.record);
  assert.deepEqual(after.dataset, before.dataset);
  assert.deepEqual(await bytes(after.source), await bytes(before.source));
  assert.equal(await contentHash(after.source), before.record.source.hash);
  assert.equal(restored.record.source.hash, before.record.source.hash);
  assert.deepEqual(await bytes(restored.source), await bytes(before.source));
  assert.equal(await contentHash(restored.source), restored.record.source.hash);

  assert.deepEqual([...restored.audioFiles.keys()].sort(), ['s1', 's2']);
  for (const key of ['s1', 's2']) {
    const originalAsset = before.record.audio[key];
    const restoredAsset = restored.record.audio[key];
    assert.equal(restoredAsset.hash, originalAsset.hash);
    assert.deepEqual(
      await bytes(restored.audioFiles.get(key)),
      await bytes(before.audioFiles.get(key)),
    );
    assert.equal(
      await contentHash(restored.audioFiles.get(key)),
      restoredAsset.hash,
    );
    assert.deepEqual(
      await bytes(after.audioFiles.get(key)),
      await bytes(before.audioFiles.get(key)),
    );
    assert.equal(
      await contentHash(after.audioFiles.get(key)),
      before.record.audio[key].hash,
    );
  }

  const ids = (await repo.listSessions()).map(({ id }) => id);
  assert.equal(ids.length, 2);
  assert.deepEqual(new Set(ids), new Set([original.id, restored.record.id]));
  repo.close();
});

test('import that exceeds total capacity leaves the existing persistent analysis and assets unchanged', async () => {
  const env = fixture();
  const producer = await createBrowserRepository(env.options);
  const original = await producer.createSession(await persistenceInput());
  const bundle = await producer.exportBundle(original.id);
  producer.close();

  const repo = await createBrowserRepository({
    ...env.options,
    maxBundleBytes: original.bundleBytes,
    maxTotalBytes: original.bundleBytes,
  });
  const filesBefore = env
    .files()
    .map((file) => file.name)
    .sort();
  assert.deepEqual(await repo.listSessions(), [original]);
  await assert.rejects(repo.importBundle(bundle), code('QUOTA'));
  assert.deepEqual(await repo.listSessions(), [original]);
  assert.deepEqual(
    env
      .files()
      .map((file) => file.name)
      .sort(),
    filesBefore,
  );
  assert.deepEqual((await repo.loadSession(original.id)).record, original);
  repo.close();
});

test('concurrent tabs atomically reject stale revisions and operation retries never reapply old state', async () => {
  const env = fixture();
  const a = await createBrowserRepository(env.options);
  const b = await createBrowserRepository(env.options);
  const first = await a.createSession(input());
  const [one, two] = await Promise.allSettled([
    a.saveSession(first.id, {
      expectedRevision: 1,
      operationId: 'first',
      state: { value: 'one' },
    }),
    b.saveSession(first.id, {
      expectedRevision: 1,
      operationId: 'second',
      state: { value: 'two' },
    }),
  ]);
  assert.equal(one.status, 'fulfilled');
  assert.equal(two.status, 'rejected');
  assert.equal(two.reason.code, 'CONFLICT');
  const retry = await b.saveSession(first.id, {
    expectedRevision: 1,
    operationId: 'first',
    state: { value: 'one' },
  });
  assert.equal(retry.revision, 2);
  const latest = await b.saveSession(first.id, {
    expectedRevision: 2,
    operationId: 'third',
    state: { value: 'three' },
  });
  const delayedRetry = await a.saveSession(first.id, {
    expectedRevision: 1,
    operationId: 'first',
    state: { value: 'one' },
  });
  assert.equal(delayedRetry.revision, latest.revision);
  assert.deepEqual(delayedRetry.state, { value: 'three' });
  await assert.rejects(
    a.saveSession(first.id, {
      expectedRevision: 1,
      operationId: 'first',
      state: { value: 'different' },
    }),
    code('CONFLICT'),
  );
  a.close();
  b.close();
});

test('audio replacement is explicit, omitted bindings survive, and source is immutable', async () => {
  const repo = await createBrowserRepository({ mode: 'memory' });
  const initial = await repo.createSession(input());
  const saved = await repo.saveSession(initial.id, {
    expectedRevision: 1,
    operationId: 'note',
    state: { note: 'new' },
  });
  assert.deepEqual(saved.audio, initial.audio);
  const replacement = new File(['new sound'], 'other.wav', { lastModified: 9 });
  const changed = await repo.saveSession(initial.id, {
    expectedRevision: 2,
    operationId: 'audio',
    state: saved.state,
    audioFiles: new Map([['s1', replacement]]),
  });
  assert.equal(changed.source.hash, initial.source.hash);
  assert.equal(
    await (await repo.loadSession(initial.id)).audioFiles.get('s1').text(),
    'new sound',
  );
  const cleared = await repo.saveSession(initial.id, {
    expectedRevision: 3,
    operationId: 'clear',
    state: {},
    audioFiles: new Map(),
  });
  assert.deepEqual(cleared.audio, {});
  assert.ok((await repo.collectOrphans()).removed >= 2);
  repo.close();
});

test('source write failure does not commit metadata or downgrade persistent storage', async () => {
  const env = fixture();
  const repo = await createBrowserRepository(env.options);
  const existing = await repo.createSession(input());
  env.control.writeError = new DOMException('Disk full', 'QuotaExceededError');
  await assert.rejects(
    repo.createSession(input({ title: 'will fail' })),
    code('QUOTA'),
  );
  assert.equal(repo.mode, 'persistent');
  assert.equal((await repo.listSessions()).length, 1);
  assert.deepEqual((await repo.loadSession(existing.id)).record, existing);
  assert.equal((await repo.collectOrphans()).removed, 1);
  repo.close();
});

test('failed replacement and truncated OPFS writes leave the committed revision and audio intact', async () => {
  const env = fixture();
  const repo = await createBrowserRepository(env.options);
  const record = await repo.createSession(input());
  env.control.closeError = new DOMException(
    'Disk full on close',
    'QuotaExceededError',
  );
  await assert.rejects(
    repo.saveSession(record.id, {
      expectedRevision: 1,
      operationId: 'bad-audio',
      state: { bad: true },
      audioFiles: new Map([['s1', new File(['changed'], 'changed.wav')]]),
    }),
    code('QUOTA'),
  );
  assert.deepEqual((await repo.loadSession(record.id)).record, record);
  env.control.truncateWrite = true;
  await assert.rejects(repo.createSession(input()), code('CORRUPT'));
  env.control.truncateWrite = false;
  assert.equal((await repo.listSessions()).length, 1);
  assert.equal((await repo.collectOrphans()).removed, 2);
  repo.close();
});

test('IDB failure rolls back dataset and session together; unreferenced assets are recovered on restart', async () => {
  const env = fixture();
  const repo = await createBrowserRepository(env.options);
  const add = IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add = function (value, ...args) {
    if (this.name === 'sessions')
      throw new DOMException('Quota during commit', 'QuotaExceededError');
    return add.call(this, value, ...args);
  };
  try {
    await assert.rejects(repo.createSession(input()), code('QUOTA'));
  } finally {
    IDBObjectStore.prototype.add = add;
  }
  assert.deepEqual(await repo.listSessions(), []);
  const db = await rawDatabase(env);
  const count = await new Promise((resolve) => {
    const request = db.transaction('datasets').objectStore('datasets').count();
    request.onsuccess = () => resolve(request.result);
  });
  assert.equal(count, 0);
  db.close();
  assert.equal(env.files().length, 2);
  repo.close();
  const reopened = await createBrowserRepository(env.options);
  assert.equal(env.files().length, 0);
  reopened.close();
});

test('operation-log failure rolls back an already queued state update and allows an identical retry', async () => {
  const env = fixture();
  const repo = await createBrowserRepository(env.options);
  const record = await repo.createSession(input());
  const save = {
    expectedRevision: 1,
    operationId: 'failed-commit',
    state: { notes: { s1: 'new' } },
  };
  const add = IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add = function (value, ...args) {
    if (this.name === 'operations')
      throw new DOMException('Quota after state put', 'QuotaExceededError');
    return add.call(this, value, ...args);
  };
  try {
    await assert.rejects(repo.saveSession(record.id, save), code('QUOTA'));
  } finally {
    IDBObjectStore.prototype.add = add;
  }
  assert.deepEqual((await repo.loadSession(record.id)).record, record);
  const committed = await repo.saveSession(record.id, save);
  assert.equal(committed.revision, 2);
  assert.deepEqual(committed.state, save.state);
  assert.equal((await repo.saveSession(record.id, save)).revision, 2);
  repo.close();
});

test('hash corruption and missing references fail visibly instead of returning partial data', async () => {
  const env = fixture();
  const repo = await createBrowserRepository(env.options);
  const record = await repo.createSession(input());
  const backup = await repo.exportBundle(record.id);
  env.files().find((file) => file.name === record.audio.s1.storageName).blob =
    new Blob(['tampered']); // same length: verifies content hash, not only size
  await assert.rejects(repo.loadSession(record.id), code('CORRUPT'));
  await assert.rejects(repo.exportBundle(record.id), code('CORRUPT'));
  const restored = await repo.importBundle(backup);
  assert.notEqual(restored.record.id, record.id);
  assert.deepEqual(
    await bytes(restored.audioFiles.get('s1')),
    [82, 73, 70, 70, 1, 2, 3, 4],
  );
  assert.equal((await repo.listSessions()).length, 2);
  repo.close();
});

test('missing OPFS assets are diagnosed and stale deletion cannot erase a newer revision', async () => {
  const env = fixture();
  const repo = await createBrowserRepository(env.options);
  const record = await repo.createSession(input());
  const changed = await repo.saveSession(record.id, {
    expectedRevision: 1,
    operationId: 'saved',
    state: { value: 1 },
  });
  await assert.rejects(repo.deleteSession(record.id, 1), code('CONFLICT'));
  const remove = (directory) => {
    for (const [name, entry] of directory.children) {
      if (name === record.source.storageName) directory.children.delete(name);
      else if (entry.kind === 'directory') remove(entry);
    }
  };
  remove(env.root);
  await assert.rejects(repo.loadSession(record.id), code('CORRUPT'));
  assert.equal((await repo.listSessions())[0].revision, changed.revision);
  repo.close();
});

test('state rejects non-JSON coercions and nonfinite numbers without committing', async () => {
  const repo = await createBrowserRepository({ mode: 'memory' });
  const record = await repo.createSession(input());
  const circular = {};
  circular.self = circular;
  const accessor = {};
  Object.defineProperty(accessor, 'secret', {
    enumerable: true,
    get() {
      throw new Error('must not execute');
    },
  });
  for (const state of [
    { x: NaN },
    { x: Infinity },
    { x: undefined },
    { x: new Map() },
    { x: 1n },
    { x: new Date() },
    { x: [, 1] },
    circular,
    accessor,
  ]) {
    await assert.rejects(
      repo.saveSession(record.id, {
        expectedRevision: 1,
        operationId: crypto.randomUUID(),
        state,
      }),
      code('VALIDATION'),
    );
  }
  assert.deepEqual((await repo.loadSession(record.id)).record, record);
  repo.close();
});

test('complete bundle limit rejects oversized creates and saves; total capacity preserves existing sessions', async () => {
  const baseline = await createBrowserRepository({ mode: 'memory' });
  const record = await baseline.createSession(input());
  const bytes = record.bundleBytes;
  baseline.close();
  const repo = await createBrowserRepository({
    mode: 'memory',
    maxBundleBytes: bytes + 32,
    maxTotalBytes: bytes + 32,
  });
  const first = await repo.createSession(input());
  await assert.rejects(repo.createSession(input()), code('QUOTA'));
  await assert.rejects(
    repo.saveSession(first.id, {
      expectedRevision: 1,
      operationId: 'too-big',
      state: { large: 'x'.repeat(1000) },
    }),
    code('QUOTA'),
  );
  assert.deepEqual((await repo.loadSession(first.id)).record, first);
  assert.ok((await repo.exportBundle(first.id)).size <= bytes + 32);
  await assert.rejects(
    createBrowserRepository({
      mode: 'memory',
      maxBundleBytes: LIMITS.bundleBytes + 1,
    }),
    code('VALIDATION'),
  );
  repo.close();
});

test('bundle import rejects malformed schema, duplicate/unknown entries, truncation, hash mismatch and trailing bytes atomically', async () => {
  const repo = await createBrowserRepository({ mode: 'memory' });
  const record = await repo.createSession(input());
  const bundle = await repo.exportBundle(record.id);
  const variants = [
    new Blob(['not a bundle']),
    bundle.slice(0, bundle.size - 1),
    new Blob([bundle, 'trailing']),
    await rewriteBundle(bundle, (meta) => {
      meta.version = 99;
    }),
    await rewriteBundle(bundle, (meta) => {
      meta.assets[0].path = '../existing.csv';
    }),
    await rewriteBundle(bundle, (meta) => {
      meta.assets.push(meta.assets[0]);
    }),
    await rewriteBundle(bundle, (meta) => {
      meta.audio.push(meta.audio[0]);
    }),
    await rewriteBundle(bundle, (meta) => {
      meta.assets[0].size += 1;
    }),
    await rewriteBundle(bundle, (meta) => {
      meta.dataset.rows[0].score = '999';
    }),
    await rewriteBundle(bundle, (meta) => {
      meta.state = null;
    }),
    await rewriteBundle(bundle, (meta) => {
      meta.extra = 'unknown';
    }),
    await rewriteBundle(
      bundle,
      () => {},
      (body) => new Blob([new Uint8Array([255]), body.slice(1)]),
    ),
  ];
  for (const value of variants) {
    await assert.rejects(repo.importBundle(value), code('CORRUPT'));
    assert.deepEqual(await repo.listSessions(), [record]);
  }
  repo.close();
});

test('literal prototype-like keys and formula-looking strings survive backup without execution or coercion', async () => {
  const repo = await createBrowserRepository({ mode: 'memory' });
  const data = input({
    dataset: {
      name: 'literal.csv',
      columns: ['__proto__', 'constructor'],
      rows: [JSON.parse('{"__proto__":"literal","constructor":"=SUM(1,2)"}')],
      demo: false,
    },
    state: Object.fromEntries([
      ['__proto__', { polluted: 'no' }],
      ['note', '=HYPERLINK("x")'],
    ]),
    audioFiles: new Map([
      [
        '__proto__',
        new File(['literal sound'], '../name.wav', { lastModified: 0 }),
      ],
    ]),
  });
  const first = await repo.createSession(data);
  const restored = await repo.importBundle(await repo.exportBundle(first.id));
  assert.equal(restored.dataset.rows[0].__proto__, 'literal');
  assert.equal(restored.dataset.rows[0].constructor, '=SUM(1,2)');
  assert.deepEqual(restored.record.state.__proto__, { polluted: 'no' });
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(
    await restored.audioFiles.get('__proto__').text(),
    'literal sound',
  );
  repo.close();
});

test('persistence requests report the actual grant without switching mode', async () => {
  const env = fixture();
  const repo = await createBrowserRepository(env.options);
  assert.equal(repo.capabilities.persistentStorageGranted, false);
  assert.equal(await repo.requestPersistence(), true);
  assert.equal(repo.capabilities.persistentStorageGranted, true);
  env.options.storageManager.persist = async () => false;
  assert.equal(await repo.requestPersistence(), false);
  assert.equal(repo.capabilities.persistentStorageGranted, false);
  assert.equal(repo.mode, 'persistent');
  repo.close();
});

test('opening another tab cannot collect a file that is still being committed', async () => {
  const env = fixture();
  const a = await createBrowserRepository(env.options);
  const entered = deferred();
  const release = deferred();
  let once = false;
  env.control.beforeClose = async () => {
    if (!once) {
      once = true;
      entered.resolve();
      await release.promise;
    }
  };
  const creating = a.createSession(input());
  await entered.promise;
  const opening = createBrowserRepository(env.options);
  release.resolve();
  const record = await creating;
  const b = await opening;
  assert.equal(env.files().length, 2);
  assert.deepEqual((await b.loadSession(record.id)).record, record);
  a.close();
  b.close();
});

test('bundle snapshot holds assets across another tab deletion and garbage collection', async () => {
  const env = fixture();
  const a = await createBrowserRepository(env.options);
  const b = await createBrowserRepository(env.options);
  const record = await a.createSession(input());
  const entered = deferred();
  const release = deferred();
  let once = false;
  env.control.beforeRead = async () => {
    if (!once) {
      once = true;
      entered.resolve();
      await release.promise;
    }
  };
  const exporting = a.exportBundle(record.id);
  await entered.promise;
  const deleting = b.deleteSession(record.id, 1);
  release.resolve();
  const bundle = await exporting;
  await deleting;
  assert.equal((await b.collectOrphans()).removed, 2);
  const restored = await a.importBundle(bundle);
  assert.equal(restored.dataset.rows[0].score, '0.25');
  a.close();
  b.close();
});

test('closing during staging prevents metadata commit and a later open recovers only orphans', async () => {
  const env = fixture();
  const repo = await createBrowserRepository(env.options);
  const entered = deferred();
  const release = deferred();
  env.control.beforeClose = async () => {
    entered.resolve();
    await release.promise;
  };
  const creating = repo.createSession(input());
  await entered.promise;
  repo.close();
  release.resolve();
  await assert.rejects(creating, code('CLOSED'));
  env.control.beforeClose = null;
  const next = await createBrowserRepository(env.options);
  assert.deepEqual(await next.listSessions(), []);
  assert.equal(env.files().length, 0);
  next.close();
});

test('corrupt metadata cannot redirect OPFS reads or authorize garbage collection', async () => {
  const env = fixture();
  const repo = await createBrowserRepository(env.options);
  const record = await repo.createSession(input());
  const db = await rawDatabase(env);
  const bad = structuredClone(record);
  bad.source.storageName = '../secret';
  await rawTransaction(db, ['sessions'], (tx) =>
    tx.objectStore('sessions').put(bad),
  );
  await assert.rejects(repo.loadSession(record.id), code('CORRUPT'));
  await assert.rejects(repo.collectOrphans(), code('CORRUPT'));
  assert.equal(env.files().length, 2);
  db.close();
  repo.close();
});
