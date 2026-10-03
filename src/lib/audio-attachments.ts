/** Add a batch atomically without replacing files or existing row assignments. */
import { audioFileKey } from '../../packages/domain/data.ts';

export function addAudioAttachments<
  T extends { readonly name: string; readonly webkitRelativePath?: string },
  Row = unknown,
>(
  existing: ReadonlyMap<string, T>,
  incoming: Iterable<T>,
  assignments?: {
    rows: readonly Row[];
    resolve: (row: Row, index: number, files: Map<string, T>) => T | undefined;
  },
): Map<string, T> {
  const result = new Map(existing);
  for (const file of incoming) {
    const key = audioFileKey(file);
    if (result.has(key)) {
      throw new Error(
        `音声「${key}」の相対パスが重複しています。追加済みの音声は置き換えません。今回の追加を中止しました。`,
      );
    }
    result.set(key, file);
  }
  if (assignments) {
    // A newly added extension can outrank an older recording in a resolver.
    // Check all rows against copies; neither a conflict nor the resolver can
    // mutate the caller's collection before the entire batch is accepted.
    const before = new Map(existing);
    for (const [index, row] of assignments.rows.entries()) {
      const previous = assignments.resolve(row, index, before);
      if (previous && assignments.resolve(row, index, result) !== previous) {
        throw new Error(
          `${index + 1}行目の追加済み音声「${previous.name}」の対応が変わります。追加済みの音声は置き換えません。今回の追加を中止しました。音声列で対応を明示するか、新しいファイル名を変更してください。`,
        );
      }
    }
  }
  return result;
}

const COMPARE_CHUNK_BYTES = 1024 * 1024;

/** Compare only overlapping paths. No decoding or whole-recording buffer is needed. */
async function equalAudioBytes(before: File, after: File, signal: AbortSignal) {
  signal.throwIfAborted();
  if (before === after) return true;
  if (before.size !== after.size) return false;
  for (let offset = 0; offset < before.size; offset += COMPARE_CHUNK_BYTES) {
    signal.throwIfAborted();
    const [a, b] = await Promise.all([
      before.slice(offset, offset + COMPARE_CHUNK_BYTES).arrayBuffer(),
      after.slice(offset, offset + COMPARE_CHUNK_BYTES).arrayBuffer(),
    ]);
    signal.throwIfAborted();
    const left = new Uint8Array(a), right = new Uint8Array(b);
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  }
  return true;
}

export type AudioAttachmentPreview = {
  incoming: File[];
  files: Map<string, File>;
  retained: string[];
  conflicts: string[];
  changed: number[];
};

/** A full-folder reselection is an atomic supplement, never an overwrite. */
export async function prepareAudioAttachments<Row>(
  existing: ReadonlyMap<string, File>,
  incoming: Iterable<File>,
  signal: AbortSignal,
  assignments: {
    rows: readonly Row[];
    resolve: (row: Row, index: number, files: Map<string, File>) => File | undefined;
  },
): Promise<AudioAttachmentPreview> {
  const files = new Map(existing);
  const additions: File[] = [], retained: string[] = [], conflicts: string[] = [];
  const seen = new Set<string>();
  // FileList is live: the picker is reset immediately after this call.
  for (const file of Array.from(incoming)) {
    signal.throwIfAborted();
    if (!/\.wav$/i.test(file.name)) continue;
    const key = audioFileKey(file);
    if (seen.has(key)) { conflicts.push(`${key}：選択内で相対パスが重複`); continue; }
    seen.add(key);
    const previous = existing.get(key);
    if (previous) {
      if (await equalAudioBytes(previous, file, signal)) retained.push(key);
      else conflicts.push(`${key}：既存音源と内容が異なります`);
    } else { additions.push(file); files.set(key, file); }
  }
  signal.throwIfAborted();
  if (!seen.size) throw new Error('選択したフォルダにWAVがありません。');
  const before = new Map(existing);
  const changed = assignments.rows.flatMap((row, index) => {
    const previous = assignments.resolve(row, index, before);
    return previous && assignments.resolve(row, index, files) !== previous ? [index + 1] : [];
  });
  return { incoming: additions, files, retained, conflicts, changed };
}
