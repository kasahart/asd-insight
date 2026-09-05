import test from 'node:test';
import assert from 'node:assert/strict';
import { findAudio, resolveAudio } from '../../packages/domain/data.ts';

const file = (name) => ({ name });

test('audio resolution reports only evidence from the existing matching rule', () => {
  const empty = resolveAudio(
    { id: 'normal01', audio_file: 'normal01.wav' },
    0,
    'id',
    'audio_file',
    new Map(),
  );
  assert.equal(empty.reason, 'no-files');

  const blankColumn = resolveAudio(
    { id: 'normal02', audio_file: '' },
    1,
    'id',
    'audio_file',
    new Map([['normal01.wav', file('normal01.wav')]]),
  );
  assert.equal(blankColumn.reason, 'audio-column-empty');
  assert.equal(blankColumn.sourceColumn, 'audio_file');

  const blankId = resolveAudio(
    { id: '', audio_file: '' },
    2,
    'id',
    '',
    new Map([['normal01.wav', file('normal01.wav')]]),
  );
  assert.equal(blankId.reason, 'source-id-empty');

  const emptyIdExtensionFallback = resolveAudio(
    { id: '' },
    2,
    'id',
    '',
    new Map([['.wav', file('.wav')]]),
  );
  assert.equal(emptyIdExtensionFallback.reason, 'matched');
  assert.equal(emptyIdExtensionFallback.file.name, '.wav');

  const mismatch = resolveAudio(
    { id: 'normal03' },
    3,
    'id',
    '',
    new Map([['normal01.wav', file('normal01.wav')]]),
  );
  assert.equal(mismatch.reason, 'name-mismatch');
  assert.deepEqual(mismatch.expectedNames.slice(0, 2), [
    'normal03',
    'normal03.wav',
  ]);

  const matchedFile = file('normal01.wav');
  const matchedFiles = new Map([['normal01.wav', matchedFile]]);
  const matched = resolveAudio(
    { id: 'normal01', audio_file: 'C:\\audio\\normal01.wav' },
    0,
    'id',
    'audio_file',
    matchedFiles,
  );
  assert.equal(matched.reason, 'matched');
  assert.equal(matched.file.name, 'normal01.wav');
  assert.equal(
    findAudio(
      { id: 'normal01', audio_file: 'C:\\audio\\normal01.wav' },
      0,
      'id',
      'audio_file',
      matchedFiles,
    ),
    matched.file,
  );
});
