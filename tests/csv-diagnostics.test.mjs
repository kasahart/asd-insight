import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV } from '../lib/data.ts';
import {
  CSVColumnCountError,
  CSV_DIAGNOSTIC_LIMITS,
} from '../lib/csv-diagnostics.ts';

function columnError(csv, name = 'measurements.csv') {
  let error;
  try {
    parseCSV(csv, name);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof CSVColumnCountError, error?.message);
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'CSVColumnCountError');
  assert.equal(error.diagnostic.kind, 'column-count');
  return error;
}

const quote = (value) => `"${value.replaceAll('"', '""')}"`;

test('missing cells identify their exact column without treating an empty cell as absent', () => {
  const error = columnError('sample,score,label\na,,normal\nb,0.3');
  const d = error.diagnostic;
  assert.deepEqual(d.columns, [
    { position: 1, header: 'sample', value: 'b' },
    { position: 2, header: 'score', value: '0.3' },
    { position: 3, header: 'label', value: null },
  ]);
  assert.deepEqual(
    [d.dataRow, d.startLine, d.endLine, d.headerLine],
    [2, 3, 3, 1],
  );
  assert.equal(d.expectedColumns, 3);
  assert.equal(d.actualColumns, 2);
  assert.equal(d.fileName, 'measurements.csv');
  assert.equal(d.delimiter, ',');
  assert.equal(d.rawRecord, 'b,0.3');
  assert.equal(d.rawRecordTruncated, false);
  assert.equal(d.omittedColumns, 0);
  assert.match(error.message, /データ行 2.*ファイル3行目/);
  assert.match(error.message, /ヘッダー（1行目）は3列、実際は2列（1列不足）/);
  assert.ok(d.hints.every((hint) => hint.includes('確認')));
});

test('extra values have no header and a trailing delimiter is an explicit empty cell', () => {
  const extra = columnError('sample,score\na,0.3,normal').diagnostic;
  assert.equal(extra.expectedColumns, 2);
  assert.equal(extra.actualColumns, 3);
  assert.deepEqual(extra.columns[2], {
    position: 3,
    header: null,
    value: 'normal',
  });
  const error = columnError('sample,score\na,0.3,');
  assert.deepEqual(error.diagnostic.columns[2], {
    position: 3,
    header: null,
    value: '',
  });
  assert.equal(error.diagnostic.rawRecord, 'a,0.3,');
  assert.match(error.message, /実際は3列（1列超過）/);
});

test('plain blank lines do not count as data but physical file line numbers include them', () => {
  const d = columnError('\n \nname,score,label\na,1,normal\n\n b,2').diagnostic;
  assert.deepEqual(
    [d.dataRow, d.headerLine, d.startLine, d.endLine],
    [2, 3, 6, 6],
  );
  assert.equal(d.columns[0].value, ' b');
  assert.equal(d.rawRecord, ' b,2');
});

test('BOM and leading whitespace lines do not hide the TSV delimiter', () => {
  const d = columnError(
    '\uFEFF\r\n \t\r\nname\tscore\tlabel\r\n"a,with,commas"\t1\tnormal\r\nb\t2',
    'measurements.tsv',
  ).diagnostic;
  assert.equal(d.delimiter, '\t');
  assert.equal(d.fileName, 'measurements.tsv');
  assert.deepEqual(
    [d.dataRow, d.headerLine, d.startLine, d.endLine],
    [2, 3, 5, 5],
  );
  assert.deepEqual(
    d.columns.map((column) => column.value),
    ['b', '2', null],
  );
  assert.equal(d.rawRecord, 'b\t2');
  assert.match(d.hints[0], /タブ/);
});

test('quoted multiline headers and rows preserve CRLF while counting one physical line per pair', () => {
  const badRow = '"b\r\nsecond\r\nthird",2';
  const csv =
    '\r\n"sample\r\nname",score,label\r\n"a\r\nfirst",1,normal\r\n\r\n' +
    badRow;
  const error = columnError(csv);
  const d = error.diagnostic;
  assert.deepEqual(
    [d.dataRow, d.headerLine, d.startLine, d.endLine],
    [2, 2, 7, 9],
  );
  assert.equal(d.columns[0].header, 'sample\r\nname');
  assert.equal(d.columns[0].value, 'b\r\nsecond\r\nthird');
  assert.equal(d.rawRecord, badRow);
  assert.match(error.message, /ファイル7〜9行目/);
});

