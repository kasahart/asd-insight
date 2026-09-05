import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { createBrowserRepository } from '../../packages/browser-storage/index.ts';
import {
  WorkspaceController,
  assertFiniteJson,
  validateApplicationState,
} from '../../src/state/workspace-controller.ts';
import { deferred, input } from './storage-helpers.mjs';

const state = () => ({
  schemaVersion: 1,
  rowCount: 1,
  score: 'score',
  idColumn: 'sample_id',
  group: { kind: 'category', column: 'group', a: 'A', b: 'B' },
  notes: {},
  query: '',
});
const clone = (value) => structuredClone(value);

async function setup(t, transform = (base) => base) {
  const base = await createBrowserRepository({ mode: 'memory' });
  const record = await base.createSession(input({ state: state() }));
  const repository = transform(base);
  const controller = new WorkspaceController(repository, 60_000);
  t.after(() => controller.dispose());
  await controller.open(record.id);
  return { base, repository, controller, record };
}

function completeState() {
  const group = { kind: 'category', column: 'group', a: 'A', b: 'B' };
  const decision = {
    scoreColumn: 'score',
    group,
    filter: null,
    okGroup: 'A',
    scoreDirection: 'high',
    threshold: {
      method: 'ok-rate',
      targetPercent: 1,
      rule: { threshold: 0.1, operator: 'gt', direction: 'high' },
      referenceCount: 1,
      detectedCount: 0,
      actualPercent: 0,
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
  const entry = {
    rowIndex: 0,
    reason: 'check',
    at: '2026-08-31T00:00:00.000Z',
    groupColumn: 'group',
    groupValue: 'A',
    decision,
  };
  return {
    ...state(),
    rowCount: 2,
    audioColumn: '',
    numericA: '',
    numericB: '',
    filterColumn: '',
    filterValue: '',
    bins: 24,
    method: false,
    range: { lo: 0, hi: 1, includeHi: true },
    overlapOnly: false,
    rangeLo: '',
    rangeHi: '1',
    selected: 0,
    notes: { 0: 'review' },
    okGroup: 'A',
    direction: 'high',
    targetPercent: '1',
    comparisonColumn: '',
    reviewRecords: { 0: entry },
    reviewHistory: [{ ...entry, action: 'ignore' }],
    disclosures: { details: false },
    audioPreferences: {
      volume: 0.35,
      muted: false,
      playbackRate: 1,
      gainDb: 12,
    },
    inspectorWidth: 320,
    spectrogramPreferences: {
      time: { range: null, minInput: '', maxInput: '' },
      frequency: {
        range: { min: 0, max: 8 },
        minInput: '0',
        maxInput: '8',
        draftStarted: true,
      },
      color: { range: { min: -90, max: 0 }, minInput: '-90', maxInput: '0' },
    },
    tableSorting: [{ id: 'comparison-score:score2', desc: true }],
    pagination: { pageIndex: 0, pageSize: 8 },
    viewport: {
      scoreColumn: 'score',
      selection: { mode: 'manual', extent: { min: 0, max: 1 } },
      lower: '0',
      upper: '1',
      error: '',
    },
    thresholdSetting: {
      scope: 'scope',
      selection: { kind: 'ok-rate', targetPercent: 1 },
    },
    filterDecision: { filter: 'false-positive', scope: 'scope' },
    inspectorSelection: { target: 'sample', focus: false },
    audioAnalyses: {
      0: {
        sampleRate: 16000,
        channels: 1,
        duration: 1,
        recipe: { fft: 2048, window: 'hann' },
        runtimeLockHash: 'a'.repeat(64),
        sourceName: 'sample.wav',
        sourceHash: 'b'.repeat(64),
      },
    },
  };
}
const columns = ['sample_id', 'score', 'score2', 'group'];

test('complete schema accepts deliberate string drafts, retained zero-width score selections and null defaults', () => {
  const value = completeState();
  validateApplicationState(value, 2, columns);
  value.range = { lo: 0, hi: 0, includeHi: true };
  value.viewport = null;
  value.thresholdSetting = null;
  value.selected = null;
  value.numericA = 'unfinished -';
  value.spectrogramPreferences.frequency = {
    range: null,
    minInput: '',
    maxInput: '',
    draftStarted: true,
  };
  validateApplicationState(value, 2, columns);
});

test('state schema rejects malformed nested fields before they reach UI consumers', () => {
  const mutations = [
    (s) => {
      s.schemaVersion = 2;
    },
    (s) => {
      s.unknownFutureField = true;
    },
    (s) => {
      s.rowCount = 3;
    },
    (s) => {
      s.bins = '24';
    },
    (s) => {
      s.selected = -1;
    },
    (s) => {
      s.selected = 2;
    },
    (s) => {
      s.selected = {};
    },
    (s) => {
      s.method = 'false';
    },
    (s) => {
      s.overlapOnly = 1;
    },
    (s) => {
      s.queryMode = 'starts-with';
    },
    (s) => {
      s.score = 'missing';
    },
    (s) => {
      s.idColumn = 'missing';
    },
    (s) => {
      s.notes = { '00': 'ambiguous' };
    },
    (s) => {
      s.notes = { 0: {} };
    },
    (s) => {
      s.group = null;
    },
    (s) => {
      s.group = { kind: 'category', column: 'group', a: null, b: 'B' };
    },
    (s) => {
      s.group = { kind: 'numeric', column: 'group', upperA: 0, lowerB: '2' };
    },
    (s) => {
      s.range = { lo: 0, hi: 1 };
    },
    (s) => {
      s.range = { lo: 2, hi: 1, includeHi: false };
    },
    (s) => {
      s.tableSorting = [null];
    },
    (s) => {
      s.tableSorting = [{ id: {}, desc: false }];
    },
    (s) => {
      s.tableSorting = [{ id: 'score', desc: 'no' }];
    },
    (s) => {
      s.tableSorting = [{ id: 'comparison-score:missing', desc: false }];
    },
    (s) => {
      s.tableSorting = [
        { id: 'score', desc: false },
        { id: 'score', desc: true },
      ];
    },
    (s) => {
      s.pagination = { pageIndex: -1, pageSize: 8 };
    },
    (s) => {
      s.pagination = { pageIndex: 0, pageSize: 0 };
    },
    (s) => {
      s.viewport.selection = null;
    },
    (s) => {
      s.viewport.selection = { mode: 'central', extent: null };
    },
    (s) => {
      s.viewport.selection = { mode: 'full', extent: { min: 0, max: 1 } };
    },
    (s) => {
      s.viewport.selection.extent.max = 0;
    },
    (s) => {
      s.viewport.lower = {};
    },
    (s) => {
      s.thresholdSetting.selection.kind = 'unknown';
    },
    (s) => {
      s.thresholdSetting.selection.targetPercent = 101;
    },
    (s) => {
      s.thresholdSetting.selection = {
        kind: 'manual',
        rule: { threshold: 1, operator: 'lt', direction: 'high' },
      };
    },
    (s) => {
      s.filterDecision.filter = 'typo';
    },
    (s) => {
      s.disclosures.details = 'open';
    },
    (s) => {
      s.audioPreferences.volume = 2;
    },
    (s) => {
      s.audioPreferences.playbackRate = 0;
    },
    (s) => {
      s.audioPreferences.gainDb = 100;
    },
    (s) => {
      s.inspectorWidth = 0;
    },
    (s) => {
      s.spectrogramPreferences.time = null;
    },
    (s) => {
      s.spectrogramPreferences.time.range = { min: -1, max: 1 };
    },
    (s) => {
      s.spectrogramPreferences.color.range = { min: 0, max: 0 };
    },
    (s) => {
      s.spectrogramPreferences.frequency.range.max = Number.MAX_VALUE;
    },
    (s) => {
      s.spectrogramPreferences.frequency.draftStarted = 'yes';
    },
    (s) => {
      s.reviewRecords[0].rowIndex = 1;
    },
    (s) => {
      s.reviewRecords[0].decision = {};
    },
    (s) => {
      s.reviewRecords[0].decision.before.total = 3;
    },
    (s) => {
      s.reviewHistory[0].action = 'delete';
    },
    (s) => {
      s.reviewHistory[0].decision.threshold.rule.direction = 'unknown';
    },
    (s) => {
      s.reviewHistory[0].decision.threshold.detectedCount = 2;
    },
    (s) => {
      s.reviewHistory[0].at = 'not a time';
    },
    (s) => {
      s.inspectorSelection.target = 'other';
    },
    (s) => {
      s.inspectorSelection.focus = 1;
    },
    (s) => {
      s.audioAnalyses[0].recipe = [];
    },
    (s) => {
      s.audioAnalyses[0].duration = 0;
    },
    (s) => {
      s.audioAnalyses[0].sourceHash = '../file';
    },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const value = clone(completeState());
    mutate(value);
    assert.throws(
      () => validateApplicationState(value, 2, columns),
      undefined,
      'mutation ' + index,
    );
  }
});

test('JSON validation rejects getters without executing them, sparse arrays, cycles and nonfinite values', () => {
  let called = false;
  const getter = Object.defineProperty({}, 'x', {
    enumerable: true,
    get() {
      called = true;
      return 1;
    },
  });
  const circular = {};
  circular.self = circular;
  for (const value of [
    getter,
    { x: undefined },
    { x: Infinity },
    { x: NaN },
    { x: [, 1] },
    { x: new Map() },
    circular,
  ])
    assert.throws(() => assertFiniteJson(value));
  assert.equal(called, false);
});

test('one in-flight flush drains newer edits without showing saved between the two commits', async (t) => {
  const first = deferred();
  const entered = deferred();
  const second = deferred();
  const secondEntered = deferred();
  const calls = [];
  const { base, controller, record } = await setup(t, (base) => ({
    ...base,
    async saveSession(id, value) {
      calls.push(clone(value));
      if (calls.length === 1) {
        entered.resolve();
        await first.promise;
      } else {
        secondEntered.resolve();
        await second.promise;
      }
      return base.saveSession(id, value);
    },
  }));
  controller.setState('query', 'first');
  const saving = controller.flush();
  await entered.promise;
  controller.setState('query', 'second');
  assert.strictEqual(controller.flush(), saving);
  first.resolve();
  await secondEntered.promise;
  assert.equal(controller.getSnapshot().status, 'saving');
  assert.equal(controller.getSnapshot().active.record.state.query, 'second');
  second.resolve();
  await saving;
  assert.equal(calls.length, 2);
  assert.equal(calls[0].state.query, 'first');
  assert.equal(calls[1].state.query, 'second');
  assert.equal(controller.getSnapshot().status, 'saved');
  assert.equal(
    (await base.loadSession(record.id)).record.state.query,
    'second',
  );
});

test('uncertain commit retries the same operation and payload before saving newer edits', async (t) => {
  const calls = [];
  const { base, controller, record } = await setup(t, (base) => ({
    ...base,
    async saveSession(id, value) {
      calls.push(clone(value));
      const result = await base.saveSession(id, value);
      if (calls.length === 1) throw new Error('response lost after commit');
      return result;
    },
  }));
  controller.setState('query', 'first');
  await assert.rejects(controller.flush(), /response lost/);
  controller.setState('query', 'second');
  await controller.flush();
  assert.equal(calls.length, 3);
  assert.equal(calls[0].operationId, calls[1].operationId);
  assert.deepEqual(calls[0].state, calls[1].state);
  assert.notEqual(calls[1].operationId, calls[2].operationId);
  assert.equal((await base.loadSession(record.id)).record.revision, 3);
  assert.equal(controller.getSnapshot().status, 'saved');
});

test('note-only saves omit audio I/O; changed audio survives a failed save and uses the same retry payload', async (t) => {
  const calls = [];
  let failAudio = true;
  const { controller } = await setup(t, (base) => ({
    ...base,
    async saveSession(id, value) {
      calls.push(value);
      if (value.audioFiles && failAudio) {
        failAudio = false;
        throw new Error('audio save failed');
      }
      return base.saveSession(id, value);
    },
  }));
  controller.setState('notes', { 0: 'note only' });
  await controller.flush();
  assert.equal(Object.hasOwn(calls[0], 'audioFiles'), false);
  const files = new Map([['s1', new File(['updated'], 'updated.wav')]]);
  controller.updateAudio(files);
  await assert.rejects(controller.flush(), /audio save failed/);
  controller.setState('query', 'late note');
  await controller.flush();
  assert.ok(calls[1].audioFiles instanceof Map);
  assert.equal(calls[1].operationId, calls[2].operationId);
  assert.strictEqual(
    calls[1].audioFiles.get('s1'),
    calls[2].audioFiles.get('s1'),
  );
  assert.equal(Object.hasOwn(calls[3], 'audioFiles'), false);
  controller.setState('notes', { 0: 'another note' });
  await controller.flush();
  assert.equal(Object.hasOwn(calls[4], 'audioFiles'), false);
});

test('remote changes after an uncertain save remain a conflict; save-as-copy retains both versions', async (t) => {
  let lost = true;
  const { base, controller, record } = await setup(t, (base) => ({
    ...base,
    async saveSession(id, value) {
      const result = await base.saveSession(id, value);
      if (lost) {
        lost = false;
        throw new Error('response lost');
      }
      return result;
    },
  }));
  controller.setState('query', 'local draft');
  await assert.rejects(controller.flush());
  const remote = await base.loadSession(record.id);
  await base.saveSession(record.id, {
    expectedRevision: remote.record.revision,
    operationId: 'remote',
    state: { ...state(), query: 'remote draft' },
  });
  await assert.rejects(controller.flush(), /別のタブ/);
  assert.equal(controller.getSnapshot().conflict, true);
  assert.equal(
    controller.getSnapshot().active.record.state.query,
    'local draft',
  );
  await controller.saveAsCopy();
  assert.notEqual(controller.getSnapshot().active.record.id, record.id);
  assert.equal(
    controller.getSnapshot().active.record.state.query,
    'local draft',
  );
  assert.equal(
    (await base.loadSession(record.id)).record.state.query,
    'remote draft',
  );
  assert.equal(controller.getSnapshot().status, 'saved');
});

test('failed flush prevents switching, creation, import and export while retaining the edited active session', async (t) => {
  let loads = 0,
    creates = 0,
    imports = 0,
    exports = 0;
  const { base, controller, record } = await setup(t, (base) => ({
    ...base,
    loadSession(id) {
      loads++;
      return base.loadSession(id);
    },
    createSession(value) {
      creates++;
      return base.createSession(value);
    },
    importBundle(value) {
      imports++;
      return base.importBundle(value);
    },
    exportBundle(id) {
      exports++;
      return base.exportBundle(id);
    },
    async saveSession() {
      throw new Error('quota');
    },
  }));
  const other = await base.createSession(input({ state: state() }));
  loads = 0;
  controller.setState('query', 'keep');
  await assert.rejects(controller.open(other.id), /quota/);
  await assert.rejects(controller.create(input({ state: state() })), /quota/);
  await assert.rejects(controller.importBundle(new Blob()), /quota/);
  await assert.rejects(controller.exportBundle(), /quota/);
  assert.deepEqual([loads, creates, imports, exports], [0, 0, 0, 0]);
  assert.equal(controller.getSnapshot().active.record.id, record.id);
  assert.equal(controller.getSnapshot().active.record.state.query, 'keep');
  assert.equal(controller.getSnapshot().status, 'error');
});

test('edits arriving while another session loads are committed to their original session before switching', async (t) => {
  const entered = deferred(),
    release = deferred();
  let target = '';
  const { base, controller, record } = await setup(t, (base) => ({
    ...base,
    async loadSession(id) {
      if (id === target) {
        entered.resolve();
        await release.promise;
      }
      return base.loadSession(id);
    },
  }));
  target = (await base.createSession(input({ state: state() }))).id;
  const opening = controller.open(target);
  await entered.promise;
  controller.setState('query', 'during load');
  release.resolve();
  await opening;
  assert.equal(
    (await base.loadSession(record.id)).record.state.query,
    'during load',
  );
  assert.equal(controller.getSnapshot().active.record.id, target);
  assert.equal(controller.getSnapshot().active.record.state.query, '');
});

test('copy and explicit reload cannot erase edits made after those operations began', async (t) => {
  let copyGate = null,
    loadGate = null;
  const { base, controller, record } = await setup(t, (base) => ({
    ...base,
    async createSession(value) {
      if (copyGate) {
        copyGate.entered.resolve();
        await copyGate.release.promise;
      }
      return base.createSession(value);
    },
    async loadSession(id) {
      if (loadGate) {
        loadGate.entered.resolve();
        await loadGate.release.promise;
      }
      return base.loadSession(id);
    },
  }));
  controller.setState('query', 'first');
  copyGate = { entered: deferred(), release: deferred() };
  const copying = controller.saveAsCopy();
  await copyGate.entered.promise;
  controller.setState('query', 'newer');
  copyGate.release.resolve();
  await assert.rejects(copying, /追加の編集/);
  assert.equal(controller.getSnapshot().active.record.id, record.id);
  assert.equal(controller.getSnapshot().active.record.state.query, 'newer');
  assert.equal((await base.listSessions()).length, 2);
  loadGate = { entered: deferred(), release: deferred() };
  const reloading = controller.reloadSaved();
  await loadGate.entered.promise;
  controller.setState('query', 'newest');
  loadGate.release.resolve();
  await assert.rejects(reloading, /追加の編集/);
  assert.equal(controller.getSnapshot().active.record.state.query, 'newest');
});

test('active deletion uses the revision produced by its own flush and duplicate calls share one deletion', async (t) => {
  const deletes = [];
  const { base, controller, record } = await setup(t, (base) => ({
    ...base,
    async deleteSession(id, revision) {
      deletes.push([id, revision]);
      return base.deleteSession(id, revision);
    },
  }));
  controller.setState('query', 'dirty');
  const first = controller.remove(record.id, record.revision);
  const duplicate = controller.remove(record.id, record.revision);
  assert.strictEqual(first, duplicate);
  await first;
  assert.deepEqual(deletes, [[record.id, 2]]);
  assert.equal(controller.getSnapshot().active, null);
  assert.deepEqual(await base.listSessions(), []);
});

test('additional edits during deletion are retained as a recoverable draft', async (t) => {
  const entered = deferred(),
    release = deferred();
  const { controller, record } = await setup(t, (base) => ({
    ...base,
    async deleteSession(id, revision) {
      entered.resolve();
      await release.promise;
      return base.deleteSession(id, revision);
    },
  }));
  const removing = controller.remove(record.id, 1);
  await entered.promise;
  controller.setState('query', 'late edit');
  release.resolve();
  await removing;
  assert.equal(controller.getSnapshot().active.record.state.query, 'late edit');
  assert.equal(controller.getSnapshot().conflict, true);
  await controller.saveAsCopy();
  assert.equal(controller.getSnapshot().status, 'saved');
  assert.equal(controller.getSnapshot().active.record.state.query, 'late edit');
});

test('malformed application state inside an otherwise valid bundle is removed without replacing the active draft', async (t) => {
  const { base, controller, record } = await setup(t);
  const other = await base.createSession(
    input({
      state: { schemaVersion: 1, tableSorting: [{ id: {}, desc: false }] },
    }),
  );
  const bundle = await base.exportBundle(other.id);
  await assert.rejects(controller.importBundle(bundle), /tableSorting/);
  assert.equal(controller.getSnapshot().active.record.id, record.id);
  assert.equal((await base.listSessions()).length, 2);
});

test('committed state is not reported as failed because only the session-list refresh failed', async (t) => {
  let fail = false;
  const { controller } = await setup(t, (base) => ({
    ...base,
    async listSessions() {
      if (fail) throw new Error('list failed');
      return base.listSessions();
    },
  }));
  fail = true;
  await controller.create(input({ state: state() }));
  assert.equal(controller.getSnapshot().status, 'saved');
  assert.match(controller.getSnapshot().error, /list failed/);
  fail = false;
  assert.equal(await controller.refreshForManager(), true);
  assert.equal(controller.getSnapshot().error, '');
});

test('dispose prevents a late successful save or refresh from emitting saved into an unmounted controller', async (t) => {
  const entered = deferred(),
    release = deferred();
  let closes = 0;
  const { controller } = await setup(t, (base) => ({
    ...base,
    async saveSession(id, value) {
      const result = await base.saveSession(id, value);
      entered.resolve();
      await release.promise;
      return result;
    },
    close() {
      closes++;
      base.close();
    },
  }));
  controller.setState('query', 'pending');
  const saving = controller.flush();
  await entered.promise;
  const snapshot = controller.getSnapshot();
  let notifications = 0;
  controller.subscribe(() => {
    notifications++;
  });
  controller.dispose();
  release.resolve();
  await assert.rejects(saving, /閉じられ/);
  assert.strictEqual(controller.getSnapshot(), snapshot);
  assert.equal(notifications, 0);
  assert.equal(closes, 1);
  await assert.rejects(controller.refresh(), /閉じられ/);
});

test('invalid UI setter is rejected before changing the live state or scheduling a save', async (t) => {
  const { controller } = await setup(t);
  const snapshot = controller.getSnapshot();
  assert.throws(
    () => controller.setState('tableSorting', [{ id: {}, desc: false }]),
    /tableSorting/,
  );
  assert.throws(() => controller.setState('selected', 999), /selected/);
  assert.strictEqual(controller.getSnapshot(), snapshot);
});

test('changing audio identity or bindings drops only stale audio metadata before backup', async (t) => {
  const { base, controller, record } = await setup(t);
  const metadata = {
    0: {
      sampleRate: 16_000,
      channels: 1,
      duration: 1,
      recipe: { engine: 'wandas', engineVersion: '0.7.2', unit: 'dBFS' },
      runtimeLockHash: 'a'.repeat(64),
      sourceName: 's1.wav',
      sourceHash: 'b'.repeat(64),
    },
  };
  controller.setState('notes', { 0: 'keep this note' });
  controller.setState('audioAnalyses', metadata);
  controller.setState('audioColumn', 'score');
  assert.equal(
    controller.getSnapshot().active.record.state.audioAnalyses,
    undefined,
  );
  assert.deepEqual(controller.getSnapshot().active.record.state.notes, {
    0: 'keep this note',
  });

  controller.setState('audioAnalyses', metadata);
  controller.updateAudio(new Map([['s1', new File(['replacement'], 's1.wav')]]));
  assert.equal(
    controller.getSnapshot().active.record.state.audioAnalyses,
    undefined,
  );
  await controller.flush();
  const saved = await base.loadSession(record.id);
  assert.equal(saved.record.state.audioAnalyses, undefined);
  assert.deepEqual(saved.record.state.notes, { 0: 'keep this note' });
});

async function bootModule(t) {
  const require = createRequire(import.meta.url);
  const stubs = {
    '@storage/index':
      'export const createBrowserRepository = options => globalThis.__controllerBootFixture.createRepository(options);',
    '@/state/config':
      'export const loadPolicy = async () => globalThis.__controllerBootFixture.policy;',
    './session-manager': 'export const SessionManager = () => null;',
    './view-preferences':
      'export const ViewPreferencesProvider = ({children}) => children;',
    './ui/button':
      'import React from "react"; export const Button = ({children,...props}) => React.createElement("button",props,children);',
    'lucide-react': [
      'export const AudioLines = () => null;',
      'export const BookOpen = AudioLines;',
      'export const Database = AudioLines;',
      'export const Download = AudioLines;',
      'export const ShieldCheck = AudioLines;',
    ].join(' '),
  };
  const result = await build({
    entryPoints: [
      fileURLToPath(
        new URL('../../src/components/production-app.tsx', import.meta.url),
      ),
    ],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    jsx: 'automatic',
    plugins: [
      {
        name: 'controller-boot-fixtures',
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            if (Object.hasOwn(stubs, args.path))
              return { path: args.path, namespace: 'boot-fixture' };
            if (/^react(?:\/jsx-runtime)?$/.test(args.path))
              return { path: require.resolve(args.path), external: true };
          });
          build.onLoad({ filter: /.*/, namespace: 'boot-fixture' }, (args) => ({
            contents: stubs[args.path],
            loader: 'js',
          }));
        },
      },
    ],
  });
  const file = join(
    tmpdir(),
    'controller-boot-' + crypto.randomUUID() + '.mjs',
  );
  await writeFile(file, result.outputFiles[0].text);
  t.after(() => rm(file, { force: true }));
  return import(pathToFileURL(file).href);
}

