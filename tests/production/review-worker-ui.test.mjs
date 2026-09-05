import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import React, { StrictMode } from 'react';
import { act, create } from 'react-test-renderer';
import { build } from 'esbuild';
import { createEvaluationRuntime } from '../../packages/domain/evaluation-runtime.ts';

// Mount the production React wrapper and worker client. Only delivery timing is
// controlled; every successful response is computed by the real domain runtime.
const directory = fileURLToPath(new URL('../../', import.meta.url));
const bundle = await build({
  stdin: {
    contents: `
    export { SampleReviewWorkspace } from './src/components/sample-review-workspace';
    export { useThreshold } from './src/components/threshold-context';
    export { WorkspaceContext } from './src/state/workspace-context';
  `,
    loader: 'tsx',
    resolveDir: directory,
  },
  absWorkingDir: directory,
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'silent',
});
const temporary = await mkdtemp(directory + '.review-worker-ui-');
let components;
try {
  const path = temporary + '/components.mjs';
  await writeFile(path, bundle.outputFiles[0].text);
  components = await import(pathToFileURL(path).href);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
const { SampleReviewWorkspace, useThreshold, WorkspaceContext } = components;
const h = React.createElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const mounted = new Set();
const ports = [];
const originalWorker = globalThis.Worker;
const originalFetch = globalThis.fetch;
class ControlledWorker {
  listeners = new Map();
  history = [];
  runtime = createEvaluationRuntime();
  terminated = false;
  pending = null;
  constructor() {
    ports.push(this);
  }
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(callback);
    if (name === 'message') this.history.push(callback);
  }
  removeEventListener(name, callback) {
    this.listeners.get(name)?.delete(callback);
  }
  postMessage(request) {
    this.pending = structuredClone(request);
  }
  terminate() {
    this.terminated = true;
  }
  complete(error) {
    assert.ok(this.pending, 'worker must have a pending request');
    const response = error
      ? {
          workerGeneration: this.pending.workerGeneration,
          requestId: this.pending.requestId,
          ok: false,
          error: { code: 'invalid-input', message: error },
          elapsedMs: 1,
        }
      : this.runtime(this.pending);
    this.pending = null;
    for (const callback of this.listeners.get('message') ?? [])
      callback({ data: structuredClone(response) });
    return response;
  }
  late(response) {
    for (const callback of this.history)
      callback({ data: structuredClone(response) });
  }
}
beforeEach(() => {
  ports.length = 0;
  globalThis.Worker = ControlledWorker;
  globalThis.fetch = async () => assert.fail('no network is used by this test');
});
afterEach(async () => {
  for (const tree of mounted) await act(async () => tree.unmount());
  mounted.clear();
  globalThis.Worker = originalWorker;
  globalThis.fetch = originalFetch;
});
const group = { kind: 'category', column: 'label', a: 'OK', b: 'NG' };
const dataset = (name = 'same.csv', count = 102) => ({
  name,
  demo: false,
  columns: ['name', 'score', 'label'],
  rows: Array.from({ length: count }, (_, index) => ({
    name: `sample-${index}`,
    score: String(index),
    label: index < count - 2 ? 'OK' : 'NG',
  })),
});
function store(data, state = {}) {
  let snapshot = {
    active: {
      dataset: data,
      record: {
        id: 'session-1',
        datasetVersionId: 'version-1',
        datasetHash: 'synthetic-hash-1',
        state: { schemaVersion: 1, ...state },
      },
    },
  };
  const listeners = new Set();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setState(key, update, initial) {
      const previous = snapshot.active.record.state[key] ?? initial;
      const value = typeof update === 'function' ? update(previous) : update;
      if (Object.is(value, previous)) return;
      snapshot = {
        ...snapshot,
        active: {
          ...snapshot.active,
          record: {
            ...snapshot.active.record,
            state: { ...snapshot.active.record.state, [key]: value },
          },
        },
      };
      for (const listener of listeners) listener();
    },
    replace(data) {
      snapshot = {
        active: {
          dataset: data,
          record: {
            id: 'session-2',
            datasetVersionId: 'version-2',
            datasetHash: 'synthetic-hash-2',
            state: { schemaVersion: 1 },
          },
        },
      };
      for (const listener of listeners) listener();
    },
  };
}
function Probe({ review, receive }) {
  receive({ review, threshold: useThreshold() });
  return null;
}
async function mount({ strict = false, initialState } = {}) {
  let data = dataset();
  let view;
  let props = {};
  const controller = store(data, initialState);
  const receive = (value) => (view = value);
  function render() {
    const body = h(
      WorkspaceContext.Provider,
      { value: { controller } },
      h(SampleReviewWorkspace, {
        dataset: data,
        score: 'score',
        group,
        filterColumn: '',
        filterValue: '',
        bins: 24,
        range: null,
        overlapOnly: false,
        query: '',
        idColumn: 'name',
        selectedIndex: 0,
        ...props,
        children: (review) => h(Probe, { review, receive }),
      }),
    );
    return strict ? h(StrictMode, null, body) : body;
  }
  let tree;
  await act(async () => {
    tree = create(render());
  });
  mounted.add(tree);
  return {
    tree,
    controller,
    get view() {
      return view;
    },
    async finish(error) {
      const current = ports.findLast(
        (port) => !port.terminated && port.pending,
      );
      assert.ok(current);
      let response;
      await act(async () => {
        response = current.complete(error);
      });
      return { port: current, response };
    },
    async change(patch) {
      props = { ...props, ...patch };
      await act(async () => tree.update(render()));
    },
    async replace(next) {
      data = next;
      await act(async () => {
        controller.replace(next);
        tree.update(render());
      });
    },
  };
}