test('LF, standalone CR, and CRLF all report multiline records identically', () => {
  for (const newline of ['\n', '\r', '\r\n']) {
    const badRow = `"b${newline}detail",2`;
    const csv = ['name,score,label', 'a,1,normal', '', badRow].join(newline);
    for (const ending of ['', newline]) {
      const d = columnError(csv + ending).diagnostic;
      assert.deepEqual(
        [d.dataRow, d.headerLine, d.startLine, d.endLine],
        [2, 1, 4, 5],
      );
      assert.equal(d.rawRecord, badRow);
      assert.equal(d.columns[0].value, `b${newline}detail`);
    }
  }
});

test('delimiter detection spans quoted header lines and ignores their quoted separators', () => {
  const csv =
    '"name,with,commas\ncontinued"\tscore\tlabel\nvalid\t1\tnormal\nbad\t2';
  const d = columnError(csv).diagnostic;
  assert.equal(d.delimiter, '\t');
  assert.equal(d.columns[0].header, 'name,with,commas\ncontinued');
  assert.deepEqual(
    [d.dataRow, d.headerLine, d.startLine, d.endLine],
    [2, 1, 4, 4],
  );
});

test('quoted commas and escaped quotes stay within one cell in the diagnostic', () => {
  const raw = '"a,""quoted"",name",0.5';
  const d = columnError(`sample,score,label\n${raw}`).diagnostic;
  assert.equal(d.actualColumns, 2);
  assert.equal(d.columns[0].value, 'a,"quoted",name');
  assert.equal(d.rawRecord, raw);
});

test('explicit empty records are validated instead of silently discarded', () => {
  for (const raw of ['""', ',']) {
    const d = columnError(`sample,score,label\na,1,normal\n${raw}`).diagnostic;
    assert.equal(d.dataRow, 2);
    assert.equal(d.actualColumns, raw === ',' ? 2 : 1);
    assert.equal(d.columns[0].value, '');
    assert.equal(d.columns[2].value, null);
    assert.equal(d.rawRecord, raw);
  }
  const tabs = columnError('sample\tscore\tlabel\na\t1\tnormal\n\t').diagnostic;
  assert.equal(tabs.actualColumns, 2);
  assert.deepEqual(
    tabs.columns.map((column) => column.value),
    ['', '', null],
  );
  const csv = parseCSV('sample,score,label\na,1,normal\n,,');
  const tsv = parseCSV('sample\tscore\tlabel\na\t1\tnormal\n\t\t');
  for (const data of [csv, tsv]) {
    assert.equal(data.rows.length, 2);
    assert.deepEqual(data.rows[1], { sample: '', score: '', label: '' });
  }
});

test('the first column mismatch is reported before later malformed records are examined', () => {
  const d = columnError('sample,score,label\na,1\n"unclosed').diagnostic;
  assert.equal(d.dataRow, 1);
  assert.equal(d.startLine, 2);
  assert.equal(d.rawRecord, 'a,1');
  for (const csv of [
    'sample,score,label\n"unclosed,1',
    'sample,score,label\na"bad,1,normal',
    'sample,score,label\n"a"bad,1,normal',
    'sample,,label\na,1',
    'sample,sample\na,1',
  ]) {
    assert.throws(
      () => parseCSV(csv),
      (error) =>
        error instanceof Error && !(error instanceof CSVColumnCountError),
    );
  }
});

test('wide extra-column previews include the first, expected boundary, and final columns', () => {
  const headers = Array.from(
    { length: 128 },
    (_, index) => `column_${index + 1}`,
  );
  const cells = Array.from({ length: 300 }, (_, index) => `${index + 1}`);
  const d = columnError(`${headers.join(',')}\n${cells.join(',')}`).diagnostic;
  assert.equal(d.expectedColumns, 128);
  assert.equal(d.actualColumns, 300);
  assert.equal(d.columns.length, CSV_DIAGNOSTIC_LIMITS.columns);
  assert.equal(d.omittedColumns, 300 - d.columns.length);
  for (const position of [1, 2, 127, 128, 129, 130, 299, 300]) {
    const cell = d.columns.find((column) => column.position === position);
    assert.ok(cell, `position ${position} is missing`);
    assert.equal(cell.value, `${position}`);
    assert.equal(cell.header, position <= 128 ? `column_${position}` : null);
  }
});

