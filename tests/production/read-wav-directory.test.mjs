import assert from 'node:assert/strict';
import test from 'node:test';
import { readWavDirectory } from '../../src/lib/read-wav-directory.ts';
import { audioFileKey } from '../../packages/domain/data.ts';

function directory(name, children) {
  return {
    kind: 'directory',
    name,
    async *entries() {
      yield* Object.entries(children);
    },
  };
}

function file(name) {
  return {
    kind: 'file',
    name,
    async getFile() {
      return new File(['RIFF'], name, { type: 'audio/wav' });
    },
  };
}

test('directory picker files keep the same relative keys as webkitdirectory', async () => {
  const root = directory('audio', {
    'readme.txt': file('readme.txt'),
    正常: directory('正常', {
      設備A: directory('設備A', { '001.wav': file('001.wav') }),
    }),
    要確認: directory('要確認', {
      設備B: directory('設備B', { '001.WAV': file('001.WAV') }),
    }),
  });
  const files = await readWavDirectory(root);
  assert.deepEqual(files.map(audioFileKey), [
    '正常/設備A/001.wav',
    '要確認/設備B/001.WAV',
  ]);
  assert.equal(files[0].webkitRelativePath, 'audio/正常/設備A/001.wav');
  assert.equal(files[0].size, 4);
});

test('directory picker accepts more than the former 2,000 WAV limit', async () => {
  const root = directory('audio', Object.fromEntries(
    Array.from({ length: 2001 }, (_, index) => [`${index}.wav`, file(`${index}.wav`)]),
  ));
  const files = await readWavDirectory(root);
  assert.equal(files.length, 2001);
  assert.equal(audioFileKey(files.at(-1)), '2000.wav');
});

test('cancelled traversal stops before another getFile and never returns a partial folder', async () => {
  const abort = new AbortController();
  let reads = 0;
  const handle = name => ({ kind: 'file', name, async getFile() { reads++; abort.abort(); return new File(['RIFF'], name); } });
  await assert.rejects(readWavDirectory(directory('root', { 'a.wav': handle('a.wav'), 'b.wav': handle('b.wav') }), abort.signal), { name: 'AbortError' });
  assert.equal(reads, 1);
});
