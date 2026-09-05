import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { build } from 'esbuild';
import { evaluateDataset } from '../../packages/domain/evaluation.ts';
import { histogram } from '../../packages/domain/distribution.ts';
import { sortReviewSamples } from '../../packages/domain/evaluation-sorting.ts';

// Production components, with only the worker result and Recharts layout
// boundaries injected. No browser, HTTP request, or prototype component runs.
const directory = fileURLToPath(new URL('../../', import.meta.url));
const bundle = await build({
  stdin: {
    contents: `
    export { SampleTable } from './src/components/sample-table';
    export { ScoreComparison } from './src/components/score-comparison';
    export { DistributionViewport } from './src/components/distribution-viewport';
    export { DistributionChart } from './src/components/distribution-chart';
    export { InspectorProvider, ContextInspector, useInspector } from './src/components/context-inspector';
    export { ViewPreferencesProvider, PersistentDetails, useViewPreferences } from './src/components/view-preferences';
    export { ThresholdScope } from './src/components/threshold-context';
    export { WorkspaceContext, useSessionState } from './src/state/workspace-context';
    export { EvaluationTestContext } from './src/components/sample-review-workspace';
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
  plugins: [
    {
      name: 'ui-boundaries',
      setup(builder) {
        builder.onResolve({ filter: /sample-review-workspace$/ }, () => ({
          path: 'evaluation',
          namespace: 'ui-test',
        }));
        builder.onResolve({ filter: /^recharts$/ }, () => ({
          path: 'recharts',
          namespace: 'ui-test',
        }));
        builder.onResolve({ filter: /^@\/components\/ui\/chart$/ }, () => ({
          path: 'chart',
          namespace: 'ui-test',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'ui-test' }, ({ path }) => ({
          contents:
            path === 'evaluation'
              ? `import {createContext,useContext} from 'react';export const EvaluationTestContext=createContext(null);export function useEvaluationResult(){return useContext(EvaluationTestContext);}`
              : path === 'chart'
                ? `import React from 'react';export function ChartContainer({children,className}){return React.createElement('div',{className},children);}`
                : `import React from 'react';const model=()=>globalThis.__productionUiChart;
          export const DefaultZIndexes={label:500,activeBar:100};
          export function ComposedChart({children,...props}){model().chartProps=props;return React.createElement('svg',null,children);}
          export function XAxis(props){model().axis=props;return null;}export function YAxis(){return null;}export function Area(){return null;}export function CartesianGrid(){return null;}export function Tooltip(){return null;}
          export function ZIndexLayer({children,zIndex}){return React.createElement('g',{'data-z-index':zIndex},children);}
          export function usePlotArea(){return model().plot;}
          export function useXAxisScale(){return value=>{const m=model(),[min,max]=m.axis.domain;return m.plot.x+(value-min)/(max-min)*m.plot.width;};}
          export function useXAxisInverseScale(){return value=>{const m=model(),[min,max]=m.axis.domain;return min+(value-m.plot.x)/m.plot.width*(max-min);};}
          export function useYAxisScale(){return value=>{const p=model().plot;return p.y+p.height-value/100*p.height;};}`,
          loader: 'js',
          resolveDir: directory,
        }));
      },
    },
  ],
});
const temporary = await mkdtemp(directory + '.ui-regressions-');
let ui;
try {
  const path = temporary + '/components.mjs';
  await writeFile(path, bundle.outputFiles[0].text);
  ui = await import(pathToFileURL(path).href);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
const {
  SampleTable,
  ScoreComparison,
  DistributionViewport,
  DistributionChart,
  InspectorProvider,
  ContextInspector,
  useInspector,
  ViewPreferencesProvider,
  PersistentDetails,
  useViewPreferences,
  ThresholdScope,
  WorkspaceContext,
  useSessionState,
  EvaluationTestContext,
} = ui;
const h = React.createElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const mounted = new Set();
const savedGlobals = {
  window: globalThis.window,
  document: globalThis.document,
  fetch: globalThis.fetch,
};
let listeners, focusCalls;
beforeEach(() => {
  listeners = new Map();
  focusCalls = [];
  globalThis.window = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
  };
  globalThis.document = {
    getElementById(id) {
      return {
        scrollIntoView() {},
        focus(options) {
          focusCalls.push({ id, options });
        },
      };
    },
  };
  globalThis.fetch = async () => assert.fail('unexpected network');
  globalThis.__productionUiChart = {
    plot: { x: 40, y: 36, width: 400, height: 200 },
    axis: { domain: [0, 100] },
  };
});
afterEach(async () => {
  for (const tree of mounted) await act(async () => tree.unmount());
  mounted.clear();
  Object.assign(globalThis, savedGlobals);
  delete globalThis.__productionUiChart;
});
function controller(initial = {}) {
  let snapshot = {
    active: { record: { id: 'analysis', state: structuredClone(initial) } },
  };
  const listeners = new Set();
  return {
    getSnapshot: () => snapshot,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setState(key, update, initial) {
      const previous = snapshot.active.record.state[key] ?? initial;
      const next = typeof update === 'function' ? update(previous) : update;
      if (Object.is(previous, next)) return;
      snapshot = {
        active: {
          record: {
            ...snapshot.active.record,
            state: { ...snapshot.active.record.state, [key]: next },
          },
        },
      };
      for (const fn of listeners) fn();
    },
  };
}
function Wrap({ store, children }) {
  return h(
    WorkspaceContext.Provider,
    { value: { controller: store } },
    h(ViewPreferencesProvider, null, h(InspectorProvider, null, children)),
  );
}
function text(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return (Array.isArray(node) ? node : (node.children ?? []))
    .map(text)
    .join('');
}
function button(tree, label) {
  return tree.root.find(
    (node) =>
      node.type === 'button' &&
      (node.props['aria-label'] === label || text(node) === label),
  );
}
async function click(node) {
  assert.ok(!node.props.disabled, 'control must be available');
  await act(async () =>
    node.props.onClick({ stopPropagation() {}, shiftKey: false }),
  );
}
async function enter(tree, label, value) {
  const input = tree.root.find(
    (node) => node.type === 'input' && node.props['aria-label'] === label,
  );
  await act(async () =>
    input.props.onChange({
      target: { value },
      currentTarget: { value },
      nativeEvent: {},
    }),
  );
}
function body(tree, label) {
  return tree.root.find(
    (node) => node.type === 'tbody' && node.props['aria-label'] === label,
  );
}
const listed = (tree) => body(tree, '一覧の表示ページ');
const reference = (tree) => body(tree, '選択中のサンプル（参照）');
const footer = (tree) =>
  tree.root.find(
    (node) => node.type === 'div' && node.props.className === 'table-footer',
  );
const names = (tree) =>
  listed(tree)
    .findAllByType('button')
    .filter((node) => node.props.className === 'sample-link')
    .map((node) => node.props.title);
function sortButton(tree, label) {
  return tree.root.find(
    (node) =>
      node.type === 'button' &&
      node.props.className === 'table-sort' &&
      node.props['aria-label'].startsWith(label + '：'),
  );
}
const samples = Array.from({ length: 18 }, (_, index) => ({
  index,
  score: index / 100,
  group: index % 2 ? 'B' : 'A',
  row: {
    filename: `sample-${index}.wav`,
    score: String(index / 100),
    auxiliary: String(index + 1.5),
    label: index % 2 ? 'anomaly' : 'normal',
  },
}));
function TableScenario({ options }) {
  const [sorting] = useSessionState('tableSorting', [
    { id: 'score', desc: false },
  ]);
  const sort = sorting[0] ?? { id: 'score', desc: false };
  const mapped = React.useMemo(
    () =>
      sort.id.startsWith('comparison-score:') && options.comparisonColumn
        ? {
            column: options.comparisonColumn,
            source: 'row',
            kind: 'number',
            desc: sort.desc,
          }
        : {
            column:
              sort.id === 'sample'
                ? '__sample'
                : sort.id === 'group'
                  ? '__group'
                  : '__score',
            desc: sort.desc,
          },
    [sort.id, sort.desc, options.comparisonColumn],
  );
  // This is the injected Worker boundary: the production table only slices the
  // already sorted indices, never invokes TanStack's full-data sort/model.
  const ordered = React.useMemo(
    () => sortReviewSamples(options.samples, mapped, 'filename'),
    [options.samples, mapped],
  );
  return h(SampleTable, {
    idColumn: 'filename',
    scoreColumn: 'score',
    groupColumn: 'label',
    comparisonColumn: '',
    selectedSample: samples[10],
    onSelect() {},
    hasAudio: () => true,
    notes: {},
    ignoredIndices: new Set(),
    onRestore() {},
    ...options,
    samples: ordered,
  });
}
async function tableFixture(options = {}, initial = {}) {
  const store = controller(initial);
  let props = { samples, ...options };
  const render = () => h(Wrap, { store }, h(TableScenario, { options: props }));
  let tree;
  await act(async () => {
    tree = create(render());
  });
  mounted.add(tree);
  return {
    tree,
    store,
    async update(patch) {
      props = { ...props, ...patch };
      await act(async () => tree.update(render()));
    },
    async reopen() {
      await act(async () => tree.unmount());
      await act(async () => {
        tree = create(render());
      });
      this.tree = tree;
      mounted.add(tree);
    },
  };
}

test('manual pagination shares pinned columns, renders at most eight page rows and keeps accurate counts', async () => {
  const app = await tableFixture({ comparisonColumn: 'auxiliary' });
  assert.equal(reference(app.tree).findAllByType('td').length, 6);
  assert.equal(listed(app.tree).findAllByType('tr').length, 8);
  assert.match(
    text(reference(app.tree)),
    /選択中sample-10.wav群A0.111.5normal対象/,
  );
  assert.match(text(footer(app.tree)), /18件中 1–8件.*1 \/ 3/);
  await click(button(app.tree, '次のページ'));
  assert.equal(listed(app.tree).findAllByType('tr').length, 7);
  assert.equal(
    app.tree.root.findAll(
      (node) =>
        node.type === 'button' &&
        node.props['aria-label'] === 'sample-10.wav を選択',
    ).length,
    1,
  );
  await click(button(app.tree, '次のページ'));
  assert.deepEqual(names(app.tree), ['sample-16.wav', 'sample-17.wav']);
  assert.match(text(footer(app.tree)), /18件中 17–18件.*3 \/ 3/);
  assert.equal(button(app.tree, '次のページ').props.disabled, true);
});

test('native full-cell sort controls alternate two states, reset pages and persist ordering on reopen', async () => {
  const app = await tableFixture({ selectedSample: null });
  await click(button(app.tree, '次のページ'));
  await click(sortButton(app.tree, 'サンプル名'));
  assert.equal(sortButton(app.tree, 'サンプル名').props.type, 'button');
  assert.equal(sortButton(app.tree, 'サンプル名').props['data-sort'], 'asc');
  assert.equal(names(app.tree)[0], 'sample-0.wav');
  assert.match(text(footer(app.tree)), /1 \/ 3/);
  await click(sortButton(app.tree, 'サンプル名'));
  assert.equal(sortButton(app.tree, 'サンプル名').props['data-sort'], 'desc');
  assert.equal(names(app.tree)[0], 'sample-17.wav');
  await click(button(app.tree, '次のページ'));
  await app.reopen();
  assert.match(text(footer(app.tree)), /2 \/ 3/);
  assert.equal(names(app.tree)[0], 'sample-9.wav');
  assert.equal(sortButton(app.tree, 'サンプル名').props['data-sort'], 'desc');
  await click(sortButton(app.tree, 'サンプル名'));
  assert.equal(sortButton(app.tree, 'サンプル名').props['data-sort'], 'asc');
});

test('saved pagination waits for the first worker result, clamps invalid pages and resets for filtering', async () => {
  const app = await tableFixture(
    { samples: [], pending: true },
    { pagination: { pageIndex: 2, pageSize: 8 } },
  );
  assert.match(text(footer(app.tree)), /0件中 0–0件.*1 \/ 1/);
  assert.equal(
    app.store.getSnapshot().active.record.state.pagination.pageIndex,
    2,
  );
  await app.update({ samples, pending: false });
  assert.match(text(footer(app.tree)), /3 \/ 3/);
  await app.update({ samples: samples.slice(0, 9) });
  assert.match(text(footer(app.tree)), /1 \/ 2/);
  const invalid = await tableFixture(
    {},
    { pagination: { pageIndex: 50, pageSize: 4 } },
  );
  assert.match(text(footer(invalid.tree)), /18件中 17–18件.*5 \/ 5/);
  assert.equal(
    invalid.store.getSnapshot().active.record.state.pagination.pageIndex,
    4,
  );
});

async function comparisonFixture(ready = true) {
  const store = controller({
    comparisonColumn: 'auxiliary',
    tableSorting: [{ id: 'comparison-score:auxiliary', desc: true }],
  });
  const data = {
    name: 'synthetic.csv',
    demo: false,
    columns: Object.keys(samples[0].row),
    rows: samples.map((s) => s.row),
  };
  let tree;
  const render = () =>
    h(
      Wrap,
      { store },
      h(ScoreComparison, {
        dataset: data,
        columns: ready ? ['auxiliary'] : [],
        samples,
        coverageRows: data.rows,
        scoreColumn: 'score',
        result: null,
        children: ({ column, control }) =>
          h(
            React.Fragment,
            null,
            control,
            h(TableScenario, {
              options: {
                samples,
                selectedSample: null,
                comparisonColumn: column,
              },
            }),
          ),
      }),
    );
  await act(async () => {
    tree = create(render());
  });
  mounted.add(tree);
  return {
    tree,
    store,
    async ready() {
      ready = true;
      await act(async () => tree.update(render()));
    },
  };
}

test('explicitly hiding an optional descending score synchronizes fallback order without losing a saved sort during profile loading', async () => {
  const app = await comparisonFixture(false);
  assert.deepEqual(app.store.getSnapshot().active.record.state.tableSorting, [
    { id: 'comparison-score:auxiliary', desc: true },
  ]);
  await app.ready();
  assert.equal(
    sortButton(app.tree, 'auxiliary（比較）').props['data-sort'],
    'desc',
  );
  assert.equal(names(app.tree)[0], 'sample-17.wav');
  const select = app.tree.root.findByType('select');
  await act(async () =>
    select.props.onChange({
      target: { value: '' },
      currentTarget: { value: '' },
      nativeEvent: {},
    }),
  );
  assert.equal(sortButton(app.tree, 'score').props['data-sort'], 'asc');
  assert.equal(names(app.tree)[0], 'sample-0.wav');
  assert.deepEqual(app.store.getSnapshot().active.record.state.tableSorting, [
    { id: 'score', desc: false },
  ]);
});

test('two-stage excluded-only restoration preserves a valid page and keeps an empty-list reference restorable', async () => {
  const allIgnored = new Set(samples.map((s) => s.index));
  const restored = [];
  const app = await tableFixture({
    ignoredIndices: allIgnored,
    onRestore: (index) => restored.push(index),
  });
  await click(button(app.tree, '次のページ'));
  await click(button(app.tree, 'sample-10.wav を一覧から集計に戻す'));
  assert.deepEqual(restored, [10]);
  const ignored = new Set([...allIgnored].filter((i) => i !== 10));
  await app.update({ ignoredIndices: ignored, pending: true });
  await app.update({
    ignoredIndices: ignored,
    samples: samples.filter((s) => s.index !== 10),
    pending: false,
  });
  assert.match(text(footer(app.tree)), /17件中 9–16件.*2 \/ 3/);
  assert.match(text(reference(app.tree)), /絞り込み外/);
  await app.update({
    samples: [],
    ignoredIndices: new Set([10]),
    pending: false,
  });
  assert.match(text(footer(app.tree)), /0件中 0–0件.*1 \/ 1/);
  assert.equal(listed(app.tree).findAllByType('tr').length, 0);
  assert.equal(
    reference(app.tree).findByType('tr').props['data-excluded'],
    true,
  );
  await click(button(app.tree, 'sample-10.wav を一覧から集計に戻す'));
  assert.deepEqual(restored, [10, 10]);
});

function PreferenceScenario({ sampleId, receive }) {
  const preferences = useViewPreferences(),
    inspector = useInspector();
  receive({ preferences, inspector });
  return h(ContextInspector, {
    threshold: h('input', { defaultValue: 'threshold draft' }),
    sample: h(
      PersistentDetails,
      { key: sampleId, preferenceKey: 'sample.spectrogram.method' },
      h('summary', null, '表示条件'),
      h('span', null, sampleId),
    ),
    sampleIdentity: { label: sampleId, group: 'A', excluded: false },
  });
}
test('disclosures, axis drafts and audio choices survive sample replacement and saved-analysis reopen without replaying focus', async () => {
  const store = controller({
    inspectorSelection: { target: 'sample', focus: true },
  });
  let current,
    tree,
    sampleId = 'first';
  const render = () =>
    h(
      Wrap,
      { store },
      h(PreferenceScenario, {
        sampleId,
        receive: (value) => (current = value),
      }),
    );
  await act(async () => {
    tree = create(render());
  });
  mounted.add(tree);
  assert.equal(focusCalls.length, 0, 'a historical focus flag is not an event');
  await act(async () =>
    tree.root
      .findByType('details')
      .props.onToggle({ currentTarget: { open: true } }),
  );
  await act(async () => {
    current.preferences.updateAudio({ gainDb: 6, volume: 0.7 });
    current.preferences.updateSpectrogram({
      frequency: {
        range: { min: 10, max: 24 },
        minInput: '',
        maxInput: '30',
        draftStarted: true,
      },
    });
    current.preferences.setInspectorWidth(500);
    current.inspector.inspect('threshold', { focus: true });
  });
  assert.equal(focusCalls.length, 1);
  sampleId = 'second';
  await act(async () => tree.update(render()));
  assert.equal(tree.root.findByType('details').props.open, true);
  assert.equal(current.preferences.spectrogram.frequency.minInput, '');
  assert.equal(current.preferences.audio.gainDb, 6);
  assert.equal(current.preferences.inspectorWidth, 500);
  await act(async () => tree.unmount());
  await act(async () => {
    tree = create(render());
  });
  mounted.add(tree);
  assert.equal(current.inspector.target, 'threshold');
  assert.equal(focusCalls.length, 1);
  assert.equal(tree.root.findByType('details').props.open, true);
  assert.deepEqual(current.preferences.spectrogram.frequency.range, {
    min: 10,
    max: 24,
  });
  assert.equal(current.preferences.spectrogram.frequency.maxInput, '30');
  await act(async () =>
    tree.root
      .findByType('details')
      .props.onToggle({ currentTarget: { open: false } }),
  );
  sampleId = 'third';
  await act(async () => tree.update(render()));
  assert.equal(tree.root.findByType('details').props.open, false);
});

const viewportDataset = {
  name: 'axis.csv',
  demo: false,
  columns: ['score', 'label'],
  rows: [
    ...[-1000, ...Array.from({ length: 98 }, (_, i) => i), 1000].map(
      (score) => ({ score: String(score), label: 'A' }),
    ),
    ...[-2000, ...Array.from({ length: 98 }, (_, i) => i + 5), 2000].map(
      (score) => ({ score: String(score), label: 'B' }),
    ),
  ],
};
const viewportSpec = {
  scoreColumn: 'score',
  group: { kind: 'category', column: 'label', a: 'A', b: 'B' },
  okGroup: 'A',
  direction: 'high',
  bins: 24,
  threshold: {
    kind: 'manual',
    rule: { threshold: 500, operator: 'gt', direction: 'high' },
  },
};
function ViewportScenario({ receive, available = true }) {
  const [view] = useSessionState('viewport', null);
  const result = React.useMemo(
    () =>
      evaluateDataset(viewportDataset, {
        ...viewportSpec,
        histogramDomain: view?.selection.extent,
      }),
    [view?.selection.extent],
  );
  return h(
    EvaluationTestContext.Provider,
    { value: available ? result : null },
    h(
      ThresholdScope,
      { value: { report: result.thresholdReport } },
      h(DistributionViewport, {
        source: viewportDataset,
        scoreColumn: 'score',
        distribution: result.distribution,
        a: result.a,
        b: result.b,
        selectedScore: 1000,
        children: (display) => {
          receive({ result, display });
          return h('section', null, display.controls, display.notice);
        },
      }),
    ),
  );
}
async function viewportFixture(initial = {}) {
  const store = controller(initial);
  let current,
    tree,
    available = true;
  const render = () =>
    h(
      Wrap,
      { store },
      h(ViewportScenario, { available, receive: (value) => (current = value) }),
    );
  await act(async () => {
    tree = create(render());
  });
  mounted.add(tree);
  return {
    tree,
    store,
    get current() {
      return current;
    },
    async availability(next) {
      available = next;
      await act(async () => tree.update(render()));
    },
  };
}
test('worker-backed viewport changes only display geometry and keeps manual drafts and a recovery route', async () => {
  const app = await viewportFixture();
  const baseline = app.current.result;
  await click(button(app.tree, '中心部を拡大'));
  assert.deepEqual(
    [
      app.current.display.distribution.min,
      app.current.display.distribution.max,
    ],
    [0, 102],
  );
  assert.deepEqual(
    app.current.result.thresholdReport,
    baseline.thresholdReport,
  );
  assert.deepEqual(app.current.result.evaluation, baseline.evaluation);
  assert.match(text(app.tree.toJSON()), /しきい値は表示範囲外/);
  await enter(app.tree, '横軸の下限', '10');
  await enter(app.tree, '横軸の上限', '20');
  await click(button(app.tree, '横軸を適用'));
  assert.deepEqual(
    [
      app.current.display.distribution.min,
      app.current.display.distribution.max,
    ],
    [10, 20],
  );
  await enter(app.tree, '横軸の下限', '1');
  await enter(app.tree, '横軸の上限', String(1 + Number.EPSILON));
  await click(button(app.tree, '横軸を適用'));
  assert.deepEqual(
    app.store.getSnapshot().active.record.state.viewport.selection.extent,
    { min: 10, max: 20 },
  );
  assert.match(text(app.tree.toJSON()), /差が小さすぎ/);
  await app.availability(false);
  await click(button(app.tree, '全体へ戻す'));
  assert.equal(
    app.store.getSnapshot().active.record.state.viewport.selection.extent,
    null,
  );
});

test('a saved viewport and partially edited limits reopen without applying the unfinished edit', async () => {
  const app = await viewportFixture({
    viewport: {
      scoreColumn: 'score',
      selection: { mode: 'manual', extent: { min: 10, max: 40 } },
      lower: '12',
      upper: '',
      error: '',
    },
  });
  assert.deepEqual(
    [
      app.current.display.distribution.min,
      app.current.display.distribution.max,
    ],
    [10, 40],
  );
  assert.equal(
    app.tree.root.find(
      (node) =>
        node.type === 'input' && node.props['aria-label'] === '横軸の下限',
    ).props.value,
    '12',
  );
  assert.equal(
    app.tree.root.find(
      (node) =>
        node.type === 'input' && node.props['aria-label'] === '横軸の上限',
    ).props.value,
    '',
  );
});

test('a valid restored null viewport stays usable while the current evaluation is unavailable', async () => {
  const app = await viewportFixture({ viewport: null });
  assert.equal(
    app.tree.root.find(
      (node) =>
        node.type === 'input' && node.props['aria-label'] === '横軸の下限',
    ).props.value,
    '',
  );
  assert.equal(app.store.getSnapshot().active.record.state.viewport, null);

  // Switching to a valid saved analysis can leave the worker result empty for
  // one render. The viewport still owns a usable full-range fallback.
  await app.availability(false);
  assert.match(text(app.tree.toJSON()), /横軸：全体/);
  assert.equal(app.store.getSnapshot().active.record.state.viewport, null);
});

function GestureScenario({ receive }) {
  const [value, setValue] = React.useState(50),
    [range, setRange] = React.useState({ lo: 10, hi: 20, includeHi: false });
  const data = React.useMemo(
    () => ({
      name: 'gesture.csv',
      demo: false,
      columns: ['score', 'label'],
      rows: [10, 20, 30, 70, 80, 90].map((score, i) => ({
        score: String(score),
        label: i < 3 ? 'A' : 'B',
      })),
    }),
    [],
  );
  const result = React.useMemo(
    () =>
      evaluateDataset(data, {
        ...viewportSpec,
        bins: 10,
        histogramDomain: { min: 0, max: 100 },
        threshold: {
          kind: 'manual',
          rule: { threshold: value, operator: 'gt', direction: 'high' },
        },
      }),
    [data, value],
  );
  const distribution = React.useMemo(
    () => histogram([10, 20, 30], [70, 80, 90], 10, { min: 0, max: 100 }),
    [],
  );
  receive({ value, range });
  return h(
    ThresholdScope,
    {
      value: { report: result.thresholdReport, applyManualThreshold: setValue },
    },
    h(DistributionChart, {
      distribution,
      a: result.a,
      b: result.b,
      range,
      onSelect: setRange,
      onClearRange: () => setRange(null),
      selectedScore: 70,
      selectedGroup: 'B',
    }),
  );
}
test('production threshold dragging and range clearing remain independent after the worker migration', async () => {
  let current, tree;
  await act(async () => {
    tree = create(
      h(
        Wrap,
        { store: controller() },
        h(GestureScenario, { receive: (value) => (current = value) }),
      ),
    );
  });
  mounted.add(tree);
  const captures = new Set();
  const target = {
    isConnected: true,
    setPointerCapture(id) {
      captures.add(id);
    },
    hasPointerCapture(id) {
      return captures.has(id);
    },
    releasePointerCapture(id) {
      captures.delete(id);
    },
    focus() {},
    getBoundingClientRect() {
      return { left: 40, width: 400 };
    },
    ownerSVGElement: {
      isConnected: true,
      viewBox: { baseVal: { x: 0, width: 500 } },
      getBoundingClientRect() {
        return { left: 0, width: 500 };
      },
    },
  };
  const control = (name) =>
    tree.root.find(
      (node) => typeof node.type === 'string' && node.props.className === name,
    );
  const down = async (name, x) =>
    act(async () =>
      control(name).props.onPointerDown({
        isPrimary: true,
        button: 0,
        pointerId: 7,
        clientX: x,
        clientY: 100,
        currentTarget: target,
        preventDefault() {},
        stopPropagation() {},
      }),
    );
  const emit = async (type, x) =>
    act(async () => {
      for (const callback of listeners.get(type) ?? [])
        callback({ pointerId: 7, clientX: x, clientY: 100 });
    });
  await down('distribution-threshold-handle', 192);
  await emit('pointermove', 242);
  assert.equal(current.value, 50);
  await emit('pointerup', 242);
  assert.equal(current.value, 62.5);
  assert.deepEqual(current.range, { lo: 10, hi: 20, includeHi: false });
  await down('distribution-range-target', 100);
  await emit('pointerup', 100);
  assert.equal(current.range, null);
  assert.equal(current.value, 62.5);
  await down('distribution-range-target', 120);
  await emit('pointermove', 240);
  await emit('pointerup', 240);
  assert.deepEqual(current.range, { lo: 20, hi: 60, includeHi: false });
  assert.equal(current.value, 62.5);
});
