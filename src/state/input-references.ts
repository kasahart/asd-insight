import type {
  AudioReference,
  LoadedSession,
} from '../../packages/contracts/storage.ts';

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
  const expectedNames = new Set(previous.map((ref) => ref.name));
  for (const [key, file] of files) {
    const old = refs.get(key);
    if (!old && expectedNames.has(file.name))
      throw new Error(
        `音声「${key}」の相対パスが保存時と異なります。元と同じ階層のフォルダを選び直してください。`,
      );
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