test('fresh-session object defaults stay stable and StrictMode replay can complete its replacement worker', async () => {
  const app = await mount({ strict: true });
  assert.equal(app.view.review.pending, true);
  assert.ok(
    ports.some((port) => port.terminated),
    'StrictMode cleans up its first worker',
  );
  await app.finish();
  assert.equal(app.view.review.pending, false);
  assert.equal(app.view.review.visible.length, 102);
  const before = ports.length;
  await app.change({});
  assert.equal(ports.length, before);
  await app.change({ selectedIndex: 2 });
  assert.equal(app.view.review.selectedSample.index, 2);
  assert.equal(ports.findLast((port) => !port.terminated).pending, null);
});

test('query and same-name dataset changes hide stale results before the next worker completes', async () => {
  const app = await mount();
  const previous = await app.finish();
  assert.equal(app.view.review.pending, false);
  await app.change({ query: 'sample-101' });
  assert.equal(app.view.review.pending, true);
  assert.equal(app.view.review.workerResult, null);
  // Same-dataset rows may remain visible under a pending indication, but they
  // cannot supply current classifications or trigger a review mutation.
  assert.equal(app.view.review.thresholdReport, null);
  assert.equal(app.view.review.counts.falsePositive, null);
  assert.equal(app.view.review.counts.falseNegative, null);
  assert.equal(app.view.review.candidateScope, null);
  await act(async () => previous.port.late(previous.response));
  assert.equal(app.view.review.pending, true);
  await app.finish();
  assert.deepEqual(
    app.view.review.listed.map((s) => s.index),
    [101],
  );
  const replacement = dataset('same.csv', 4);
  replacement.rows[0].score = '999';
  await app.replace(replacement);
  assert.equal(app.view.review.workerResult, null);
  assert.equal(app.view.review.selectedSample, null);
  await app.change({ query: '' });
  await app.finish();
  assert.equal(app.view.review.selectedSample.score, 999);
  assert.equal(app.view.review.selectedSample.row, replacement.rows[0]);
});