test('wide missing-column previews include both existing values and absent trailing positions', () => {
  const headers = Array.from(
    { length: 128 },
    (_, index) => `column_${index + 1}`,
  );
  const cells = Array.from({ length: 80 }, (_, index) => `${index + 1}`);
  const d = columnError(`${headers.join(',')}\n${cells.join(',')}`).diagnostic;
  assert.equal(d.columns.length, CSV_DIAGNOSTIC_LIMITS.columns);
  assert.equal(d.omittedColumns, 128 - d.columns.length);
  for (const position of [1, 79, 80, 81, 82, 127, 128]) {
    const cell = d.columns.find((column) => column.position === position);
    assert.ok(cell, `position ${position} is missing`);
    assert.equal(cell.header, `column_${position}`);
    assert.equal(cell.value, position <= 80 ? `${position}` : null);
  }
});

test('long names, values and records are bounded without splitting emoji or losing trailing-delimiter evidence', () => {
  const longHeader = '😀'.repeat(200);
  const longValue = '😀'.repeat(2000);
  const fileName = '😀'.repeat(200) + '.csv';
  const raw = `${quote(longValue)},1,`;
  const d = columnError(
    `${quote(longHeader)},score\n${raw}`,
    fileName,
  ).diagnostic;
  for (const [text, limit] of [
    [d.columns[0].header, CSV_DIAGNOSTIC_LIMITS.headerCharacters],
    [d.columns[0].value, CSV_DIAGNOSTIC_LIMITS.valueCharacters],
    [d.fileName, CSV_DIAGNOSTIC_LIMITS.fileNameCharacters],
    [d.rawRecord, CSV_DIAGNOSTIC_LIMITS.recordCharacters],
  ]) {
    assert.ok(text.length <= limit);
    assert.ok(text.includes('…'));
    assert.ok(
      text.isWellFormed(),
      'truncation must not split a surrogate pair',
    );
  }
  assert.equal(d.rawRecordTruncated, true);
  assert.ok(d.rawRecord.startsWith('"😀'));
  assert.ok(d.rawRecord.endsWith('",1,'));
  assert.equal(d.columns[2].value, '');
});

test('untrusted HTML, formulas and prototype-shaped names remain literal data', () => {
  const header = '<img src=x onerror="throw 1">';
  const formula = '=HYPERLINK("https://example.invalid","go")';
  const payload = '<script>throw 2</script>\u202E';
  const raw = [formula, '1', payload].map(quote).join(',');
  const d = columnError(
    `${quote(header)},score\n${raw}`,
    '<b>measurements.csv</b>',
  ).diagnostic;
  assert.equal(d.columns[0].header, header);
  assert.equal(d.columns[0].value, formula);
  assert.equal(d.columns[2].value, payload);
  assert.equal(d.rawRecord, raw);
  assert.equal(d.fileName, '<b>measurements.csv</b>');
  const data = parseCSV('__proto__,constructor,score\nplain,literal,1');
  assert.equal(Object.getPrototypeOf(data.rows[0]), Object.prototype);
  assert.equal(Object.hasOwn(data.rows[0], '__proto__'), true);
  assert.equal(data.rows[0].__proto__, 'plain');
  assert.equal(data.rows[0].constructor, 'literal');
});

test('valid quoted multiline cells retain their source content and all explicit empty positions', () => {
  const data = parseCSV(
    '\nname,score,label\r\n"a\r\nb",0,\r\n"quote ""value""",1,normal\r\n',
  );
  assert.deepEqual(data.columns, ['name', 'score', 'label']);
  assert.deepEqual(data.rows, [
    { name: 'a\r\nb', score: '0', label: '' },
    { name: 'quote "value"', score: '1', label: 'normal' },
  ]);
});
