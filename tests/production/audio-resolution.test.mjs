import test from 'node:test';
import assert from 'node:assert/strict';
import {
  audioFileKey,
  findAudio,
  resolveAudio,
} from '../../packages/domain/data.ts';
import {
  audioListDisplay,
  auditAudioMatches,
  folderAttributeCandidates,
  withFolderAttributes,
} from '../../packages/domain/audio-import.ts';
import { addAudioAttachments } from '../../src/lib/audio-attachments.ts';

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
  assert.equal(matched.reason, 'name-mismatch');
  assert.equal(
    findAudio(
      { id: 'normal01', audio_file: 'C:\\audio\\normal01.wav' },
      0,
      'id',
      'audio_file',
      matchedFiles,
    ),
    undefined,
  );
});

test('folder keys distinguish equal names, and basename-only references require a unique candidate', () => {
  const normal = file('001.wav');
  const review = file('001.wav');
  const files = new Map([
    ['正常/設備A/001.wav', normal],
    ['要確認/設備B/001.wav', review],
  ]);
  assert.equal(
    audioFileKey({
      name: '001.wav',
      webkitRelativePath: 'root/正常/設備A/001.wav',
    }),
    '正常/設備A/001.wav',
  );
  assert.equal(
    resolveAudio(
      { audio_file: '正常\\設備A\\001.wav' },
      0,
      '',
      'audio_file',
      files,
    ).file,
    normal,
  );
  assert.equal(
    resolveAudio(
      { audio_file: '要確認/設備B/001.wav' },
      1,
      '',
      'audio_file',
      files,
    ).file,
    review,
  );
  const ambiguous = resolveAudio(
    { audio_file: '001.wav' },
    2,
    '',
    'audio_file',
    files,
  );
  assert.equal(ambiguous.reason, 'ambiguous');
  assert.deepEqual(ambiguous.candidates, [...files.keys()]);
  assert.equal(
    resolveAudio({ audio_file: 'missing/001.wav' }, 3, '', 'audio_file', files)
      .reason,
    'name-mismatch',
  );
  assert.equal(
    resolveAudio(
      { audio_file: '001.wav' },
      0,
      '',
      'audio_file',
      new Map([['正常/設備A/001.wav', normal]]),
    ).file,
    normal,
  );
  assert.deepEqual(
    audioListDisplay(
      { id: '001' },
      0,
      'id',
      '',
      new Map([['正常/設備A/001.wav', normal]]),
    ),
    { filename: '001.wav', path: '正常/設備A/001.wav', status: '' },
  );
  assert.deepEqual(
    audioListDisplay(
      { audio_file: '正常/設備A/001.wav' },
      0,
      '',
      'audio_file',
      files,
    ),
    {
      filename: '001.wav',
      path: '正常/設備A/001.wav',
      status: '',
    },
  );
  const ambiguousDisplay = audioListDisplay(
    { audio_file: '001.wav' },
    2,
    '',
    'audio_file',
    files,
  );
  assert.deepEqual(ambiguousDisplay, {
    filename: '001.wav',
    path: '001.wav',
    status:
      '曖昧: 同名WAVが複数あります（候補: 正常/設備A/001.wav、要確認/設備B/001.wav）。CSVに相対パスを指定してください。',
  });
  const missingDisplay = audioListDisplay(
    { audio_file: 'missing.wav' },
    3,
    '',
    'audio_file',
    files,
  );
  assert.equal(missingDisplay.filename, 'missing.wav');
  assert.equal(missingDisplay.path, 'missing.wav');
  assert.match(missingDisplay.status, /CSVの音声値「missing\.wav」/);
  const noFolderDisplay = audioListDisplay(
    { audio_file: '001.wav' },
    0,
    '',
    'audio_file',
    new Map(),
  );
  assert.equal(noFolderDisplay.filename, '001.wav');
  assert.equal(noFolderDisplay.path, '001.wav');
  assert.match(noFolderDisplay.status, /WAVフォルダが未指定/);
  assert.match(
    audioListDisplay({ audio_file: '' }, 1, '', 'audio_file', files).status,
    /音声列「audio_file」が空欄/,
  );
});

test('audit lists missing, ambiguous, unused and repeated attachments before import', () => {
  const data = {
    name: 'inspection.csv',
    demo: false,
    columns: ['audio_file', 'score', 'group'],
    rows: [
      { audio_file: '正常/設備A/001.wav', score: '0.1', group: 'A' },
      { audio_file: '正常/設備A/001.wav', score: '0.2', group: 'A' },
      { audio_file: '001.wav', score: '0.3', group: 'B' },
      { audio_file: 'missing.wav', score: '0.4', group: 'B' },
    ],
  };
  const files = new Map([
    ['正常/設備A/001.wav', file('001.wav')],
    ['要確認/設備B/001.wav', file('001.wav')],
    ['未使用/other.wav', file('other.wav')],
  ]);
  const audit = auditAudioMatches(data, '', 'audio_file', files);
  assert.equal(audit.matched, 2);
  assert.deepEqual(
    audit.missing.map(({ row }) => row),
    [4],
  );
  assert.deepEqual(
    audit.ambiguous.map(({ row }) => row),
    [3],
  );
  assert.deepEqual(audit.unused, ['要確認/設備B/001.wav', '未使用/other.wav']);
  assert.deepEqual(audit.repeated, [
    { key: '正常/設備A/001.wav', rows: [1, 2] },
  ]);
  assert.deepEqual(folderAttributeCandidates(files)[0].values, [
    ['正常', 1],
    ['要確認', 1],
    ['未使用', 1],
  ]);
  assert.equal(withFolderAttributes(data, '', 'audio_file', files, []), data);
  const adopted = withFolderAttributes(data, '', 'audio_file', files, [1, 2]);
  assert.equal(adopted.rows[0]['WAVフォルダ階層1'], '正常');
  assert.equal(adopted.rows[0]['WAVフォルダ階層2'], '設備A');
  assert.equal(adopted.rows[2]['WAVフォルダ階層1'], '');
  assert.equal(data.rows[0]['WAVフォルダ階層1'], undefined);
});

test('batch addition keeps equal basenames in distinct folders and rejects duplicate paths atomically', () => {
  const one = { name: '001.wav', webkitRelativePath: 'root/正常/001.wav' };
  const two = { name: '001.wav', webkitRelativePath: 'root/要確認/001.wav' };
  const existing = new Map();
  const added = addAudioAttachments(existing, [one, two]);
  assert.deepEqual([...added.keys()], ['正常/001.wav', '要確認/001.wav']);
  assert.equal(existing.size, 0);
  assert.throws(() => addAudioAttachments(added, [one]), /相対パスが重複/);
  assert.equal(added.size, 2);
});
