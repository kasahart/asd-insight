import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url)),
  dir = await mkdtemp(root + '.gui-core-');
async function bundle(entry, name) {
  const output = await build({
    entryPoints: [entry],
    absWorkingDir: root,
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    logLevel: 'silent',
  });
  const file = dir + '/' + name + '.mjs';
  await writeFile(file, output.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}
let shared, legacy;
try {
  shared = await bundle('src/lib/spectrogram-display.ts', 'shared');
  legacy = await bundle('tests/fixtures/spectrogram-legacy.ts', 'legacy');
} finally {
  await rm(dir, { recursive: true, force: true });
}
function payload(columns, bins) {
  return {
    values: Float32Array.from({ length: columns * bins }, (_, k) =>
      k % 17 === 0 ? NaN : k % 13 === 0 ? -240 : -100 + (k % 101),
    ),
    columns,
    frequencyBins: bins,
    sampleRate: 48000,
    duration: 1,
    frameCount: 80,
    fftSize: 24,
    hopSize: 600,
    minDb: -100,
    maxDb: 0,
  };
}
test('same shared kernel preserves Insight rasters and all existing range/size policies', () => {
  for (const [columns, bins] of [
    [1, 1],
    [7, 13],
    [32, 17],
  ])
    for (const [width, height] of [
      [1, 1],
      [3, 5],
      [64, 40],
    ])
      for (const options of [
        {},
        { time: { min: 0, max: 1.2 }, frequency: { min: 0, max: 16 } },
        { time: { min: 0.22, max: 0.51 }, frequency: { min: 3, max: 12 } },
      ]) {
        const p = payload(columns, bins),
          before = Float32Array.from(p.values);
        assert.deepEqual(
          shared.spectrogramPixels(p, width, height, options),
          legacy.spectrogramPixels(p, width, height, options),
        );
        assert.deepEqual(
          shared.spectrogramDisplayRanges(p, options),
          legacy.spectrogramDisplayRanges(p, options),
        );
        assert.deepEqual(p.values, before);
      }
});
test('single source-cell-width display retains legacy floating-boundary pooling', () => {
  const p = payload(214, 1025);
  p.sampleRate = 44100;
  p.duration = 2.48;
  p.values = Float32Array.from(
    { length: p.values.length },
    (_, i) => -100 + (i % 101),
  );
  assert.deepEqual(
    shared.spectrogramPixels(p, 214, 128),
    legacy.spectrogramPixels(p, 214, 128),
  );
});
test('empty and invalid inputs keep product errors; palette remains dBFS-specific only in adapter', () => {
  for (const p of [
    { ...payload(2, 3), columns: 0 },
    { ...payload(2, 3), duration: NaN },
    { ...payload(2, 3), values: new Float32Array(1) },
  ])
    assert.throws(() => shared.spectrogramPixels(p));
  for (const db of [-Infinity, NaN, Infinity, -100, -75, -50, -25, 0, 20])
    assert.deepEqual(shared.spectrogramColor(db), legacy.spectrogramColor(db));
  for (const options of [
    { time: { min: -1, max: 1 } },
    { frequency: { min: 0, max: Infinity } },
    { color: { min: 0, max: 0 } },
  ])
    assert.throws(() => shared.spectrogramPixels(payload(2, 3), 2, 3, options));
});
