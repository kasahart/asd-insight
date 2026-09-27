import type { Dataset } from './demo.ts';
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

/** Adds only explicitly adopted attributes; source CSV rows remain untouched. */
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
