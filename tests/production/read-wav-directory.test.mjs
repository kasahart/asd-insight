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
  const files = await readWavDirectory(root, 10);
  assert.deepEqual(files.map(audioFileKey), [
    '正常/設備A/001.wav',
    '要確認/設備B/001.WAV',
  ]);
  assert.equal(files[0].webkitRelativePath, 'audio/正常/設備A/001.wav');
  assert.equal(files[0].size, 4);
});

test('directory picker stops before exceeding the WAV count limit', async () => {
  const root = directory('audio', {
    'one.wav': file('one.wav'),
    'two.wav': file('two.wav'),
  });
  await assert.rejects(readWavDirectory(root, 1), /1件まで追加できます/);
});
