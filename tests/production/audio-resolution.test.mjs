import { datasetRows } from '../../packages/domain/dataset-rows.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  audioFileKey,
  findAudio,
  resolveAudio,
} from '../../packages/domain/data.ts';
import {
  AUDIO_PREVIEW_ITEM_LIMIT,
  AUDIO_REASON_CANDIDATE_LIMIT,
  MAX_FOLDER_LEVELS,
  audioListDisplay,
  auditAudioMatches,
  folderAttributeCandidates,
  folderMembershipSignature,
  previewItems,
  sourceColumnSelection,
  summarizeAudioCandidates,
  withFolderAttributes,
} from '../../packages/domain/audio-import.ts';
import { addAudioAttachments } from '../../src/lib/audio-attachments.ts';
import {
  derivedPopulationSignature,
  evaluationPopulationKey,
} from '../../packages/domain/sample-review.ts';

const file = (name) => ({ name });

test('population keys keep the exact saved format when derived columns are unused', () => {
  const legacyParts = [
    'dataset-hash',
    'evaluation-v1',
    'score',
    { kind: 'category', column: 'group', a: 'A', b: 'B' },
    '',
    '',
    [],
    'A',
    'high',
  ];
  const legacyKey = JSON.stringify(legacyParts);
  assert.equal(evaluationPopulationKey(legacyParts, ''), legacyKey);
  assert.equal(
    evaluationPopulationKey(legacyParts, '2:123:456'),
    JSON.stringify([...legacyParts, '2:123:456']),
  );
});

test('derived population signature follows active folder memberships only', () => {
  const dataset = {
    name: 'audio.csv',
    demo: false,
    columns: ['score', 'label', 'folder', 'unused_folder'],
    rows: [
      { score: '1', label: 'OK', folder: 'A', unused_folder: 'x' },
      { score: '2', label: 'NG', folder: 'B', unused_folder: 'y' },
    ],
  };
  const group = { kind: 'category', column: 'folder', a: 'A', b: 'B' };
  const empty = new Set();
  const initial = derivedPopulationSignature(dataset, group, null, empty, [
    'folder',
    'unused_folder',
  ]);
  const onlyUnselectedFolderChanged = {
    ...dataset,
    rows: dataset.rows.map((row, index) => ({
      ...row,
      unused_folder: `changed-${index}`,
    })),
  };
  assert.equal(
    derivedPopulationSignature(
      onlyUnselectedFolderChanged,
      group,
      null,
      empty,
      ['folder', 'unused_folder'],
    ),
    initial,
  );
  const attached = {
    ...dataset,
    rows: dataset.rows.map((row, index) => ({
      ...row,
      folder: index === 0 ? 'B' : 'A',
    })),
  };
  assert.notEqual(
    derivedPopulationSignature(attached, group, null, empty, ['folder']),
    initial,
  );

  const filterGroup = { kind: 'category', column: 'label', a: 'OK', b: 'NG' };
  const condition = { column: 'folder', value: 'A' };
  const beforeFilterPopulation = derivedPopulationSignature(
    dataset,
    filterGroup,
    condition,
    empty,
    ['folder'],
  );
  assert.notEqual(
    derivedPopulationSignature(attached, filterGroup, condition, empty, [
      'folder',
    ]),
    beforeFilterPopulation,
  );
});

test('folder membership signatures are deterministic and change with row placement', () => {
  const rows = [
    { score: '0.1', folder: '正常' },
    { score: '0.9', folder: '要確認' },
  ];
  const signature = folderMembershipSignature(rows, ['folder']);
  assert.match(signature, /^fm1-[0-9a-f]{16}$/);
  assert.equal(folderMembershipSignature(rows, ['folder']), signature);
  assert.notEqual(
    folderMembershipSignature([rows[1], rows[0]], ['folder']),
    signature,
  );
  assert.notEqual(folderMembershipSignature(rows, ['score']), signature);
});

