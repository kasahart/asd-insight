import type {
  AudioReference,
  LoadedSession,
} from '../../packages/contracts/storage.ts';

/** Logical identity stays stable when the stored dataset becomes a reference stub. */
export function logicalDatasetHash(
  record: Pick<LoadedSession['record'], 'datasetHash' | 'logicalDatasetHash'>,
): string {
  return record.logicalDatasetHash ?? record.datasetHash;
}

/** Folder membership survives a missing WAV without pretending its bytes are available. */
export function inputMembership(loaded: {
  record: Pick<LoadedSession['record'], 'audioReferences'>;
  audioFiles: Map<string, File>;
}): Map<string, unknown> {
  if (loaded.record.audioReferences === undefined) return loaded.audioFiles;
  return new Map<string, unknown>([
    ...(loaded.record.audioReferences ?? []).map(
      (ref) => [ref.key, ref] as const,
    ),
    ...loaded.audioFiles,
  ]);
}

export function audioReferences(
  files: Map<string, File>,
  previous: AudioReference[] = [],
): AudioReference[] {
  const refs = new Map(previous.map((ref) => [ref.key, ref]));
  for (const [key, file] of files) {
    const old = refs.get(key);
    if (
      old &&
      (old.size !== file.size || old.lastModified !== file.lastModified)
    )
      throw new Error(
        `音声「${key}」の容量または更新日時が保存時と異なります。元の音声を選び直すか、新しい分析として開始してください。`,
      );
    refs.set(key, {
      key,
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
    });
  }
  return [...refs.values()];
}

/** Discard-draft reload keeps only local files described by the saved revision. */
export function retainedReferenceAudio(
  files: Map<string, File>,
  references: AudioReference[],
): Map<string, File> {
  const saved = new Map(references.map((ref) => [ref.key, ref]));
  return new Map(
    [...files].filter(([key, file]) => {
      const ref = saved.get(key);
      return (
        ref &&
        ref.name === file.name &&
        ref.size === file.size &&
        ref.lastModified === file.lastModified
      );
    }),
  );
}