test('retry returns to pending and cancellation keeps a stable message and permits a later retry', async () => {
  const app = await mount();
  await app.finish('synthetic worker failure');
  assert.equal(app.view.review.pending, false);
  assert.match(app.view.review.error, /synthetic/);
  const button = (text) =>
    app.tree.root
      .findAllByType('button')
      .find((node) => node.children.includes(text));
  await act(async () => button('再計算').props.onClick());
  assert.equal(app.view.review.pending, true);
  assert.equal(app.view.review.error, '');
  await act(async () => button('停止').props.onClick());
  assert.equal(app.view.review.pending, false);
  assert.match(app.view.review.error, /停止/);
  await act(async () => button('再計算').props.onClick());
  assert.equal(app.view.review.pending, true);
  await app.finish();
  assert.equal(app.view.review.pending, false);
  assert.equal(app.view.review.error, '');
});

test('pending work cannot exclude samples; FP calibration and exclusion changes invalidate old classifications', async () => {
  const app = await mount();
  await app.finish();
  const sample = app.view.review.selectedSample;
  await act(async () => app.view.review.setFilter('false-positive'));
  assert.equal(app.view.review.pending, true);
  assert.equal(app.view.threshold.report, null);
  await act(async () =>
    app.view.review.ignore(sample, 'must not apply during pending'),
  );
  assert.equal(
    Object.keys(
      app.controller.getSnapshot().active.record.state.reviewRecords ?? {},
    ).length,
    0,
  );
  await app.finish();
  assert.equal(app.view.threshold.report.calibration.actualPercent, 1);
  assert.equal(app.view.review.filter, 'false-positive');
  assert.equal(app.view.review.visible.length, 1);
  const candidate = app.view.review.visible[0];
  await act(async () => app.view.review.ignore(candidate, 'reviewed'));
  assert.equal(app.view.review.pending, true);
  assert.equal(app.view.threshold.report, null);
  assert.equal(app.view.review.filter, 'all');
  await app.finish();
  assert.equal(app.view.review.comparison.value.ignoredRows, 1);
  const event =
    app.controller.getSnapshot().active.record.state.reviewHistory[0];
  assert.equal(event.rowIndex, candidate.index);
  assert.equal(event.decision.before.total, 102);
  assert.equal(event.decision.threshold.actualPercent, 1);
});

test('list-only changes keep manual calibration; population changes permanently expire it and its candidate filter', async () => {
  const app = await mount();
  await app.finish();
  await act(async () => app.view.review.setFilter('false-positive'));
  await app.finish();
  await act(async () => app.view.threshold.applyManualThreshold(98.5));
  await app.finish();
  const expected = app.view.threshold.report;
  assert.equal(expected.calibration.rule.threshold, 98.5);
  await app.change({
    query: 'sample-99',
    bins: 48,
    range: { lo: 90, hi: 100, includeHi: true },
  });
  assert.equal(app.view.threshold.report, null);
  await app.finish();
  assert.deepEqual(app.view.threshold.report, expected);
  assert.equal(app.view.review.filter, 'false-positive');
  assert.deepEqual(
    app.view.review.visible.map((s) => s.index),
    [99],
  );
  await app.change({ filterColumn: 'label', filterValue: 'NG' });
  assert.equal(app.view.review.filter, 'all');
  assert.equal(app.view.threshold.report, null);
  assert.equal(app.view.threshold.selection, null);
  assert.equal(app.view.threshold.operationRule, null);
  await app.finish();
  assert.equal(app.view.threshold.report, null);
  await app.change({ filterColumn: '', filterValue: '' });
  await app.finish();
  assert.equal(app.view.threshold.report, null);
  assert.equal(
    app.controller.getSnapshot().active.record.state.thresholdSetting,
    null,
  );
});

