import type { DataRow, Dataset } from './demo.ts';
import { finiteNumber, quantile } from './distribution.ts';
import {
  CSVColumnCountError,
  columnCountDiagnostic,
} from './csv-diagnostics.ts';
export type GroupSpec =
  | { kind: 'category'; column: string; a: string; b: string }
  | { kind: 'numeric'; column: string; upperA: number; lowerB: number };
export type Sample = {
  index: number;
  row: DataRow;
  score: number;
  group: 'A' | 'B';
};
export type FilterSpec = { column: string; value: string };
export type Profile = {
  column: string;
  numeric: boolean;
  values: string[];
  validNumbers: number;
  nonempty: number;
};

function csvDelimiter(text: string): ',' | '\t' {
  let quoted = false;
  let commas = 0;
  let tabs = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        i++;
        continue;
      }
      quoted = !quoted;
    }
    if (quoted) continue;
    if (c === '\n' || c === '\r') {
      // Header detection uses the first nonblank logical record. Leading
      // blank physical lines must not make a TSV look like a one-column CSV.
      if (text.slice(start, i).trim()) break;
      if (c === '\r' && text[i + 1] === '\n') i++;
      start = i + 1;
      commas = 0;
      tabs = 0;
    } else if (c === ',') commas++;
    else if (c === '\t') tabs++;
  }
  return tabs > commas ? '\t' : ',';
}

export function parseCSV(input: string, name = 'data.csv'): Dataset {
  const text = input.replace(/^\uFEFF/, '');
  if (!text.trim())
    throw new Error('CSVが空です。ヘッダーとデータ行を用意してください。');
  const delimiter = csvDelimiter(text);
  const columns: string[] = [];
  const rows: DataRow[] = [];
  let hasHeader = false;
  let headerLine = 1;
  let physicalLine = 1;
  let recordStartLine = 1;
  let recordStartIndex = 0;
  let record: string[] = [],
    field = '',
    quoted = false,
    closed = false;
  const addRow = (endIndex: number) => {
    // Plain empty/whitespace lines are not data records. An explicit quoted
    // empty cell or delimiter-separated row is a record, even if all cells are
    // empty, and must not disappear instead of producing a column diagnostic.
    const blank = hasHeader
      ? !record.length && !closed && !field.trim()
      : !text.slice(recordStartIndex, endIndex).trim();
    const cells = [...record, field];
    if (!blank) {
      if (!hasHeader) {
        const headers = cells.map((cell) => cell.trim());
        if (headers.length > 128)
          throw new Error('初版では128列まで読めます。');
        if (headers.some((header) => !header))
          throw new Error('空の列名があります。各列に名前を付けてください。');
        if (new Set(headers).size !== headers.length)
          throw new Error('同じ列名が複数あります。列名を一意にしてください。');
        columns.push(...headers);
        hasHeader = true;
        headerLine = recordStartLine;
      } else {
        const dataRow = rows.length + 1;
        if (cells.length !== columns.length)
          throw new CSVColumnCountError(
            columnCountDiagnostic({
              fileName: name,
              dataRow,
              startLine: recordStartLine,
              endLine: physicalLine,
              headerLine,
              delimiter,
              headers: columns,
              cells,
              rawRecord: text.slice(recordStartIndex, endIndex),
            }),
          );
        if (dataRow > 100000)
          throw new Error(
            '初版では100,000行まで読めます。ファイルを分割してください。',
          );
        rows.push(
          Object.fromEntries(
            columns.map((column, index) => [column, cells[index]]),
          ),
        );
      }
    }
    record = [];
    field = '';
    closed = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else if (c === '\r') {
        field += c;
        if (text[i + 1] === '\n') field += text[++i];
        physicalLine++;
      } else {
        field += c;
        if (c === '\n') physicalLine++;
      }
      continue;
    }
    if (c === delimiter) {
      record.push(field);
      field = '';
      closed = false;
      continue;
    }
    if (c === '\n' || c === '\r') {
      addRow(i);
      if (c === '\r' && text[i + 1] === '\n') i++;
      physicalLine++;
      recordStartLine = physicalLine;
      recordStartIndex = i + 1;
      continue;
    }
    if (closed) {
      if (c === ' ' || c === '\t') continue;
      throw new Error(
        '引用符の後に不正な文字があります。CSVの書式を確認してください。',
      );
    }
    if (c === '"') {
      if (field.length)
        throw new Error('セル途中の引用符は二重引用符で囲んでください。');
      quoted = true;
      continue;
    }
    field += c;
  }
  if (quoted)
    throw new Error(
      '閉じられていない引用符があります。CSVの書式を確認してください。',
    );
  if (field.length || record.length || closed) addRow(text.length);
  if (!rows.length) throw new Error('データ行がありません。');
  const result = { name, columns, rows, demo: false };
  if (!profileColumns(result).some((p) => p.numeric))
    throw new Error(
      '数値として読める列がありません。小数点は「.」で、桁区切りなしで入力してください。',
    );
  return result;
}

