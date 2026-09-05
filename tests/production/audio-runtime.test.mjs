import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioRuntime } from '../../packages/audio-runtime/client.ts';
import { validateAudioAnalysis } from '../../packages/audio-runtime/contracts.ts';
const fixture = () => ({
  sampleRate: 16000,
  channels: 1,
  duration: 1,
  wave: [{ min: -1, max: 1 }],
  spectrogram: {
    values: new Float32Array(1025),
    columns: 1,
    frequencyBins: 1025,
    sampleRate: 16000,
    duration: 1,
    fftSize: 2048,
    hopSize: 512,
    frameCount: 1,
    minDb: -100,
    maxDb: 0,
  },
  recipe: { engine: 'wandas', engineVersion: '0.7.2', unit: 'dBFS' },
  runtimeLockHash: 'a'.repeat(64),
  sourceHash: 'b'.repeat(64),
});
class FakeWorker {
  onmessage = null;
  onerror = null;
  onmessageerror = null;
  terminated = false;
  request = null;
  postMessage(request, transfer) {
    this.request = request;
    this.transfer = transfer;
  }
  terminate() {
    this.terminated = true;
  }
  emit(payload, request = this.request) {
    this.onmessage?.({
      data: {
        ...payload,
        requestId: request.requestId,
        generation: request.generation,
      },
    });
  }
}
function setup(timeoutMs = 1000) {
  const ports = [];
  const runtime = createAudioRuntime({
    createWorker() {
      const worker = new FakeWorker();
      ports.push(worker);
      return worker;
    },
    baseUrl: 'https://app.invalid/runtime/audio/',
    timeoutMs,
  });
  return { runtime, ports };
}
const input = () => new ArrayBuffer(48);
test('one worker survives success; source bytes are copied and phases are explicit', async () => {
  const { runtime, ports } = setup();
  const phases = [];
  const bytes = input();
  const promise = runtime.analyzeWav(bytes, { onPhase: (p) => phases.push(p) });
  assert.notEqual(ports[0].request.bytes, bytes);
  assert.equal(bytes.byteLength, 48);
  assert.equal(ports[0].transfer[0], ports[0].request.bytes);
  ports[0].emit({ type: 'phase', phase: 'initializing' });
  ports[0].emit({ type: 'phase', phase: 'analyzing' });
  ports[0].emit({ type: 'result', result: fixture() });
  assert.equal((await promise).channels, 1);
  assert.deepEqual(phases, ['initializing', 'analyzing']);
  const second = runtime.analyzeWav(input());
  assert.equal(ports.length, 1);
  ports[0].emit({ type: 'result', result: fixture() });
  await second;
  runtime.dispose();
});
test('superseding a synchronous job terminates its worker and ignores late response/error', async () => {
  const { runtime, ports } = setup();
  const first = runtime.analyzeWav(input());
  const rejection = assert.rejects(first, { name: 'AbortError' });
  const old = ports[0];
  const oldMessage = old.onmessage,
    oldError = old.onerror,
    oldMessageError = old.onmessageerror;
  const second = runtime.analyzeWav(input());
  await rejection;
  assert.equal(old.terminated, true);
  assert.equal(ports.length, 2);
  oldMessage({ data: { ...old.request, type: 'result', result: fixture() } });
  oldError({});
  oldMessageError({});
  assert.equal(ports[1].terminated, false);
  // A wrong generation/id from the live port must also be ignored.
  ports[1].emit({ type: 'error', message: 'old' }, old.request);
  ports[1].emit({ type: 'result', result: fixture() });
  await second;
  runtime.dispose();
});
test('abort kills Python work and retry uses a fresh worker', async () => {
  const { runtime, ports } = setup();
  const controller = new AbortController();
  const pending = runtime.analyzeWav(input(), { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  controller.abort();
  await rejected;
  assert.equal(ports[0].terminated, true);
  const retry = runtime.analyzeWav(input());
  ports[1].emit({ type: 'result', result: fixture() });
  await retry;
  runtime.dispose();
});
test('timeout kills unresponsive worker and does not poison the next analysis', async () => {
  const { runtime, ports } = setup(15);
  await assert.rejects(runtime.analyzeWav(input()), /時間上限/);
  assert.equal(ports[0].terminated, true);
  const retry = runtime.analyzeWav(input());
  ports[1].emit({ type: 'result', result: fixture() });
  await retry;
  runtime.dispose();
});
test('worker failure is rejected and malformed outputs are never exposed', async () => {
  const { runtime, ports } = setup();
  const first = runtime.analyzeWav(input());
  const rejected = assert.rejects(first, /破損/);
  ports[0].emit({ type: 'error', message: '破損WAV' });
  await rejected;
  const second = runtime.analyzeWav(input());
  const malformed = fixture();
  malformed.spectrogram.values[0] = Infinity;
  ports[1].emit({ type: 'result', result: malformed });
  await assert.rejects(second, /契約/);
  assert.equal(ports[1].terminated, true);
  runtime.dispose();
});
test('empty/oversized/pre-aborted inputs allocate no worker', async () => {
  const { runtime, ports } = setup();
  await assert.rejects(runtime.analyzeWav(new ArrayBuffer(0)), /80MB/);
  await assert.rejects(
    runtime.analyzeWav(new ArrayBuffer(80 * 1024 * 1024 + 1)),
    /80MB/,
  );
  const signal = AbortSignal.abort();
  await assert.rejects(runtime.analyzeWav(input(), { signal }), {
    name: 'AbortError',
  });
  assert.equal(ports.length, 0);
  runtime.dispose();
});
test('result contract rejects inconsistent source coordinates and nonfinite wave', () => {
  for (const mutate of [
    (r) => (r.duration = 0),
    (r) => (r.sampleRate = 48000),
    (r) => (r.channels = 9),
    (r) => (r.spectrogram.columns = 513),
    (r) => (r.wave[0].max = NaN),
    (r) => (r.recipe.engine = 'other'),
    (r) => (r.runtimeLockHash = 'unlocked'),
  ]) {
    const result = fixture();
    mutate(result);
    assert.throws(() => validateAudioAnalysis(result), /契約/);
  }
});
