import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { EvaluationWorkerClient } from '../../packages/domain/evaluation-client.ts';
import { CSVColumnCountError } from '../../packages/domain/csv-diagnostics.ts';

const runtimeURL = new URL(
  '../../packages/domain/evaluation-runtime.ts',
  import.meta.url,
).href;
const clients = new Set();
const terminations = [];
afterEach(async () => {
  for (const client of clients) client.dispose();
  clients.clear();
  await Promise.all(terminations.splice(0));
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const dataset = (name = 'same.csv', count = 20) => ({
  name,
  demo: false,
  columns: ['name', 'score', 'label'],
  rows: Array.from({ length: count }, (_, index) => ({
    name: `sample-${index}`,
    score: String(index),
    label: index % 2 ? 'NG' : 'OK',
  })),
});
const spec = {
  scoreColumn: 'score',
  group: { kind: 'category', column: 'label', a: 'OK', b: 'NG' },
  okGroup: 'A',
  direction: 'high',
};

function transport({ stall = false, messages } = {}) {
  const worker = new Worker(
    `
    const { parentPort } = require('node:worker_threads');
    import(${JSON.stringify(runtimeURL)}).then(({ createEvaluationRuntime }) => {
      const runtime = createEvaluationRuntime();
      parentPort.on('message', request => {
        ${stall ? 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);' : ''}
        parentPort.postMessage(runtime(request));
      });
    });
  `,
    { eval: true },
  );
  return {
    postMessage(message) {
      messages?.push({
        generation: message.workerGeneration,
        id: message.requestId,
        hasDataset: !!message.command.dataset,
      });
      worker.postMessage(message);
    },
    terminate() {
      terminations.push(worker.terminate());
    },
    onMessage(listener) {
      worker.on('message', listener);
      return () => worker.off('message', listener);
    },
    onError(listener) {
      worker.on('error', listener);
      worker.on('messageerror', listener);
      return () => {
        worker.off('error', listener);
        worker.off('messageerror', listener);
      };
    },
  };
}
function client(options = {}) {
  const instance = new EvaluationWorkerClient({
    createWorker: () => transport(),
    ...options,
  });
  clients.add(instance);
  return instance;
}

test('real worker parses/profiles/evaluates and transfers a dataset only once per generation', async () => {
  const sent = [];
  const engine = client({ createWorker: () => transport({ messages: sent }) });
  const imported = await engine.parseCSV(
    'name,score,label\na,1,OK\nb,2,NG',
    'synthetic.csv',
  );
  assert.equal(
    imported.profiles.find((p) => p.column === 'score').validNumbers,
    2,
  );
  assert.equal((await engine.profile(imported.dataset)).length, 3);
  const result = await engine.evaluate({
    dataset: imported.dataset,
    ...spec,
    threshold: { kind: 'ok-rate', targetPercent: 1 },
  });
  assert.equal(result.evaluation.auc, 1);
  assert.equal(result.thresholdReport.groupB.detected, 1);
  assert.deepEqual(
    sent.map((message) => message.hasDataset),
    [false, true, false],
  );
  assert.ok(Number.isFinite(engine.lastElapsedMs));
});

test('same-name replacement never reuses the old dataset or exclusion result', async () => {
  const engine = client();
  const first = dataset('same.csv', 20),
    second = dataset('same.csv', 4);
  const before = await engine.evaluate({
    dataset: first,
    ...spec,
    ignoredIndices: [0],
  });
  const after = await engine.evaluate({ dataset: second, ...spec });
  assert.equal(before.summary.total, 19);
  assert.equal(after.summary.total, 4);
  assert.equal(after.comparison.ignoredRows, 0);
});

test('CSV diagnostics survive a real worker boundary as the existing error type', async () => {
  const engine = client();
  await assert.rejects(
    engine.parseCSV('score,label\n1,OK,extra', 'bad.csv'),
    (error) =>
      error instanceof CSVColumnCountError &&
      error.diagnostic.dataRow === 1 &&
      error.diagnostic.rawRecord.includes('extra'),
  );
  const recovered = await engine.parseCSV('score,label\n1,OK\n2,NG');
  assert.equal(recovered.dataset.rows.length, 2);
});

test('superseding active CPU work terminates that worker and resends data in a new generation', async () => {
  const sent = [];
  let generation = 0;
  const engine = client({
    createWorker: () =>
      transport({ stall: generation++ === 0, messages: sent }),
  });
  const input = { dataset: dataset(), ...spec };
  const pending = engine.evaluate(input);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await delay(30);
  const start = performance.now();
  const current = await engine.evaluate({ ...input, ignoredIndices: [0] });
  await rejected;
  assert.equal(current.summary.total, 19);
  assert.equal(generation, 2);
  assert.notEqual(sent[0].generation, sent[1].generation);
  assert.equal(sent[1].hasDataset, true);
  assert.ok(
    performance.now() - start < 3000,
    'must not wait for the cancelled five-second workload',
  );
});

test('deadline physically terminates a busy worker; a later request recovers', async () => {
  let generation = 0;
  const engine = client({
    createWorker: () => transport({ stall: generation++ === 0 }),
  });
  const input = { dataset: dataset(), ...spec };
  await assert.rejects(engine.evaluate(input, { timeoutMs: 60 }), {
    name: 'TimeoutError',
  });
  const result = await engine.evaluate(input);
  assert.equal(result.summary.total, 20);
  assert.equal(generation, 2);
});

test('AbortSignal and disposal settle outstanding promises instead of leaving a queued result', async () => {
  const engine = client({ createWorker: () => transport({ stall: true }) });
  const controller = new AbortController();
  const pending = engine.evaluate(
    { dataset: dataset(), ...spec },
    { signal: controller.signal },
  );
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  controller.abort();
  await rejected;
  engine.dispose();
  await assert.rejects(engine.profile(dataset()), {
    name: 'InvalidStateError',
  });
});

test('late events from an old generation and wrong request IDs cannot resolve the current request', async () => {
  const ports = [];
  const engine = client({
    createWorker: () => {
      const port = {
        postMessage(message) {
          this.request = message;
        },
        terminate() {},
        onMessage(listener) {
          this.deliver = listener;
          return () => {};
        },
        onError() {
          return () => {};
        },
      };
      ports.push(port);
      return port;
    },
  });
  const first = engine.profile(dataset());
  const rejected = assert.rejects(first, { name: 'AbortError' });
  const second = engine.profile(dataset());
  await rejected;
  let settled = false;
  void second.then(() => {
    settled = true;
  });
  const expected = ports[1].request;
  ports[0].deliver({
    ...expected,
    ok: true,
    kind: 'profile',
    result: ['wrong-old-port'],
    elapsedMs: 0,
  });
  ports[1].deliver({
    ...expected,
    requestId: expected.requestId - 1,
    ok: true,
    kind: 'profile',
    result: ['wrong-request'],
    elapsedMs: 0,
  });
  await delay(5);
  assert.equal(settled, false);
  ports[1].deliver({
    ...expected,
    ok: true,
    kind: 'profile',
    result: [],
    elapsedMs: 1,
  });
  assert.deepEqual(await second, []);
});

test('100,000-row evaluation executes off the main thread and returns conserved counts', async (t) => {
  const engine = client({ timeoutMs: 20_000 });
  const source = dataset('synthetic-100k.csv', 100_000);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 2);
  const start = performance.now();
  let result;
  try {
    result = await engine.evaluate({
      dataset: source,
      ...spec,
      ignoredIndices: [0, 99999],
      threshold: { kind: 'ok-rate', targetPercent: 1 },
      list: {
        range: { lo: 90000, hi: 99999, includeHi: true },
        decisionFilter: 'false-positive',
        sort: { column: '__score', desc: true },
      },
    });
  } finally {
    clearInterval(timer);
  }
  assert.equal(result.summary.total, 99_998);
  assert.equal(result.comparison.ignoredRows, 2);
  assert.equal(result.thresholdReport.calibration.referenceCount, 49_999);
  assert.ok(result.thresholdReport.calibration.actualPercent <= 1);
  assert.equal(result.listing.listedIndices[0], 99999);
  assert.ok(
    ticks > 1,
    'the caller event loop must continue while the worker calculates',
  );
  t.diagnostic(
    `100k rows: round trip ${Math.round(performance.now() - start)} ms, worker ${Math.round(engine.lastElapsedMs)} ms, caller ticks ${ticks}`,
  );
});

test('100,000-row, 20-numeric-column CSV parsing and profiling stay in the worker', async (t) => {
  const engine = client({ timeoutMs: 20_000 });
  const columns = [
    'sample_id',
    'label',
    ...Array.from({ length: 20 }, (_, i) => `score_${i}`),
  ];
  const records = Array.from({ length: 100_000 }, (_, row) =>
    [
      `s${row}`,
      row % 2 ? 'NG' : 'OK',
      ...Array.from({ length: 20 }, (_, column) =>
        String(((row + column) % 10000) / 10),
      ),
    ].join(','),
  );
  const csv = `${columns.join(',')}\n${records.join('\n')}`;
  let ticks = 0;
  const timer = setInterval(() => ticks++, 2);
  const start = performance.now();
  let result;
  try {
    result = await engine.parseCSV(csv, 'synthetic-100k-20-columns.csv');
  } finally {
    clearInterval(timer);
  }
  assert.equal(result.dataset.rows.length, 100_000);
  assert.equal(result.profiles.length, 22);
  for (const profile of result.profiles.filter((p) =>
    p.column.startsWith('score_'),
  ))
    assert.equal(profile.validNumbers, 100_000);
  assert.ok(ticks > 1);
  assert.ok(engine.lastElapsedMs > 0);
  t.diagnostic(
    `100k rows × 20 numeric columns: ${Math.round(csv.length / 1024 / 1024)} MiB CSV, round trip ${Math.round(performance.now() - start)} ms, worker ${Math.round(engine.lastElapsedMs)} ms, caller ticks ${ticks}`,
  );
});

test('sorting the complete 100,000-row list preserves numeric filename order without blocking the caller', async (t) => {
  const engine = client({ timeoutMs: 20_000 });
  const source = dataset('synthetic-sort-100k.csv', 100_000);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 2);
  const start = performance.now();
  let result;
  try {
    result = await engine.evaluate({
      dataset: source,
      ...spec,
      ignoredIndices: [0, 99999],
      list: { idColumn: 'name', sort: { column: '__sample', desc: true } },
    });
  } finally {
    clearInterval(timer);
  }
  assert.deepEqual(
    result.listing.listedIndices,
    Array.from({ length: 100_000 }, (_, i) => 99999 - i),
  );
  assert.deepEqual(result.listing.ignoredIndices, [99999, 0]);
  assert.equal(result.listing.includedIndices.length, 99_998);
  assert.ok(ticks > 1);
  t.diagnostic(
    `100k complete list natural sort: round trip ${Math.round(performance.now() - start)} ms, worker ${Math.round(engine.lastElapsedMs)} ms, caller ticks ${ticks}`,
  );
});
