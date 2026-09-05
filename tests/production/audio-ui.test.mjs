import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { build } from 'esbuild';
const root = fileURLToPath(new URL('../../', import.meta.url));
const bundled = await build({
  stdin: {
    contents: `
 export {AudioInspector} from './src/components/audio-inspector';
 export {SampleSpectrogram} from './src/components/sample-spectrogram';
 export {InspectorProvider,useInspector} from './src/components/context-inspector';
 export {ViewPreferencesProvider,useViewPreferences} from './src/components/view-preferences';`,
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
      setup(b) {
        b.onResolve({ filter: /^@audio\/client$/ }, () => ({
          path: 'runtime',
          namespace: 'test-audio',
        }));
        b.onLoad({ filter: /.*/, namespace: 'test-audio' }, () => ({
          contents: `export function analyzeWav(bytes,options){return globalThis.__audioUITest.analyze(bytes,options)}`,
          loader: 'js',
        }));
        b.onResolve({ filter: /^@\/components\/spectrogram-chart$/ }, () => ({
          path: 'chart',
          namespace: 'test-chart',
        }));
        b.onLoad({ filter: /.*/, namespace: 'test-chart' }, () => ({
          contents: `import React from 'react'; export function SpectrogramChart(props){return React.createElement('canvas',{...props,'data-duration':props.data.duration,'aria-label':props.label+' spectrogram'});}`,
          loader: 'js',
          resolveDir: root,
        }));
        b.onResolve({ filter: /^@\/components\/ui\/input$/ }, () => ({
          path: 'input',
          namespace: 'test-input',
        }));
        b.onLoad({ filter: /.*/, namespace: 'test-input' }, () => ({
          contents: `import React from 'react'; export function Input(props){return React.createElement('input',props)}`,
          loader: 'js',
          resolveDir: root,
        }));
      },
    },
  ],
});
const directory = await mkdtemp(root + '.audio-ui-');
let components;
try {
  const path = directory + '/bundle.mjs';
  await writeFile(path, bundled.outputFiles[0].text);
  components = await import(pathToFileURL(path).href);
} finally {
  await rm(directory, { recursive: true, force: true });
}
const {
  AudioInspector,
  SampleSpectrogram,
  InspectorProvider,
  useInspector,
  ViewPreferencesProvider,
  useViewPreferences,
} = components;
const h = React.createElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const originalContext = globalThis.AudioContext;
const renderers = new Set();
let work, inspection, preferences, notifications;
function Probe() {
  inspection = useInspector();
  preferences = useViewPreferences();
  return null;
}
const result = (duration = 1) => ({
  sampleRate: 16000,
  channels: 2,
  duration,
  wave: [{ min: -0.5, max: 0.5 }],
  spectrogram: {
    values: new Float32Array(2050),
    columns: 2,
    frequencyBins: 1025,
    sampleRate: 16000,
    duration,
    fftSize: 2048,
    hopSize: 512,
    frameCount: 32,
    minDb: -100,
    maxDb: 0,
  },
  recipe: { engine: 'wandas', engineVersion: '0.7.2', unit: 'dBFS' },
  runtimeLockHash: 'a'.repeat(64),
  sourceHash: 'b'.repeat(64),
});
beforeEach(() => {
  work = [];
  notifications = [];
  globalThis.AudioContext = class {
    constructor() {
      throw new Error('UI must not decode audio through Web Audio');
    }
  };
  globalThis.__audioUITest = {
    analyze(bytes, options) {
      let resolve, reject;
      const promise = new Promise((a, b) => {
        resolve = a;
        reject = b;
      });
      work.push({ bytes, options, resolve, reject });
      return promise;
    },
  };
});
afterEach(async () => {
  for (const renderer of renderers) await act(async () => renderer.unmount());
  renderers.clear();
  delete globalThis.__audioUITest;
  if (originalContext) globalThis.AudioContext = originalContext;
  else delete globalThis.AudioContext;
});
function tree(props, strict = false) {
  const content = h(
    ViewPreferencesProvider,
    null,
    h(InspectorProvider, null, h(Probe), h(AudioInspector, props)),
  );
  return strict ? h(React.StrictMode, null, content) : content;
}
const sample = (index) => ({
  index,
  row: { name: 'sample-' + index },
  score: index,
  group: 'A',
});
function props(index = 0, extra = {}) {
  return {
    sample: sample(index),
    label: 'sample-' + index,
    scoreColumn: 'score',
    comparisonColumn: '',
    demo: false,
    file: new File([new Uint8Array(44)], 'sample.wav', { type: 'audio/wav' }),
    note: 'saved note',
    onNote: () => {},
    onAnalysis: (value) => notifications.push(value),
    ...extra,
  };
}
async function mount(element) {
  let renderer;
  await act(async () => {
    renderer = create(element, {
      createNodeMock: (node) =>
        node.type === 'input' ? { focus() {}, scrollIntoView() {} } : null,
    });
  });
  renderers.add(renderer);
  return renderer;
}
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}
function text(node) {
  return typeof node === 'string'
    ? node
    : (node.children ?? []).map(text).join('');
}
test('runtime is lazy, playback/note are available first, callback fires once with metadata only', async () => {
  const initial = props();
  const renderer = await mount(tree(initial, true));
  assert.equal(work.length, 0);
  assert.equal(renderer.root.findAllByType('audio').length, 1);
  assert.equal(
    renderer.root.findByProps({ id: 'sample-note' }).props.value,
    'saved note',
  );
  await act(async () => inspection.inspect('sample'));
  await flush();
  assert.equal(work.length, 1);
  const url = renderer.root.findByType('audio').props.src;
  await act(async () => work[0].resolve(result()));
  assert.equal(renderer.root.findByType('canvas').props['data-duration'], 1);
  assert.equal(notifications.length, 1);
  assert.deepEqual(Object.keys(notifications[0]).sort(), [
    'channels',
    'duration',
    'recipe',
    'runtimeLockHash',
    'sampleRate',
    'sourceHash',
  ]);
  await act(async () =>
    renderer.update(
      tree(
        {
          ...initial,
          note: 'edited',
          onAnalysis: (v) => notifications.push(v),
        },
        true,
      ),
    ),
  );
  assert.equal(work.length, 1);
  assert.equal(notifications.length, 1);
  assert.equal(renderer.root.findByType('audio').props.src, url);
  await act(async () => inspection.inspect('threshold'));
  assert.equal(work[0].options.signal.aborted, false);
  assert.equal(work.length, 1);
});
test('sample replacement aborts old job and rejects stale completion while preserving explicit view choices', async () => {
  const initial = props();
  const renderer = await mount(tree(initial));
  await act(async () => inspection.inspect('sample'));
  await flush();
  await act(async () => {
    preferences.setDisclosure('sample.spectrogram.method', true);
    preferences.updateSpectrogram({
      color: {
        range: { min: -70, max: -5 },
        minInput: '-70',
        maxInput: '-5',
        draftStarted: true,
      },
    });
  });
  const next = props(1);
  await act(async () => renderer.update(tree(next)));
  await flush();
  assert.equal(work.length, 2);
  assert.equal(work[0].options.signal.aborted, true);
  await act(async () => work[0].resolve(result(99)));
  assert.equal(renderer.root.findAllByType('canvas').length, 0);
  assert.equal(notifications.length, 0);
  await act(async () => work[1].resolve(result(2)));
  assert.equal(renderer.root.findByType('canvas').props['data-duration'], 2);
  assert.equal(notifications.length, 1);
  assert.deepEqual(preferences.spectrogram.color.range, { min: -70, max: -5 });
  assert.equal(preferences.disclosures['sample.spectrogram.method'], true);
});
test('audio failure stays local; retry keeps original media, note and settings', async () => {
  const initial = props();
  const renderer = await mount(tree(initial));
  await act(async () => inspection.inspect('sample'));
  await flush();
  const url = renderer.root.findByType('audio').props.src;
  await act(async () => work[0].reject(new Error('runtime unavailable')));
  assert.ok(text(renderer.root).includes('runtime unavailable'));
  assert.equal(renderer.root.findByType('audio').props.src, url);
  assert.equal(
    renderer.root.findByProps({ id: 'sample-note' }).props.value,
    'saved note',
  );
  const retry = renderer.root
    .findAllByType('button')
    .find((node) => text(node) === '音声解析を再試行');
  await act(async () => retry.props.onClick());
  await flush();
  assert.equal(work.length, 2);
  await act(async () => work[1].resolve(result()));
  assert.equal(renderer.root.findAllByType('canvas').length, 1);
  assert.equal(renderer.root.findByType('audio').props.src, url);
});
test('missing audio explains the resolver evidence and opens its settings', async () => {
  let opened = 0;
  const renderer = await mount(
    tree(
      props(3, {
        file: undefined,
        audioResolution: {
          file: undefined,
          reason: 'name-mismatch',
          expectedNames: ['normal03.wav'],
          source: 'audio-column',
          sourceColumn: 'audio_file',
        },
        onOpenAudioSettings: () => {
          opened++;
        },
      }),
    ),
  );
  assert.ok(text(renderer.root).includes('追加済み音声に対応するファイル名がありません'));
  assert.ok(text(renderer.root).includes('normal03.wav'));
  const settings = renderer.root
    .findAllByType('button')
    .find((node) => text(node) === 'サンプル名・試聴音声の設定を開く');
  assert.ok(settings);
  await act(async () => settings.props.onClick());
  assert.equal(opened, 1);
});
test('double-click axis settings retain valid/manual range and draft across new sample data', async () => {
  const initial = props();
  const renderer = await mount(tree(initial));
  await act(async () => inspection.inspect('sample'));
  await flush();
  await act(async () => work[0].resolve(result()));
  await act(async () =>
    renderer.root.findByType('canvas').props.onEditAxis('frequency'),
  );
  assert.equal(preferences.disclosures['sample.spectrogram.method'], true);
  const minimum = renderer.root.findByProps({
    'aria-label': '周波数の下限 (kHz)',
  });
  await act(async () => minimum.props.onChange({ target: { value: '0.5' } }));
  await act(async () =>
    renderer.root
      .findByProps({ 'aria-label': '周波数範囲を適用' })
      .props.onClick(),
  );
  assert.deepEqual(preferences.spectrogram.frequency.range, {
    min: 0.5,
    max: 8,
  });
  await act(async () =>
    renderer.root
      .findByProps({ 'aria-label': '周波数の下限 (kHz)' })
      .props.onChange({ target: { value: '' } }),
  );
  await act(async () => renderer.update(tree(props(2))));
  await flush();
  await act(async () => work[1].resolve(result(2)));
  assert.equal(
    renderer.root.findByProps({ 'aria-label': '周波数の下限 (kHz)' }).props
      .value,
    '',
  );
  assert.deepEqual(preferences.spectrogram.frequency.range, {
    min: 0.5,
    max: 8,
  });
  assert.equal(work.length, 2);
});
