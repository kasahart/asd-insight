import { resolveAudio } from './data.ts';
import type { Dataset } from './demo.ts';

export const AUDIO_JOIN_POLICY = 'first-source-row-v1';

/** Audio inventory is primary; source CSV positions never change on table sorting. */
export function audioPopulation<T>(
  dataset: Dataset,
  idColumn: string,
  audioColumn: string,
  files: Map<string, T>,
) {
  const adopted = new Map<string, number>();
  const rowKeys = new Map<number, string>();
  const excludedIndices: number[] = [];
  const missing: { index: number; expected: readonly string[] }[] = [];
  const ambiguous: { index: number; candidates: readonly string[] }[] = [];
  const duplicates: { index: number; adoptedIndex: number; key: string }[] = [];
  if (dataset.demo)
    return {
      policy: AUDIO_JOIN_POLICY,
      adopted,
      rowKeys,
      excludedIndices,
      missing,
      ambiguous,
      duplicates,
      signature: 'demo',
      inventory: [] as { key: string; file: T; rowIndex: number | undefined }[],
    };
  dataset.rows.forEach((row, index) => {
    const resolution = resolveAudio(row, index, idColumn, audioColumn, files);
    if (!resolution.key) {
      excludedIndices.push(index);
      if (resolution.reason === 'ambiguous')
        ambiguous.push({ index, candidates: resolution.candidates ?? [] });
      else missing.push({ index, expected: resolution.expectedNames });
      return;
    }
    rowKeys.set(index, resolution.key);
    const first = adopted.get(resolution.key);
    if (first !== undefined) {
      duplicates.push({ index, adoptedIndex: first, key: resolution.key });
      excludedIndices.push(index);
    } else adopted.set(resolution.key, index);
  });
  // Compact scope identity (same dual rolling-hash convention as derived populations).
  let first = 0x811c9dc5,
    second = 0x9e3779b9;
  for (const [key, index] of adopted) {
    for (const char of JSON.stringify([key, index])) {
      const token = char.charCodeAt(0);
      first = Math.imul(first ^ token, 0x01000193);
      second = Math.imul(second ^ token, 0x85ebca6b);
    }
  }
  const signature = `${adopted.size}:${first >>> 0}:${second >>> 0}`;
  const inventory = [...files].map(([key, file]) => ({
    key,
    file,
    rowIndex: adopted.get(key),
  }));
  return {
    policy: AUDIO_JOIN_POLICY,
    adopted,
    rowKeys,
    excludedIndices,
    missing,
    ambiguous,
    duplicates,
    signature,
    inventory,
  };
}

/** Older row-based exclusions still exclude the same audio even on a rejected CSV row. */
export function audioIgnoredIndices(
  population: ReturnType<typeof audioPopulation>,
  manual: ReadonlySet<number>,
) {
  const result = new Set(manual);
  for (const index of manual) {
    const key = population.rowKeys.get(index);
    const first = key === undefined ? undefined : population.adopted.get(key);
    if (first !== undefined) result.add(first);
  }
  return result;
}
