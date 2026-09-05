import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import {
  initializeAudioKernel,
  sha256,
} from '../../packages/audio-runtime/kernel.ts';
const root = fileURLToPath(new URL('../../', import.meta.url));
const encode = (value) => new TextEncoder().encode(value);
const lock = {
  pyodideVersion: '314.0.3',
  wandasVersion: '0.7.2',
  nativePackages: [],
  pureWheels: [],
  assets: [{ path: 'core.wasm', sha256: 'a'.repeat(64) }],
};
async function manifest(adapter) {
  return {
    runtimeLockHash: await sha256(encode(JSON.stringify(lock))),
    adapterSha256: await sha256(encode(adapter)),
  };
}
test('mismatched release and Python adapter fail before any dynamic module import', async () => {
  const adapter = 'fixed adapter';
  const valid = await manifest(adapter);
  for (const invalid of [
    { ...valid, runtimeLockHash: '0'.repeat(64) },
    { ...valid, adapterSha256: '0'.repeat(64) },
  ]) {
    const requested = [];
    await assert.rejects(
      initializeAudioKernel({
        lock,
        baseUrl: '/no-network/',
        moduleUrl: 'file:///does-not-exist.mjs',
        adapterSource: adapter,
        readAsset: async (name) => {
          requested.push(name);
          return name === 'manifest.json'
            ? encode(JSON.stringify(invalid))
            : encode(adapter);
        },
      }),
      /版が一致/,
    );
    assert.deepEqual(requested, ['manifest.json']);
  }
  await assert.rejects(
    initializeAudioKernel({
      lock,
      baseUrl: '/no-network/',
      moduleUrl: 'file:///does-not-exist.mjs',
      adapterSource: adapter,
      readAsset: async (name) =>
        name === 'manifest.json'
          ? encode(JSON.stringify(valid))
          : encode('modified Python'),
    }),
    /版が一致/,
  );
});
test('a corrupt core/wheel is rejected before Python starts', async () => {
  const adapter = 'fixed adapter';
  const valid = await manifest(adapter);
  await assert.rejects(
    initializeAudioKernel({
      lock,
      baseUrl: '/no-network/',
      moduleUrl: 'file:///does-not-exist.mjs',
      adapterSource: adapter,
      readAsset: async (name) =>
        name === 'manifest.json'
          ? encode(JSON.stringify(valid))
          : name === 'wandas_adapter.py'
            ? encode(adapter)
            : encode('corrupt'),
    }),
    /検証に失敗/,
  );
});
const bundled = await build({
  entryPoints: [root + 'packages/audio-runtime/audio.worker.ts'],
  absWorkingDir: root,
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'silent',
  loader: { '.py': 'text' },
  plugins: [
    {
      name: 'worker-kernel-boundary',
      setup(b) {
        b.onResolve({ filter: /^\.\/kernel$/ }, () => ({
          path: 'kernel',
          namespace: 'worker-test',
        }));
        b.onLoad({ filter: /.*/, namespace: 'worker-test' }, () => ({
          contents: `export async function initializeAudioKernel(options){globalThis.__audioWorkerTest.initializations.push(options);await options.readAsset('manifest.json');await options.readAsset('wandas_adapter.py');await options.readAsset('pyodide.mjs');return{analyze(){return{spectrogram:{values:new Float32Array([0])}}}}}`,
          loader: 'js',
        }));
      },
    },
  ],
});
test('worker accepts only local fixed GET assets and forbids redirects', async () => {
  const directory = await mkdtemp(root + '.audio-worker-');
  const original = globalThis.self;
  const calls = [],
    messages = [],
    initializations = [];
  const scope = {
    location: { origin: 'https://app.invalid' },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
    },
    postMessage: (message) => messages.push(message),
  };
  globalThis.self = scope;
  globalThis.__audioWorkerTest = { initializations };
  try {
    const file = directory + '/worker.mjs';
    await writeFile(file, bundled.outputFiles[0].text);
    await import(pathToFileURL(file).href);
    for (const baseUrl of [
      'https://cdn.invalid/runtime/audio/',
      'https://app.invalid/other/',
      'https://u:p@app.invalid/runtime/audio/',
      'https://app.invalid/runtime/audio/?url=x',
    ])
      await scope.onmessage({
        data: {
          type: 'analyze',
          baseUrl,
          requestId: 1,
          generation: 1,
          bytes: new ArrayBuffer(44),
        },
      });
    assert.equal(initializations.length, 0);
    assert.equal(calls.length, 0);
    assert.ok(messages.every((value) => value.type === 'error'));
    await scope.onmessage({
      data: {
        type: 'analyze',
        baseUrl: 'https://app.invalid/runtime/audio/',
        requestId: 2,
        generation: 2,
        bytes: new ArrayBuffer(44),
      },
    });
    assert.equal(initializations.length, 1);
    assert.deepEqual(
      calls.slice(0, 3).map(({ url, options }) => ({
        url,
        cache: options.cache,
        redirect: options.redirect,
        method: options.method,
      })),
      [
        {
          url: 'https://app.invalid/runtime/audio/manifest.json',
          cache: 'no-store',
          redirect: 'error',
          method: 'GET',
        },
        {
          url: 'https://app.invalid/runtime/audio/wandas_adapter.py',
          cache: 'no-store',
          redirect: 'error',
          method: 'GET',
        },
        {
          url: 'https://app.invalid/runtime/audio/pyodide.mjs',
          cache: 'force-cache',
          redirect: 'error',
          method: 'GET',
        },
      ],
    );
    assert.equal(messages.at(-1).type, 'result');
    await assert.rejects(
      scope.fetch('https://cdn.invalid/asset.whl'),
      /外部通信/,
    );
    await assert.rejects(
      scope.fetch('https://app.invalid/api/private'),
      /外部通信/,
    );
    await assert.rejects(
      scope.fetch('pyodide.mjs', { method: 'POST' }),
      /送信/,
    );
    assert.equal(calls.length, 3);
    await scope.fetch('pyodide.mjs');
    assert.equal(calls[3].url, 'https://app.invalid/runtime/audio/pyodide.mjs');
  } finally {
    globalThis.self = original;
    delete globalThis.__audioWorkerTest;
    await rm(directory, { recursive: true, force: true });
  }
});

