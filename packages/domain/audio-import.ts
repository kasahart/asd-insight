import type { DataRow, Dataset } from './demo.ts';
import { resolveAudio, unusedColumn, type AudioResolution } from './data.ts';

export type AudioAudit = ReturnType<typeof auditAudioMatches>;
export const MAX_FOLDER_LEVELS = 64;
export const AUDIO_PREVIEW_ITEM_LIMIT = 100;
export const AUDIO_REASON_CANDIDATE_LIMIT = 5;

/** Keep saved mappings bound to actual source columns after folder attributes appear. */
export function sourceColumnSelection(
  sourceColumns: readonly string[],
  choice: string,
) {
  return sourceColumns.includes(choice) ? choice : '';
}

/** Keep large audit sections readable without mounting every matched row. */
export function previewItems<T>(
  items: readonly T[],
  limit = AUDIO_PREVIEW_ITEM_LIMIT,
) {
  return items.slice(0, limit);
}

export function summarizeAudioCandidates(
  candidates: readonly string[],
  limit = AUDIO_REASON_CANDIDATE_LIMIT,
): string {
  const visible = previewItems(candidates, limit);
  const omitted = candidates.length - visible.length;
  return `${visible.join('、')}${omitted ? `、ほか${omitted}件` : ''}`;
}

/** A read-only preview of the complete prospective attachment set. */
export function auditAudioMatches<T>(
  data: Dataset,
  idColumn: string,
  audioColumn: string,
  files: Map<string, T>,
) {
  const missing: { row: number; expected: string }[] = [];
  const ambiguous: { row: number; candidates: readonly string[] }[] = [];
  const references = new Map<string, number[]>();
  for (const [index, row] of data.rows.entries()) {
    const result = resolveAudio(row, index, idColumn, audioColumn, files);
    if (result.key) {
      const rows = references.get(result.key);
      if (rows) rows.push(index + 1);
      else references.set(result.key, [index + 1]);
    } else if (result.reason === 'ambiguous')
      ambiguous.push({ row: index + 1, candidates: result.candidates ?? [] });
    else
      missing.push({
        row: index + 1,
        expected: result.expectedNames.join(' / '),
      });
  }
  return {
    matched: data.rows.length - missing.length - ambiguous.length,
    missing,
    ambiguous,
    unused: [...files.keys()].filter((key) => !references.has(key)),
    repeated: [...references]
      .filter(([, rows]) => rows.length > 1)
      .map(([key, rows]) => ({ key, rows })),
  };
}

export function folderAttributeCandidates<T>(files: Map<string, T>) {
  const levels = new Map<number, Map<string, number>>();
  for (const key of files.keys()) {
    const directories = key.split('/').slice(0, -1);
    directories.forEach((value, index) => {
      const values = levels.get(index + 1) ?? new Map<string, number>();
      values.set(value, (values.get(value) ?? 0) + 1);
      levels.set(index + 1, values);
    });
  }
  return [...levels].map(([level, values]) => ({ level, values: [...values] }));
}

export function folderAttributeColumn(
  data: { columns: readonly string[] },
  level: number,
) {
  return unusedColumn(`WAVフォルダ階層${level}`, [...data.columns]);
}

/** Stable compact identity for the row-to-folder memberships in a report. */
export function folderMembershipSignature(
  rows: readonly DataRow[],
  columns: readonly string[],
): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  const feedByte = (byte: number) => {
    first = Math.imul(first ^ byte, 0x01000193) >>> 0;
    second = Math.imul(second ^ byte, 0x85ebca6b) >>> 0;
  };
  const feedNumber = (value: number) => {
    for (let shift = 0; shift < 32; shift += 8)
      feedByte((value >>> shift) & 0xff);
  };
  const feedString = (value: string) => {
    feedNumber(value.length);
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      feedByte(code & 0xff);
      feedByte(code >>> 8);
    }
  };

  feedString('folder-membership-v1');
  feedNumber(columns.length);
  for (const column of columns) feedString(column);
  feedNumber(rows.length);
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    feedNumber(rowIndex);
    const row = rows[rowIndex];
    for (const column of columns) feedString(row[column] ?? '');
  }
  return `fm1-${first.toString(16).padStart(8, '0')}${second
    .toString(16)
    .padStart(8, '0')}`;
}