test('manual threshold operation value stays available while pending and the latest update is evaluated', async () => {
  const app = await mount();
  await app.finish();
  await act(async () => app.view.review.setFilter('false-positive'));
  await app.finish();

  await act(async () => app.view.threshold.applyManualThreshold(98.5));
  assert.equal(app.view.threshold.pending, true);
  assert.equal(app.view.threshold.report, null);
  assert.equal(app.view.threshold.operationRule?.threshold, 98.5);
  const firstWorker = ports.findLast((port) => !port.terminated && port.pending);
  assert.ok(firstWorker);
  assert.equal(firstWorker.pending.command.spec.threshold.kind, 'manual');
  assert.equal(
    firstWorker.pending.command.spec.threshold.rule.threshold,
    98.5,
  );

  // A second key event arrives before the first calculation completes. The
  // old request is cancelled, while the operation value remains the latest
  // manual rule and is sent with the replacement request.
  await act(async () => app.view.threshold.applyManualThreshold(97.5));
  assert.equal(firstWorker.terminated, true);
  assert.equal(app.view.threshold.pending, true);
  assert.equal(app.view.threshold.report, null);
  assert.equal(app.view.threshold.operationRule?.threshold, 97.5);
  const latestWorker = ports.findLast((port) => !port.terminated && port.pending);
  assert.ok(latestWorker);
  assert.equal(latestWorker.pending.command.spec.threshold.kind, 'manual');
  assert.equal(
    latestWorker.pending.command.spec.threshold.rule.threshold,
    97.5,
  );

  await app.finish();
  assert.equal(app.view.threshold.pending, false);
  assert.equal(app.view.threshold.report?.calibration.rule.threshold, 97.5);

  // Replacing a completed manual setting with a rate must not borrow the
  // previous manual rule while that replacement is pending.
  await act(async () => app.view.threshold.applyFromInput());
  assert.equal(app.view.threshold.pending, true);
  assert.equal(app.view.threshold.report, null);
  assert.equal(app.view.threshold.operationRule, null);
  await app.finish();
});

test('orientation changes reject an old in-flight result and do not restore an old candidate recipe', async () => {
  const app = await mount();
  await app.finish();
  await act(async () => app.view.review.setFilter('false-negative'));
  const inFlight = ports.findLast((port) => !port.terminated && port.pending);
  const obsolete = inFlight.runtime(inFlight.pending);
  await act(async () => app.view.threshold.setDirection('low'));
  assert.equal(inFlight.terminated, true);
  assert.equal(app.view.threshold.operationRule, null);
  await act(async () => inFlight.late(obsolete));
  assert.equal(app.view.review.pending, true);
  assert.equal(app.view.review.thresholdReport, null);
  assert.equal(app.view.review.workerResult, null);
  await app.finish();
  assert.equal(app.view.review.evaluation.direction, 'low');
  assert.equal(app.view.review.filter, 'all');
  assert.equal(app.view.threshold.report, null);
});

test('unapplied viewport text edits do not start evaluation; applying a new extent does', async () => {
  const app = await mount({
    initialState: {
      viewport: {
        scoreColumn: 'score',
        selection: { mode: 'manual', extent: { min: 10, max: 90 } },
        lower: '10',
        upper: '90',
        error: '',
      },
    },
  });
  await app.finish();
  const baseline = app.view.review.workerResult;
  await act(async () =>
    app.controller.setState('viewport', (previous) => ({
      ...previous,
      lower: '12',
      upper: '',
    })),
  );
  assert.equal(app.view.review.pending, false);
  assert.equal(app.view.review.workerResult, baseline);
  assert.equal(ports.findLast((port) => !port.terminated).pending, null);
  await act(async () =>
    app.controller.setState('viewport', (previous) => ({
      ...previous,
      selection: { mode: 'manual', extent: { min: 12, max: 80 } },
      upper: '80',
    })),
  );
  assert.equal(app.view.review.pending, true);
  await app.finish();
  assert.deepEqual(
    [
      app.view.review.workerResult.displayDistribution.min,
      app.view.review.workerResult.displayDistribution.max,
    ],
    [12, 80],
  );
  assert.deepEqual(
    app.view.review.workerResult.evaluation,
    baseline.evaluation,
  );
});
