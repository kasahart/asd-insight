/** Synthetic metadata/worker benchmark. No claim about decoding 100,000 recordings. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { serialize } from 'node:v8';
import { Worker } from 'node:worker_threads';
import { cpus, totalmem } from 'node:os';
import {
  withFolderAttributes,
  auditAudioMatches,
  folderMembershipSignature,
} from '../packages/domain/audio-import.ts';
import { datasetRows } from '../packages/domain/dataset-rows.ts';
import { resolveAudio } from '../packages/domain/data.ts';

const child = process.argv.indexOf('--case');
if (child < 0) {
  const counts = process.argv.slice(2).map(Number);
  const results = [];
  for (const count of counts.length ? counts : [1_000, 10_000, 100_000]) {
    for (const mode of ['copied', 'sparse']) {
      const run = spawnSync(
        process.execPath,
        ['--expose-gc', import.meta.filename, '--case', String(count), mode],
        { encoding: 'utf8', maxBuffer: 2 ** 20 },
      );
      if (run.error || run.status !== 0)
        throw new Error(run.error?.message || run.stderr || run.stdout);
      results.push(JSON.parse(run.stdout));
    }
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        cpu: cpus()[0].model,
        memoryGiB: totalmem() / 2 ** 30,
        results,
      },
      null,
      2,
    ),
  );
} else {
  assert.ok(global.gc, 'Run with --expose-gc');
  const count = Number(process.argv[child + 1]);
  const mode = process.argv[child + 2];
  assert.ok(Number.isSafeInteger(count) && count > 0);
  const columns = [
    'audio',
    'score',
    ...Array.from({ length: 126 }, (_, i) => `c${i}`),
  ];
  const source = {
    name: 'scale.csv',
    demo: false,
    columns,
    rows: Array.from({ length: count }, (_, i) =>
      Object.fromEntries(
        columns.map((c) => [
          c,
          c === 'audio'
            ? `${i % 2 ? 'b' : 'a'}/device/${i}.wav`
            : c === 'score'
              ? String(i / count)
              : '',
        ]),
      ),
    ),
  };
  const files = new Map(
    source.rows.map((row, i) => [
      row.audio,
      new File(['RIFF0000WAVE'], `${i}.wav`),
    ]),
  );
  global.gc();
  const initialHeap = process.memoryUsage().heapUsed;
  let highHeap = initialHeap;
  const observe = () => {
    highHeap = Math.max(highHeap, process.memoryUsage().heapUsed);
  };
  let start = performance.now();
  const audit = auditAudioMatches(source, '', 'audio', files);
  const auditMs = performance.now() - start;
  assert.equal(audit.matched, count);
  global.gc();
  const before = process.memoryUsage().heapUsed;
  start = performance.now();
  const data =
    mode === 'sparse'
      ? withFolderAttributes(source, '', 'audio', files, [1, 2])
      : {
          ...source,
          columns: [...columns, 'WAVフォルダ階層1', 'WAVフォルダ階層2'],
          rows: source.rows.map((row, i) => {
            const directories = resolveAudio(row, i, '', 'audio', files)
              .key.split('/')
              .slice(0, -1);
            return {
              ...row,
              WAVフォルダ階層1: directories[0],
              WAVフォルダ階層2: directories[1],
            };
          }),
        };
  const generationMs = performance.now() - start;
  const generationPreGcBytes = process.memoryUsage().heapUsed - before;
  observe();
  global.gc();
  const generationRetainedBytes = process.memoryUsage().heapUsed - before;
  const rows = datasetRows(data);
  const signature = folderMembershipSignature(rows, [
    'WAVフォルダ階層1',
    'WAVフォルダ階層2',
  ]);
  global.gc();
  const includingViewsRetainedBytes = process.memoryUsage().heapUsed - before;
  start = performance.now();
  const transferBytes = serialize(data).byteLength;
  const serializeMs = performance.now() - start;
  observe();
  const { rows: _rows, ...metadata } = data;
  const updateBytes = serialize(
    mode === 'sparse' ? { baseDatasetKey: 'base', dataset: metadata } : data,
  ).byteLength;
  const runtimeURL = new URL(
    '../packages/domain/evaluation-runtime.ts',
    import.meta.url,
  ).href;
  const worker = new Worker(
    `const { parentPort } = require('node:worker_threads');
    import(${JSON.stringify(runtimeURL)}).then(({ createEvaluationRuntime }) => {
      const runtime = createEvaluationRuntime();
      parentPort.on('message', request => { const response = runtime(request); global.gc?.(); parentPort.postMessage({ response, heap: process.memoryUsage().heapUsed }); });
    });`,
    { eval: true },
  );
  start = performance.now();
  const result = await new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.postMessage({
      workerGeneration: 1,
      requestId: 1,
      command: {
        kind: 'evaluate',
        datasetKey: 'scale',
        dataset: data,
        spec: {
          scoreColumn: 'score',
          group: {
            kind: 'category',
            column: 'WAVフォルダ階層1',
            a: 'a',
            b: 'b',
          },
          conditionFilter: { column: 'WAVフォルダ階層2', value: 'device' },
          direction: 'high',
          okGroup: 'A',
          list: {
            audioColumn: 'audio',
            sort: { column: '__path', desc: false },
          },
        },
      },
    });
  });
  const workerRoundTripMs = performance.now() - start;
  assert.equal(result.response.ok, true, JSON.stringify(result.response.error));
  assert.equal(
    result.response.result.a.length + result.response.result.b.length,
    count,
  );
  assert.equal(result.response.result.listing.listedIndices.length, count);
  observe();
  await worker.terminate();
  assert.equal(source.rows.length, count);
  assert.equal(Object.keys(source.rows[0]).length, 128);
  console.log(
    JSON.stringify({
      count,
      wavCount: files.size,
      csvColumns: columns.length,
      mode,
      auditMs,
      generationMs,
      generationPreGcBytes,
      generationRetainedBytes,
      includingViewsRetainedBytes,
      transferBytes,
      updateBytes,
      serializeMs,
      workerRoundTripMs,
      workerComputeMs: result.response.elapsedMs,
      workerPostEvaluationHeapBytes: result.heap,
      observedMainHeapHighBytes: highHeap,
      processPeakRssKiB: process.resourceUsage().maxRSS,
      signature,
    }),
  );
}
