import { validateAudioAnalysis, type AudioAnalysis } from './contracts.ts';

export type RuntimeLock = {
  pyodideVersion: string;
  wandasVersion: string;
  nativePackages: string[];
  pureWheels: string[];
  assets: Array<{ path: string; sha256: string }>;
};
type Proxy = { destroy(): void; toJs(options?: object): unknown };
type PythonFunction = Proxy & ((value: Proxy) => Proxy);
type Adapter = Proxy & { analyze_wav: PythonFunction };
type Pyodide = {
  loadPackage(packages: string[]): Promise<void>;
  unpackArchive(
    bytes: Uint8Array,
    format: string,
    options: { extractDir: string },
  ): void;
  toPy(value: Uint8Array): Proxy;
  pyimport(name: string): Adapter;
  runPython(source: string): unknown;
  FS: {
    writeFile(path: string, value: Uint8Array): void;
    unlink(path: string): void;
  };
};
export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
}

/** Internal fixed adapter; no user code, package names, URLs, or paths enter Python. */
export async function initializeAudioKernel({
  lock,
  baseUrl,
  moduleUrl,
  adapterSource,
  readAsset,
}: {
  lock: RuntimeLock;
  baseUrl: string;
  moduleUrl: string;
  adapterSource: string;
  readAsset: (name: string) => Promise<Uint8Array>;
}) {
  const runtimeLockHash = await sha256(
    new TextEncoder().encode(JSON.stringify(lock)),
  );
  const adapterSha256 = await sha256(new TextEncoder().encode(adapterSource));
  const manifest = JSON.parse(
    new TextDecoder().decode(await readAsset('manifest.json')),
  );
  if (
    manifest.runtimeLockHash !== runtimeLockHash ||
    manifest.adapterSha256 !== adapterSha256 ||
    (await sha256(await readAsset('wandas_adapter.py'))) !== adapterSha256
  )
    throw new Error(
      '音声ランタイムとアプリの版が一致しません。配布ファイルを揃えてください。',
    );
  let next = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < lock.assets.length) {
        const entry = lock.assets[next++];
        if ((await sha256(await readAsset(entry.path))) !== entry.sha256)
          throw new Error(
            '音声ランタイムの検証に失敗しました。配布ファイルを確認してください。',
          );
      }
    }),
  );
  const engineModule = (await import(/* @vite-ignore */ moduleUrl)) as {
    version: string;
    loadPyodide(options: object): Promise<Pyodide>;
  };
  if (engineModule.version !== lock.pyodideVersion)
    throw new Error('音声ランタイムの版が一致しません。');
  const packageLock = JSON.parse(
    new TextDecoder().decode(await readAsset('pyodide-lock.json')),
  );
  const pyodide = await engineModule.loadPyodide({
    indexURL: baseUrl,
    packageBaseUrl: baseUrl,
    lockFileContents: packageLock,
    cdnUrl: baseUrl,
    stdout: () => {},
    stderr: () => {},
  });
  await pyodide.loadPackage(lock.nativePackages);
  const purelib = String(
    pyodide.runPython('import sysconfig; sysconfig.get_path("purelib")'),
  );
  for (const name of lock.pureWheels)
    pyodide.unpackArchive(await readAsset(name), 'zip', {
      extractDir: purelib,
    });
  pyodide.FS.writeFile(
    '/home/pyodide/wandas_adapter.py',
    new TextEncoder().encode(adapterSource),
  );
  const adapter = pyodide.pyimport('wandas_adapter');
  const analyze = adapter.analyze_wav;
  return {
    analyze(bytes: Uint8Array): AudioAnalysis {
      let input: Proxy | undefined, result: Proxy | undefined;
      try {
        input = pyodide.toPy(bytes);
        result = analyze(input);
        const output = result.toJs({
          dict_converter: Object.fromEntries,
          create_pyproxies: false,
        }) as {
          metadata: string;
          values: Uint8Array;
          wave: Uint8Array;
        };
        const metadata = JSON.parse(output.metadata);
        const values = new Float32Array(Uint8Array.from(output.values).buffer);
        const envelope = new Float32Array(Uint8Array.from(output.wave).buffer);
        if (envelope.length !== metadata.waveColumns * 2)
          throw new Error('波形配列が一致しません。');
        const wave = Array.from(
          { length: metadata.waveColumns },
          (_, index) => ({
            min: envelope[index * 2],
            max: envelope[index * 2 + 1],
          }),
        );
        return validateAudioAnalysis({
          sampleRate: metadata.sampleRate,
          channels: metadata.channels,
          duration: metadata.duration,
          wave,
          spectrogram: {
            values,
            columns: metadata.columns,
            frequencyBins: metadata.frequencyBins,
            sampleRate: metadata.sampleRate,
            duration: metadata.duration,
            fftSize: metadata.fftSize,
            hopSize: metadata.hopSize,
            frameCount: metadata.frameCount,
            minDb: metadata.minDb,
            maxDb: metadata.maxDb,
          },
          recipe: { ...metadata.recipe, adapterSha256 },
          runtimeLockHash,
          sourceHash: metadata.sourceHash,
        });
      } finally {
        result?.destroy();
        input?.destroy();
      }
    },
    dispose() {
      analyze.destroy();
      adapter.destroy();
      pyodide.FS.unlink('/home/pyodide/wandas_adapter.py');
    },
  };
}
