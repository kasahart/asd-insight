import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { initializeAudioKernel } from '../packages/audio-runtime/kernel.ts';
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = join(root, 'runtime/prepared/runtime/audio');
const lock = JSON.parse(
  await readFile(join(root, 'runtime/lock.json'), 'utf8'),
);
// Public assets must already be prepared. Numeric verification has no network.
globalThis.fetch = async () => {
  throw new Error('Network is disabled during audio verification');
};
console.log('Initializing the pinned local Wandas/Pyodide runtime…');
const kernel = await initializeAudioKernel({
  lock,
  baseUrl: directory + '/',
  moduleUrl: pathToFileURL(join(directory, 'pyodide.mjs')).href,
  adapterSource: await readFile(join(root, 'python/wandas_adapter.py'), 'utf8'),
  readAsset: async (name) =>
    new Uint8Array(await readFile(join(directory, name))),
});
function wav(rate, channels, length, at) {
  const buffer = new ArrayBuffer(44 + length * channels * 4),
    view = new DataView(buffer);
  const text = (p, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(p + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, buffer.byteLength - 8, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * 4, true);
  view.setUint16(32, channels * 4, true);
  view.setUint16(34, 32, true);
  text(36, 'data');
  view.setUint32(40, length * channels * 4, true);
  for (let i = 0; i < length; i++)
    for (let c = 0; c < channels; c++)
      view.setFloat32(44 + (i * channels + c) * 4, at(i, c), true);
  return new Uint8Array(buffer);
}
let count = 0;
function check(name, run) {
  run();
  count++;
  console.log('PASS', name);
}
function analyze(rate, channels, length, at) {
  return kernel.analyze(wav(rate, channels, length, at));
}
function close(actual, expected, tolerance = 0.001) {
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `${actual} != ${expected}`,
  );
}
function at(result, column, bin) {
  return result.spectrogram.values[column * 1025 + bin];
}
try {
  const rate = 16000,
    bin = 128,
    halfDb = 20 * Math.log10(0.5);
  check(
    'original rate/channels, ch1-only analysis, full-scale sine = 0 dBFS',
    () => {
      const result = analyze(rate, 2, rate, (i, c) =>
        c ? 0.25 : Math.sin((2 * Math.PI * bin * i) / 2048),
      );
      assert.equal(result.sampleRate, rate);
      assert.equal(result.channels, 2);
      assert.equal(result.duration, 1);
      close(at(result, 8, bin), 0);
      assert.equal(result.recipe.originalFrames, rate);
      assert.equal(result.recipe.channel, 0);
      assert.equal(result.recipe.frameTimeOrigin, -512 / rate);
      assert.equal(result.recipe.retainedFirstFrameTime, 0);
      assert.equal(result.recipe.retainedLastFrameTime, 15872 / rate);
    },
  );
  check(
    'half-scale sine, DC and Nyquist are calibrated without double-scaling endpoints',
    () => {
      for (const [wave, frequency] of [
        [(i) => 0.5 * Math.sin((2 * Math.PI * bin * i) / 2048), bin],
        [() => 0.5, 0],
        [(i) => (i % 2 ? -0.5 : 0.5), 1024],
      ]) {
        close(at(analyze(rate, 1, rate, wave), 8, frequency), halfDb);
      }
    },
  );
  check('44100 Hz stereo WAV is not resampled or averaged', () => {
    const result = analyze(44100, 2, 22050, (_i, c) => (c ? -0.75 : 0.25));
    assert.equal(result.duration, 0.5);
    assert.equal(result.sampleRate, 44100);
    assert.equal(result.channels, 2);
    close(result.wave[0].min, 0.25);
    close(result.wave.at(-1).max, 0.25);
    close(at(result, 8, 0), 20 * Math.log10(0.25));
  });
  check('silence has a finite engine floor and exact original duration', () => {
    const result = analyze(rate, 1, 12345, () => 0);
    assert.equal(result.duration, 12345 / rate);
    assert.ok(result.spectrogram.values.every((value) => value === -240));
    assert.equal(result.recipe.displayTimeEdges.at(-1), result.duration);
  });
  check(
    'impulse position is measured in original time, not padded-frame indices',
    () => {
      const position = 12000,
        result = analyze(rate, 1, rate, (i) => (i === position ? 1 : 0));
      const maxima = Array.from(
        { length: result.spectrogram.columns },
        (_, c) => at(result, c, 128),
      );
      const strongest = maxima.indexOf(Math.max(...maxima));
      const edges = result.recipe.displayTimeEdges;
      assert.ok(
        position / rate >= edges[strongest] - 512 / rate &&
          position / rate <= edges[strongest + 1] + 512 / rate,
      );
      assert.ok(strongest >= 23 && strongest <= 24);
    },
  );
  check('last-sample transient survives bounded 512-column aggregation', () => {
    const length = rate * 18,
      result = analyze(rate, 1, length, (i) => (i === length - 1 ? 1 : 0));
    assert.equal(result.spectrogram.columns, 512);
    assert.ok(at(result, 511, 128) > -120);
    assert.ok(result.recipe.retainedLastFrameTime < 18);
    assert.equal(result.recipe.displayTimeEdges.at(-1), 18);
  });
  check('one-sample WAV is explicitly padded only for analysis', () => {
    const result = analyze(rate, 1, 1, () => 0.5);
    assert.equal(result.duration, 1 / rate);
    assert.equal(result.spectrogram.columns, 1);
    assert.equal(result.recipe.shortInputRightPaddingSamples, 1023);
    assert.deepEqual(result.wave, [{ min: 0.5, max: 0.5 }]);
  });
  check(
    'non-finite PCM and unsupported format reject, then a valid job succeeds',
    () => {
      assert.throws(() => analyze(rate, 1, 100, () => NaN), /不正/);
      assert.throws(() => kernel.analyze(new Uint8Array(44)), /WAV/);
      assert.equal(analyze(rate, 1, 100, () => 0).duration, 100 / rate);
    },
  );
  check(
    'metadata guards reject excessive duration/channels and estimated working memory',
    () => {
      assert.throws(() => analyze(1000, 1, 181000, () => 0), /180秒/);
      assert.throws(() => analyze(rate, 9, 100, () => 0), /1〜8ch/);
      // A 23MB file is legal on disk but its uncompressed STFT would exceed the
      // memory estimate. It must fail before Wandas decode/STFT materialization.
      assert.throws(() => analyze(96000, 1, 96000 * 60, () => 0), /メモリ上限/);
    },
  );
  const manifest = JSON.parse(
    await readFile(join(directory, 'manifest.json'), 'utf8'),
  );
  const original = wav(rate, 1, 2048, () => 0);
  const result = kernel.analyze(original);
  assert.equal(
    result.sourceHash,
    createHash('sha256').update(original).digest('hex'),
  );
  assert.equal(result.runtimeLockHash, manifest.runtimeLockHash);
  assert.equal(result.recipe.adapterSha256, manifest.adapterSha256);
  console.log(
    `Verified ${count} real Wandas/Pyodide numeric cases; no HTTP or browser used.`,
  );
} finally {
  kernel.dispose();
}