export function profileColumns(data: Dataset): Profile[] {
  return data.columns.map((column) => {
    const values = new Set<string>();
    let validNumbers = 0,
      nonempty = 0;
    for (const row of data.rows) {
      const v = row[column]?.trim() ?? '';
      if (!v) continue;
      nonempty++;
      if (values.size <= 200) values.add(v);
      if (finiteNumber(v) !== null) validNumbers++;
    }
    return {
      column,
      numeric: validNumbers > 0,
      values: [...values],
      validNumbers,
      nonempty,
    };
  });
}
export function defaultGroup(
  data: Dataset,
  profile: Profile,
  kind?: 'category' | 'numeric',
): GroupSpec {
  if (kind === 'category' || (!kind && !profile.numeric))
    return {
      kind: 'category',
      column: profile.column,
      a: profile.values[0] ?? '',
      b: profile.values[1] ?? '',
    };
  const values = data.rows
    .map((r) => finiteNumber(r[profile.column]))
    .filter((x): x is number => x !== null);
  let lo = quantile(values, 0.3) ?? 0,
    hi = quantile(values, 0.7) ?? 1;
  if (lo === hi) {
    lo = quantile(values, 0) ?? 0;
    hi = quantile(values, 1) ?? 1;
  }
  return { kind: 'numeric', column: profile.column, upperA: lo, lowerB: hi };
}
export function partitionRows(
  rows: DataRow[],
  score: string,
  spec: GroupSpec,
  filter?: FilterSpec | null,
  ignored?: ReadonlySet<number>,
) {
  if (!score || !spec.column)
    throw new Error('異常度の列と、比較群を定義する列を選んでください。');
  if (score === spec.column)
    throw new Error(
      '表示スコア自身では群分けできません。別の属性・評価列を選んでください。',
    );
  if (spec.kind === 'category' && (!spec.a || !spec.b || spec.a === spec.b))
    throw new Error('群Aと群Bに異なる値を選んでください。');
  if (
    spec.kind === 'numeric' &&
    (!Number.isFinite(spec.upperA) ||
      !Number.isFinite(spec.lowerB) ||
      spec.upperA >= spec.lowerB)
  )
    throw new Error('群Aの上限を、群Bの下限より小さくしてください。');
  const samples: Sample[] = [];
  const memberRows: DataRow[] = [];
  let outsideFilter = 0,
    missingGroup = 0,
    otherGroup = 0,
    missingA = 0,
    missingB = 0,
    membersA = 0,
    membersB = 0,
    ignoredRows = 0;
  rows.forEach((row, index) => {
    if (ignored?.has(index)) {
      ignoredRows++;
      return;
    }
    if (
      filter &&
      filter.column &&
      row[filter.column]?.trim() !== filter.value
    ) {
      outsideFilter++;
      return;
    }
    const v = row[spec.column]?.trim() ?? '';
    let group: 'A' | 'B' | null = null;
    if (spec.kind === 'category') {
      if (!v) {
        missingGroup++;
        return;
      }
      group = v === spec.a ? 'A' : v === spec.b ? 'B' : null;
    } else {
      const n = finiteNumber(v);
      if (n === null) {
        missingGroup++;
        return;
      }
      group = n <= spec.upperA ? 'A' : n >= spec.lowerB ? 'B' : null;
    }
    if (!group) {
      otherGroup++;
      return;
    }
    if (group === 'A') membersA++;
    else membersB++;
    // Keep the shared cohort before either score's missingness is considered.
    memberRows.push(row);
    const n = finiteNumber(row[score]);
    if (n === null) {
      if (group === 'A') missingA++;
      else missingB++;
      return;
    }
    samples.push({ index, row, score: n, group });
  });
  return {
    samples,
    memberRows,
    outsideFilter,
    missingGroup,
    otherGroup,
    missingA,
    missingB,
    membersA,
    membersB,
    ignoredRows,
  };
}
export function csvText(columns: string[], rows: DataRow[], safe = true) {
  const cell = (s: string) => {
    const value =
      safe && /^[\s]*[=+\-@]/.test(s) && finiteNumber(s) === null ? "'" + s : s;
    return /[",\r\n\t]/.test(value)
      ? '"' + value.replaceAll('"', '""') + '"'
      : value;
  };
  return (
    '\uFEFF' +
    [
      columns.map(cell).join(','),
      ...rows.map((r) => columns.map((c) => cell(r[c] ?? '')).join(',')),
    ].join('\r\n')
  );
}
export function unusedColumn(base: string, existing: string[]) {
  let name = base,
    index = 2;
  while (existing.includes(name)) name = base + '_' + index++;
  return name;
}
export type AudioResolutionReason =
  | 'matched'
  | 'no-files'
  | 'audio-column-empty'
  | 'source-id-empty'
  | 'name-mismatch';
export type AudioResolution<T> = {
  file: T | undefined;
  reason: AudioResolutionReason;
  expectedNames: readonly string[];
  source: 'audio-column' | 'sample-id';
  sourceColumn?: string;
};
export function resolveAudio<T>(
  row: DataRow,
  index: number,
  idColumn: string,
  audioColumn: string,
  files: Map<string, T>,
): AudioResolution<T> {
  const source = audioColumn ? 'audio-column' : 'sample-id';
  const sourceColumn = audioColumn || undefined;
  const rawName = audioColumn ? (row[audioColumn] ?? '') : '';
  const id = audioColumn
    ? ''
    : idColumn
      ? (row[idColumn] ?? '')
      : 'row-' + (index + 1);
  const expectedNames = audioColumn
    ? [rawName.split(/[\\/]/).pop() ?? '']
    : [
        id,
        ...['.wav', '.flac', '.mp3', '.ogg', '.m4a'].map(
          (extension) => id + extension,
        ),
      ];
  const base = {
    expectedNames,
    source,
    sourceColumn,
  } as const;
  if (!files.size) return { ...base, file: undefined, reason: 'no-files' };
  for (const name of expectedNames) {
    const file = files.get(name);
    if (file) return { ...base, file, reason: 'matched' };
  }
  if (audioColumn && !expectedNames[0])
    return { ...base, file: undefined, reason: 'audio-column-empty' };
  if (!audioColumn && !id)
    return { ...base, file: undefined, reason: 'source-id-empty' };
  return { ...base, file: undefined, reason: 'name-mismatch' };
}
export function findAudio<T>(
  row: DataRow,
  index: number,
  idColumn: string,
  audioColumn: string,
  files: Map<string, T>,
): T | undefined {
  return resolveAudio(row, index, idColumn, audioColumn, files).file;
}
