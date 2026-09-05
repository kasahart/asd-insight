import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../', import.meta.url));
const bundled = await build({
  stdin: {
    contents: `
      export { AudioInspector } from './src/components/audio-inspector';
      export { ContextWorkbench } from './src/components/context-workbench';
      export { InspectorProvider, useInspector } from './src/components/context-inspector';
      export { ViewPreferencesProvider, useViewPreferences } from './src/components/view-preferences';
      export { WorkspaceContext } from './src/state/workspace-context';
    `,
    resolveDir: root,
    loader: 'tsx',
  },
  absWorkingDir: root,
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'silent',
  plugins: [
    {
      name: 'fixed-runtime-boundary',
      setup(builder) {
        builder.onResolve({ filter: /^@audio\/client$/ }, () => ({
          path: 'runtime',
          namespace: 'test-audio',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'test-audio' }, () => ({
          contents: `export function analyzeWav(bytes,options){return globalThis.__audioInspectorTest.analyze(bytes,options)}`,
          loader: 'js',
        }));
        builder.onResolve(
          { filter: /^@\/components\/spectrogram-chart$/ },
          () => ({
            path: 'chart',
            namespace: 'test-chart',
          }),
        );
        builder.onLoad({ filter: /.*/, namespace: 'test-chart' }, () => ({
          contents: `import React from 'react'; export function SpectrogramChart(props){return React.createElement('canvas',{...props,'data-duration':props.data.duration,'aria-label':props.label+' spectrogram'});}`,
          loader: 'js',
          resolveDir: root,
        }));
        builder.onResolve({ filter: /^@\/components\/ui\/input$/ }, () => ({
          path: 'input',
          namespace: 'test-input',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'test-input' }, () => ({
          contents: `import React from 'react'; export function Input(props){return React.createElement('input',props)}`,
          loader: 'js',
          resolveDir: root,
        }));
      },
    },
  ],
});

const temporary = await mkdtemp(root + '.inspector-interactions-');
let components;
try {
  const path = temporary + '/components.mjs';
  await writeFile(path, bundled.outputFiles[0].text);
  components = await import(pathToFileURL(path).href);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

const {
  AudioInspector,
  ContextWorkbench,
  InspectorProvider,
  WorkspaceContext,
  ViewPreferencesProvider,
  useInspector,
  useViewPreferences,
} = components;
const h = React.createElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mounted = new Set();
const savedGlobals = {
  AudioContext: globalThis.AudioContext,
  ResizeObserver: globalThis.ResizeObserver,
  window: globalThis.window,
};
let analysisWork;
let inspection;
let preferences;
let listeners;
let workbenchWidth;
let separatorTarget;

function setGlobal(name, value) {
  if (value === undefined) delete globalThis[name];
  else globalThis[name] = value;
}

beforeEach(() => {
  analysisWork = [];
  inspection = null;
  preferences = null;
  listeners = new Map();
  workbenchWidth = 1200;
  const captures = new Set();
  separatorTarget = {
    setPointerCapture(pointerId) {
      captures.add(pointerId);
    },
    hasPointerCapture(pointerId) {
      return captures.has(pointerId);
    },
    releasePointerCapture(pointerId) {
      captures.delete(pointerId);
    },
    focus() {},
  };

  globalThis.AudioContext = class {
    constructor() {
      throw new Error('UI must not decode audio through Web Audio');
    }
  };
  delete globalThis.ResizeObserver;
  globalThis.window = {
    innerWidth: 1400,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
  };
  globalThis.__audioInspectorTest = {
    analyze(bytes, options) {
      let resolve;
      let reject;
      const promise = new Promise((a, b) => {
        resolve = a;
        reject = b;
      });
      analysisWork.push({ bytes, options, resolve, reject });
      return promise;
    },
  };
});

afterEach(async () => {
  for (const renderer of mounted) await act(async () => renderer.unmount());
  mounted.clear();
  for (const registered of listeners.values()) assert.equal(registered.size, 0);
  delete globalThis.__audioInspectorTest;
  setGlobal('AudioContext', savedGlobals.AudioContext);
  setGlobal('ResizeObserver', savedGlobals.ResizeObserver);
  setGlobal('window', savedGlobals.window);
});

function controller(initial = {}) {
  let snapshot = {
    active: { record: { id: 'analysis', state: structuredClone(initial) } },
  };
  const subscribers = new Set();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    setState(key, update, initialValue) {
      const previous = snapshot.active.record.state[key] ?? initialValue;
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
      for (const listener of subscribers) listener();
    },
  };
}

function Wrap({ store, children }) {
  return h(
    WorkspaceContext.Provider,
    {
      value: {
        controller: store,
        policy: {
          persistentStorage: false,
          downloads: false,
          maxBundleMiB: 64,
          maxTotalMiB: 128,
        },
        openManager() {},
      },
    },
    h(ViewPreferencesProvider, null, children),
  );
}

function Probe() {
  inspection = useInspector();
  preferences = useViewPreferences();
  return null;
}

function audioSample(index) {
  return {
    index,
    row: { name: `sample-${index}` },
    score: index,
    group: 'A',
  };
}

function audioProps(index = 0) {
  return {
    sample: audioSample(index),
    label: `sample-${index}`,
    scoreColumn: 'score',
    comparisonColumn: '',
    demo: false,
    file: new File([new Uint8Array(44)], `sample-${index}.wav`, {
      type: 'audio/wav',
    }),
    note: 'saved note',
    onNote() {},
  };
}

function audioTree(store, props) {
  return h(
    Wrap,
    { store },
    h(InspectorProvider, null, h(Probe), h(AudioInspector, props)),
  );
}

function text(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return (Array.isArray(node) ? node : (node.children ?? []))
    .map(text)
    .join('');
}

function gainSlider(renderer) {
  return renderer.root.find(
    (node) => node.type === 'input' && node.props.id === 'sample-playback-gain',
  );
}

function resetGainButton(renderer) {
  return renderer.root.find(
    (node) => node.type === 'button' && text(node) === '0 dBに戻す',
  );
}

function gainOutput(renderer) {
  return renderer.root.find(
    (node) =>
      node.type === 'output' && node.props.htmlFor === 'sample-playback-gain',
  );
}

async function mount(element) {
  let renderer;
  await act(async () => {
    renderer = create(element, {
      createNodeMock(node) {
        if (node.type === 'input') return { focus() {}, scrollIntoView() {} };
        if (
          node.type === 'div' &&
          node.props.className === 'context-workbench resizable-workbench'
        ) {
          return {
            getBoundingClientRect() {
              return { width: workbenchWidth };
            },
          };
        }
        if (
          node.type === 'div' &&
          node.props.className === 'inspector-resize-separator'
        ) {
          return separatorTarget;
        }
        return null;
      },
    });
  });
  mounted.add(renderer);
  return renderer;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

test('gain changes are saved in session view state and survive sample replacement plus analysis failure', async () => {
  const store = controller();
  let props = audioProps(0);
  const renderer = await mount(audioTree(store, props));

  await act(async () => inspection.inspect('sample'));
  await flush();
  assert.equal(analysisWork.length, 1);
  assert.equal(gainSlider(renderer).props.value, 0);

  await act(async () =>
    gainSlider(renderer).props.onChange({
      target: { value: '12' },
      currentTarget: { value: '12' },
    }),
  );
  assert.equal(
    store.getSnapshot().active.record.state.audioPreferences.gainDb,
    12,
  );
  assert.equal(preferences.audio.gainDb, 12);
  assert.equal(gainSlider(renderer).props.value, 12);
  assert.equal(gainSlider(renderer).props['aria-valuetext'], '+12 dB');
  assert.match(text(gainOutput(renderer)), /\+12 dB/);

  props = audioProps(1);
  await act(async () => renderer.update(audioTree(store, props)));
  await flush();
  assert.equal(analysisWork.length, 2);
  assert.equal(analysisWork[0].options.signal.aborted, true);
  assert.equal(gainSlider(renderer).props.value, 12);
  assert.equal(gainSlider(renderer).props['aria-valuetext'], '+12 dB');

  await act(async () =>
    analysisWork[1].reject(new Error('runtime unavailable')),
  );
  await flush();
  assert.match(text(renderer.root), /runtime unavailable/);
  assert.equal(gainSlider(renderer).props.value, 12);
  assert.equal(preferences.audio.gainDb, 12);

  props = audioProps(2);
  await act(async () => renderer.update(audioTree(store, props)));
  await flush();
  assert.equal(analysisWork.length, 3);
  assert.equal(gainSlider(renderer).props.value, 12);
  assert.equal(preferences.audio.gainDb, 12);
});

test('resetting playback gain through the user control persists 0 dB and disables the reset action', async () => {
  const store = controller();
  const renderer = await mount(audioTree(store, audioProps()));

  await act(async () => inspection.inspect('sample'));
  await flush();
  await act(async () =>
    gainSlider(renderer).props.onChange({
      target: { value: '18' },
      currentTarget: { value: '18' },
    }),
  );
  assert.equal(resetGainButton(renderer).props.disabled, false);

  await act(async () =>
    resetGainButton(renderer).props.onClick({ stopPropagation() {} }),
  );
  assert.equal(
    store.getSnapshot().active.record.state.audioPreferences.gainDb,
    0,
  );
  assert.equal(preferences.audio.gainDb, 0);
  assert.equal(gainSlider(renderer).props.value, 0);
  assert.equal(gainSlider(renderer).props['aria-valuetext'], '0 dB');
  assert.equal(text(gainOutput(renderer)), '0 dB');
  assert.equal(resetGainButton(renderer).props.disabled, true);
});

function WorkbenchScenario({ sampleId }) {
  return h(
    ContextWorkbench,
    null,
    h('section', { 'data-sample-id': sampleId }, sampleId),
  );
}

function workbenchTree(store, sampleId) {
  return h(Wrap, { store }, h(WorkbenchScenario, { sampleId }));
}

function workbenchRoot(renderer) {
  return renderer.root.findByProps({
    className: 'context-workbench resizable-workbench',
  });
}

function resizeSeparator(renderer) {
  return renderer.root.findByProps({ role: 'separator' });
}

function pointerEvent(clientX, currentTarget = separatorTarget) {
  return {
    button: 0,
    isPrimary: true,
    pointerId: 11,
    clientX,
    currentTarget,
    preventDefault() {},
  };
}

async function emitWindow(type) {
  await act(async () => {
    for (const listener of listeners.get(type) ?? []) listener();
  });
}

test('wide inspector drag saves the intended width and keeps it after switching samples', async () => {
  const store = controller();
  const renderer = await mount(workbenchTree(store, 'sample-0'));
  assert.equal(workbenchRoot(renderer).props['data-layout'], 'columns');
  assert.equal(
    workbenchRoot(renderer).props.style['--inspector-width'],
    '320px',
  );

  await act(async () =>
    resizeSeparator(renderer).props.onPointerDown(pointerEvent(100)),
  );
  assert.equal(workbenchRoot(renderer).props['data-resizing'], 'true');
  await act(async () =>
    resizeSeparator(renderer).props.onPointerMove(pointerEvent(40)),
  );
  assert.equal(
    workbenchRoot(renderer).props.style['--inspector-width'],
    '380px',
  );
  assert.equal(resizeSeparator(renderer).props['aria-valuenow'], 380);

  await act(async () =>
    resizeSeparator(renderer).props.onPointerUp(pointerEvent(40)),
  );
  assert.equal(store.getSnapshot().active.record.state.inspectorWidth, 380);
  assert.equal(workbenchRoot(renderer).props['data-resizing'], undefined);

  await act(async () => renderer.update(workbenchTree(store, 'sample-1')));
  assert.equal(
    workbenchRoot(renderer).props.style['--inspector-width'],
    '380px',
  );
  assert.equal(resizeSeparator(renderer).props['aria-valuenow'], 380);
  assert.equal(
    renderer.root.findByProps({ 'data-sample-id': 'sample-1' }).children[0],
    'sample-1',
  );
});

test('narrow workbench constrains the separator, blocks pointer resizing, and restores the saved width when wide again', async () => {
  const store = controller({ inspectorWidth: 520 });
  const renderer = await mount(workbenchTree(store, 'sample-0'));
  assert.equal(workbenchRoot(renderer).props['data-layout'], 'columns');
  assert.equal(resizeSeparator(renderer).props['aria-valuenow'], 520);

  workbenchWidth = 700;
  await emitWindow('resize');
  assert.equal(workbenchRoot(renderer).props['data-layout'], 'stacked');
  assert.equal(
    workbenchRoot(renderer).props.style['--inspector-width'],
    '280px',
  );
  assert.equal(resizeSeparator(renderer).props['aria-disabled'], true);
  assert.equal(resizeSeparator(renderer).props.tabIndex, -1);

  const savedWidth = store.getSnapshot().active.record.state.inspectorWidth;
  await act(async () =>
    resizeSeparator(renderer).props.onPointerDown(pointerEvent(100)),
  );
  assert.equal(
    store.getSnapshot().active.record.state.inspectorWidth,
    savedWidth,
  );
  assert.equal(workbenchRoot(renderer).props['data-resizing'], undefined);

  workbenchWidth = 1200;
  await emitWindow('resize');
  assert.equal(workbenchRoot(renderer).props['data-layout'], 'columns');
  assert.equal(
    workbenchRoot(renderer).props.style['--inspector-width'],
    '520px',
  );
  assert.equal(resizeSeparator(renderer).props['aria-valuenow'], 520);
});
