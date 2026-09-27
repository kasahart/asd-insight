import type { DataRow, Dataset } from './demo.ts';
import { resolveAudio, unusedColumn } from './data.ts';

export type AudioAudit = ReturnType<typeof auditAudioMatches>;

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
    if (result.key)
      references.set(result.key, [
        ...(references.get(result.key) ?? []),
        index + 1,
      ]);
    else if (result.reason === 'ambiguous')
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

/** Labels used by the inspection list; these are never dataset attributes. */
export function audioListDisplay<T>(
  row: DataRow,
  index: number,
  idColumn: string,
  audioColumn: string,
  files: Map<string, T>,
) {
  const match = resolveAudio(row, index, idColumn, audioColumn, files);
  if (match.key) {
    const parts = match.key.split('/');
    return { filename: parts.at(-1) ?? match.key, path: match.key, status: '' };
  }
  const status =
    match.reason === 'ambiguous'
      ? '曖昧: 同名WAVが複数あります'
      : match.reason === 'audio-column-empty'
        ? '未対応: 音声列が空欄です'
        : match.reason === 'no-files'
          ? '未対応: WAVフォルダが未指定です'
          : '未対応: 対応するWAVがありません';
  return { filename: `行${index + 1}（${status}）`, path: status, status };
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
  const columns = levels.map((level) => folderAttributeColumn(data, level));
  return {
    ...data,
    columns: [...data.columns, ...columns],
    rows: data.rows.map((row, index) => {
      const key = resolveAudio(row, index, idColumn, audioColumn, files).key;
      const directories = key?.split('/').slice(0, -1) ?? [];
      return Object.fromEntries([
        ...Object.entries(row),
        ...levels.map((level, i) => [columns[i], directories[level - 1] ?? '']),
      ]);
    }),
  };
}