function bootEnvironment(t, createRepository) {
  const previousWindow = globalThis.window;
  const previousAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.__controllerBootFixture = {
    policy: {
      persistentStorage: true,
      downloads: true,
      maxBundleMiB: 128,
      maxTotalMiB: 256,
    },
    createRepository,
  };
  t.after(() => {
    globalThis.window = previousWindow;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousAct;
    delete globalThis.__controllerBootFixture;
  });
}

test('app unmount while repository boot is pending closes the late repository without loading sessions', async (t) => {
  const gate = deferred();
  let closes = 0,
    lists = 0;
  bootEnvironment(t, () => gate.promise);
  const { ProductionApp } = await bootModule(t);
  let view;
  await act(async () => {
    view = TestRenderer.create(
      React.createElement(ProductionApp, null, 'child'),
    );
  });
  await act(async () => {
    view.unmount();
  });
  await act(async () => {
    gate.resolve({
      close() {
        closes++;
      },
      async listSessions() {
        lists++;
        return [];
      },
    });
    await gate.promise;
  });
  assert.equal(closes, 1);
  assert.equal(lists, 0);
});

test('app unmount during initial session refresh closes its controller and never installs a late ready screen', async (t) => {
  const gate = deferred();
  let closes = 0;
  bootEnvironment(t, async () => ({
    mode: 'persistent',
    close() {
      closes++;
    },
    listSessions: () => gate.promise,
  }));
  const { ProductionApp } = await bootModule(t);
  let view;
  await act(async () => {
    view = TestRenderer.create(
      React.createElement(ProductionApp, null, 'child'),
    );
  });
  await act(async () => {
    view.unmount();
  });
  await act(async () => {
    gate.resolve([]);
    await gate.promise;
  });
  assert.equal(closes, 1);
  assert.equal(view.toJSON(), null);
});

test('app persistent initialization failure never silently falls back to memory', async (t) => {
  const modes = [];
  let closes = 0;
  bootEnvironment(t, async (options) => {
    modes.push(options.mode);
    if (options.mode === 'persistent') throw new Error('storage denied');
    return {
      mode: 'memory',
      close() {
        closes++;
      },
      async listSessions() {
        return [];
      },
    };
  });
  const { ProductionApp } = await bootModule(t);
  let view;
  await act(async () => {
    view = TestRenderer.create(
      React.createElement(ProductionApp, null, 'child'),
    );
  });
  assert.deepEqual(modes, ['persistent']);
  const button = view.root
    .findAllByType('button')
    .find((item) => item.children.join('') === '保存せず一時利用');
  assert.ok(button);
  await act(async () => {
    button.props.onClick();
  });
  assert.deepEqual(modes, ['persistent', 'memory']);
  await act(async () => {
    view.unmount();
  });
  assert.equal(closes, 1);
});