/** Labels used by the inspection list; these are never dataset attributes. */
export function audioListDisplay<T>(
  row: DataRow,
  index: number,
  idColumn: string,
  audioColumn: string,
  files: Map<string, T>,
) {
  const match = resolveAudio(row, index, idColumn, audioColumn, files);
  const identifier = idColumn ? String(row[idColumn] ?? '') : '';

  // The list describes the source CSV value. WAV matching is a separate
  // concern: a missing or ambiguous attachment must not replace the value the
  // user supplied in the dataset.
  if (audioColumn) {
    const sourceValue = String(row[audioColumn] ?? '');
    const normalized = sourceValue.replaceAll('\\', '/');
    const filename =
      normalized.trim() && normalized.split('/').at(-1)
        ? normalized.split('/').at(-1)!
        : `行${index + 1}`;
    return {
      filename,
      path: sourceValue,
      status: audioMatchStatus(match, audioColumn, sourceValue),
      identifier,
    };
  }
  return {
    filename: `行${index + 1}`,
    path: '',
    status: audioMatchStatus(match, audioColumn, ''),
    identifier,
  };
}

function audioMatchStatus<T>(
  match: AudioResolution<T>,
  audioColumn: string,
  sourceValue: string,
): string {
  switch (match.reason) {
    case 'matched':
      return '';
    case 'ambiguous': {
      const candidates = match.candidates ?? [];
      return `曖昧: 同名WAVが複数あります（候補: ${summarizeAudioCandidates(candidates)}）。CSVに相対パスを指定してください。`;
    }
    case 'no-files':
      return '未対応: WAVフォルダが未指定です。WAVフォルダを選択してください。';
    case 'audio-column-empty':
      return `未対応: 音声列「${audioColumn}」が空欄です。`;
    case 'source-id-empty':
      return '未対応: サンプル名の元IDが空欄で、対応するファイル名を決められません。';
    case 'name-mismatch': {
      const expected = match.expectedNames.filter(Boolean).join('、');
      return sourceValue
        ? `未対応: CSVの音声値「${sourceValue}」に対応するWAVがありません。WAVフォルダ内の相対パスを確認してください。`
        : `未対応: 対応するWAVがありません${expected ? `（期待: ${expected}）` : ''}。`;
    }
    default:
      return '未対応: 対応するWAVがありません。';
  }
}

/** Adds folder attributes automatically; source CSV rows remain untouched. */
export function withFolderAttributes<T>(
  data: Dataset,
  idColumn: string,
  audioColumn: string,
  files: Map<string, T>,
  levels: readonly number[],
): Dataset {
  if (!levels.length) return data;
  if (
    levels.length > MAX_FOLDER_LEVELS ||
    levels.some(
      (level) =>
        !Number.isInteger(level) || level < 1 || level > MAX_FOLDER_LEVELS,
    )
  )
    throw new Error(
      `WAVフォルダ階層は${MAX_FOLDER_LEVELS}階層まで分析条件に追加できます。フォルダ構造を浅くしてください。`,
    );
  const columns = levels.map((level) => folderAttributeColumn(data, level));
  return {
    ...data,
    columns: [...data.columns, ...columns],
    rows: data.rows.map((row, index) => {
      const key = resolveAudio(row, index, idColumn, audioColumn, files).key;
      const directories = key?.split('/').slice(0, -1) ?? [];
      const augmentedRow = { ...row };
      for (let levelIndex = 0; levelIndex < levels.length; levelIndex++)
        augmentedRow[columns[levelIndex]] =
          directories[levels[levelIndex] - 1] ?? '';
      return augmentedRow;
    }),
  };
}