test('preview rows are bounded and saved source-column choices ignore derived columns', () => {
  const values = Array.from({ length: 10_000 }, (_, index) => index);
  assert.deepEqual(
    previewItems(values),
    values.slice(0, AUDIO_PREVIEW_ITEM_LIMIT),
  );
  assert.equal(
    sourceColumnSelection(['score', 'audio_file'], 'audio_file'),
    'audio_file',
  );
  assert.equal(
    sourceColumnSelection(['score', 'audio_file'], 'WAVフォルダ階層1'),
    '',
  );
  const data = {
    name: 'legacy.csv',
    demo: false,
    columns: ['sample_id', 'audio_file', 'score'],
    rows: [
      {
        sample_id: '001',
        audio_file: '設備A/正常/001.wav',
        score: '0.1',
      },
    ],
  };
  const audioColumn = sourceColumnSelection(data.columns, 'WAVフォルダ階層1');
  const attached = withFolderAttributes(
    data,
    'sample_id',
    audioColumn,
    new Map([['設備A/正常/001.wav', file('001.wav')]]),
    [1, 2],
  );
  assert.equal(datasetRows(attached)[0]['WAVフォルダ階層1'], '設備A');
  assert.equal(datasetRows(attached)[0]['WAVフォルダ階層2'], '正常');
});

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
    {
      filename: '行1',
      path: '',
      status: '',
      identifier: '001',
    },
  );
  assert.deepEqual(
    audioListDisplay({ id: 'sample-02' }, 1, 'id', '', new Map()),
    {
      filename: '行2',
      path: '',
      status:
        '未対応: WAVフォルダが未指定です。WAVフォルダを選択してください。',
      identifier: 'sample-02',
    },
  );
  assert.deepEqual(
    audioListDisplay(
      { id: 'SERIAL-C-003', audio_file: '  ' },
      2,
      'id',
      'audio_file',
      files,
    ),
    {
      filename: '行3',
      path: '  ',
      status: '未対応: 音声列「audio_file」が空欄です。',
      identifier: 'SERIAL-C-003',
    },
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
      identifier: '',
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
    identifier: '',
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

test('ambiguous audio reasons show a bounded candidate sample and total', () => {
  const count = AUDIO_REASON_CANDIDATE_LIMIT + 17;
  const candidates = Array.from(
    { length: count },
    (_, index) => `folder-${index}/shared.wav`,
  );
  const summary = summarizeAudioCandidates(candidates);
  assert.ok(summary.includes(candidates[0]));
  assert.ok(summary.includes(candidates[AUDIO_REASON_CANDIDATE_LIMIT - 1]));
  assert.ok(summary.includes(`ほか17件`));
  assert.ok(!summary.includes(candidates.at(-1)));

  const display = audioListDisplay(
    { audio_file: 'shared.wav' },
    0,
    '',
    'audio_file',
    new Map(candidates.map((key) => [key, file('shared.wav')])),
  );
  assert.match(display.status, /ほか17件/);
  assert.ok(!display.status.includes(candidates.at(-1)));
});

test('basename indexing keeps a large same-name candidate set intact', () => {
  const count = 8_000;
  const files = new Map(
    Array.from({ length: count }, (_, index) => [
      `folder-${index}/shared.wav`,
      file('shared.wav'),
    ]),
  );
  const result = resolveAudio(
    { audio_file: 'shared.wav' },
    0,
    '',
    'audio_file',
    files,
  );
  assert.equal(result.reason, 'ambiguous');
  assert.equal(result.candidates.length, count);
  assert.equal(result.candidates[0], 'folder-0/shared.wav');
  assert.equal(result.candidates.at(-1), `folder-${count - 1}/shared.wav`);
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
  assert.equal(datasetRows(adopted)[0]['WAVフォルダ階層1'], '正常');
  assert.equal(datasetRows(adopted)[0]['WAVフォルダ階層2'], '設備A');
  assert.equal(datasetRows(adopted)[2]['WAVフォルダ階層1'], '');
  assert.equal(data.rows[0]['WAVフォルダ階層1'], undefined);
});

test('audit retains all row numbers for a large repeated-reference set', () => {
  const count = 8_000;
  const data = {
    name: 'many-rows.csv',
    demo: false,
    columns: ['audio_file'],
    rows: Array.from({ length: count }, () => ({ audio_file: 'shared.wav' })),
  };
  const audit = auditAudioMatches(
    data,
    '',
    'audio_file',
    new Map([['shared.wav', file('shared.wav')]]),
  );
  assert.equal(audit.repeated.length, 1);
  assert.equal(audit.repeated[0].rows.length, count);
  assert.equal(audit.repeated[0].rows[0], 1);
  assert.equal(audit.repeated[0].rows.at(-1), count);
});

test('folder levels over the supported limit are reported instead of dropped', () => {
  const path = [
    ...Array.from(
      { length: MAX_FOLDER_LEVELS + 1 },
      (_, index) => `L${index + 1}`,
    ),
    'deep.wav',
  ].join('/');
  const files = new Map([[path, file('deep.wav')]]);
  const data = {
    name: 'deep.csv',
    demo: false,
    columns: ['audio_file', 'score'],
    rows: [{ audio_file: path, score: '0.5' }],
  };
  const levels = folderAttributeCandidates(files).map(({ level }) => level);
  assert.equal(levels.length, MAX_FOLDER_LEVELS + 1);
  assert.throws(
    () => withFolderAttributes(data, '', 'audio_file', files, levels),
    /64階層まで分析条件に追加できます/,
  );
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