test('Python argument/result proxies are released on success and on conversion failure', async () => {
  const directory = await mkdtemp(root + '.audio-proxy-');
  const state = {
    inputs: 0,
    results: 0,
    functions: 0,
    adapters: 0,
    fail: false,
  };
  const adapterSource = 'fixed adapter';
  const testLock = { ...lock, assets: [] };
  const testManifest = {
    runtimeLockHash: await sha256(encode(JSON.stringify(testLock))),
    adapterSha256: await sha256(encode(adapterSource)),
  };
  const analyze = () => ({
    destroy() {
      state.results++;
    },
    toJs(options) {
      assert.equal(options.create_pyproxies, false);
      if (state.fail) throw new Error('conversion failure');
      const values = new Float32Array(1025);
      const wave = new Float32Array([-0.5, 0.5]);
      return {
        metadata: JSON.stringify({
          sampleRate: 16000,
          channels: 1,
          duration: 1,
          waveColumns: 1,
          columns: 1,
          frequencyBins: 1025,
          fftSize: 2048,
          hopSize: 512,
          frameCount: 1,
          minDb: -100,
          maxDb: 0,
          sourceHash: 'b'.repeat(64),
          recipe: { engine: 'wandas', engineVersion: '0.7.2', unit: 'dBFS' },
        }),
        values: new Uint8Array(values.buffer),
        wave: new Uint8Array(wave.buffer),
      };
    },
  });
  analyze.destroy = () => {
    state.functions++;
  };
  globalThis.__audioKernelProxy = {
    async loadPackage() {},
    unpackArchive() {},
    runPython() {
      return '/fixed/purelib';
    },
    toPy() {
      return {
        destroy() {
          state.inputs++;
        },
      };
    },
    pyimport() {
      return {
        analyze_wav: analyze,
        destroy() {
          state.adapters++;
        },
      };
    },
    FS: { writeFile() {}, unlink() {} },
  };
  let kernel;
  try {
    const file = directory + '/engine.mjs';
    await writeFile(
      file,
      `export const version='314.0.3'; export async function loadPyodide(options){if(!options.lockFileContents||options.packageBaseUrl!=='/fixed/'||options.cdnUrl!=='/fixed/')throw new Error('local configuration mismatch'); return globalThis.__audioKernelProxy;}`,
    );
    kernel = await initializeAudioKernel({
      lock: testLock,
      baseUrl: '/fixed/',
      moduleUrl: pathToFileURL(file).href,
      adapterSource,
      readAsset: async (name) =>
        name === 'manifest.json'
          ? encode(JSON.stringify(testManifest))
          : name === 'wandas_adapter.py'
            ? encode(adapterSource)
            : encode('{}'),
    });
    kernel.analyze(new Uint8Array(44));
    assert.equal(state.inputs, 1);
    assert.equal(state.results, 1);
    state.fail = true;
    assert.throws(
      () => kernel.analyze(new Uint8Array(44)),
      /conversion failure/,
    );
    assert.equal(state.inputs, 2);
    assert.equal(state.results, 2);
  } finally {
    kernel?.dispose();
    delete globalThis.__audioKernelProxy;
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(state.functions, 1);
  assert.equal(state.adapters, 1);
});
