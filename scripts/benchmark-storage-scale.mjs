/** Synthetic valid, tiny WAVs; fake IndexedDB/OPFS test adapter, not disk throughput. */
import assert from 'node:assert/strict';
import { fixture } from '../tests/production/storage-helpers.mjs';
import { createBrowserRepository } from '../packages/browser-storage/index.ts';
import {
  withFolderAttributes,
  auditAudioMatches,
  folderMembershipSignature,
} from '../packages/domain/audio-import.ts';
import { datasetRows } from '../packages/domain/dataset-rows.ts';

const count = Number(process.argv[2] ?? 100_000);
assert.ok(Number.isSafeInteger(count) && count > 0);
const dataset = {
  name: 'scale.csv',
  demo: false,
  columns: ['audio', 'score', 'group'],
  rows: [],
};
const files = new Map();
for (let i = 0; i < count; i++) {
  const key = `${i % 2 ? 'b' : 'a'}/device/${i}.wav`;
  const bytes = new Uint8Array(48);
  const view = new DataView(bytes.buffer);
  for (const [offset, value] of [
    [0, 'RIFF'],
    [8, 'WAVE'],
    [12, 'fmt '],
    [36, 'data'],
  ])
    bytes.set(new TextEncoder().encode(value), offset);
  view.setUint32(4, 40, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 32, true);
  view.setUint32(40, 4, true);
  view.setUint32(44, i, true);
  files.set(
    key,
    new File([bytes], `${i}.wav`, { type: 'audio/wav', lastModified: 0 }),
  );
  dataset.rows.push({
    audio: key,
    score: String(i / count),
    group: i % 2 ? 'b' : 'a',
  });
}
const signature = (data) =>
  folderMembershipSignature(datasetRows(data), [
    'WAVフォルダ階層1',
    'WAVフォルダ階層2',
  ]);
const expected = signature(
  withFolderAttributes(dataset, '', 'audio', files, [1, 2]),
);
const f = fixture();
let repository = await createBrowserRepository(f.options);
const timings = {};
async function measured(name, operation) {
  const start = performance.now();
  const result = await operation();
  timings[name] = performance.now() - start;
  return result;
}
const record = await measured('createMs', () =>
  repository.createSession({
    title: 'scale',
    dataset,
    state: { folderLevels: [1, 2] },
    audioFiles: files,
  }),
);
repository.close();
repository = await createBrowserRepository(f.options);
const loaded = await measured('reopenMs', () =>
  repository.loadSession(record.id),
);
assert.equal(loaded.audioFiles.size, count);
assert.deepEqual(loaded.dataset, dataset);
assert.equal(
  auditAudioMatches(loaded.dataset, '', 'audio', loaded.audioFiles).matched,
  count,
);
assert.equal(
  signature(
    withFolderAttributes(
      loaded.dataset,
      '',
      'audio',
      loaded.audioFiles,
      [1, 2],
    ),
  ),
  expected,
);
const bundle = await measured('exportMs', () =>
  repository.exportBundle(record.id),
);
// Import in a fresh repository so the existing total budget is irrelevant.
const restoredRepository = await createBrowserRepository(fixture().options);
const restored = await measured('importMs', () =>
  restoredRepository.importBundle(bundle),
);
assert.equal(restored.audioFiles.size, count);
assert.equal(
  signature(
    withFolderAttributes(
      restored.dataset,
      '',
      'audio',
      restored.audioFiles,
      [1, 2],
    ),
  ),
  expected,
);
assert.equal(
  (
    await restored.audioFiles
      .get(`${(count - 1) % 2 ? 'b' : 'a'}/device/${count - 1}.wav`)
      .arrayBuffer()
  ).byteLength,
  48,
);
repository.close();
restoredRepository.close();
console.log(
  JSON.stringify(
    {
      count,
      columns: dataset.columns.length,
      wavBytesEach: 48,
      bundleBytes: bundle.size,
      ...timings,
      signature: expected,
      peakRssKiB: process.resourceUsage().maxRSS,
    },
    null,
    2,
  ),
);
