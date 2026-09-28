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
