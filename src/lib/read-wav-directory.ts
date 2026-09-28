type EnumerableDirectory = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};

/** Read only WAV files, keeping the same selected-root path as webkitdirectory. */
export async function readWavDirectory(
  root: FileSystemDirectoryHandle,
  maxFiles: number,
): Promise<File[]> {
  const files: File[] = [];

  async function visit(directory: FileSystemDirectoryHandle, parts: string[]) {
    for await (const [name, handle] of (
      directory as EnumerableDirectory
    ).entries()) {
      if (handle.kind === 'directory') {
        await visit(handle as FileSystemDirectoryHandle, [...parts, name]);
      } else if (/\.wav$/i.test(name)) {
        if (files.length >= maxFiles)
          throw new Error(
            `WAVは${maxFiles.toLocaleString()}件まで追加できます。フォルダ内のWAVを減らしてください。`,
          );
        const file = await (handle as FileSystemFileHandle).getFile();
        // File.webkitRelativePath is normally filled by <input webkitdirectory>.
        // The directory picker returns File objects without that path.
        Object.defineProperty(file, 'webkitRelativePath', {
          value: [root.name, ...parts, name].join('/'),
          configurable: true,
        });
        files.push(file);
      }
    }
  }

  await visit(root, []);
  return files;
}
