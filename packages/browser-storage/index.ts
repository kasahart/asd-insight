import type {
  BrowserRepository,
  CreateSessionInput,
  LoadedSession,
  SessionRecord,
  StorageCapabilities,
  StorageMode,
  StoredAsset,
} from '../contracts/storage.ts';
import { assembleBundle, bundlePlan, readBundle } from './bundle.ts';
import {
  indexedMetadata,
  memoryMetadata,
  type DatasetEntry,
} from './metadata.ts';
import {
  LIMITS,
  StorageError,
  datasetValue,
  encodeJSON,
  exactKeys,
  fail,
  normalizeError,
  plain,
  sha256,
  stateValue,
  string,
} from './validation.ts';

export type * from '../contracts/storage.ts';
export { LIMITS, StorageError } from './validation.ts';

export type BrowserRepositoryOptions = {
  mode?: StorageMode;
  databaseName?: string;
  /** Deployment limits may lower, never silently raise, the tested defaults. */
  maxBundleBytes?: number;
  maxTotalBytes?: number;
  /** Injectable platform adapters for deterministic, non-browser tests. */
  indexedDB?: IDBFactory;
  opfsRoot?: FileSystemDirectoryHandle;
  storageManager?: Pick<
    StorageManager,
    'getDirectory' | 'persist' | 'persisted'
  >;
  lockManager?: Pick<LockManager, 'request'>;
};

type PreparedFile = { file: File; hash: string };
const PATH = /^[a-f0-9-]{36}-[a-f0-9]{64}$/;

function limit(value: number | undefined, maximum: number) {
  const result = value ?? maximum;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum)
    fail('保存容量の設定が不正です。');
  return result;
}

function recordValue(value: unknown): SessionRecord {
  try {
    if (!plain(value)) fail('調査recordが不正です。');
    exactKeys(
      value,
      [
        'id',
        'datasetVersionId',
        'title',
        'revision',
        'createdAt',
        'updatedAt',
        'state',
        'audio',
        'source',
        'datasetHash',
        'bundleBytes',
      ],
      [
        'id',
        'datasetVersionId',
        'title',
        'revision',
        'createdAt',
        'updatedAt',
        'state',
        'audio',
        'datasetHash',
        'bundleBytes',
      ],
    );
    for (const field of [
      'id',
      'datasetVersionId',
      'title',
      'createdAt',
      'updatedAt',
    ])
      string(value[field], field);
    if (
      !Number.isSafeInteger(value.revision) ||
      (value.revision as number) < 1 ||
      !Number.isSafeInteger(value.bundleBytes) ||
      (value.bundleBytes as number) < 1
    )
      fail('調査revisionまたは容量が不正です。');
    if (
      typeof value.datasetHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.datasetHash) ||
      !plain(value.audio)
    )
      fail('調査hashまたは音声対応が不正です。');
    const asset = (item: unknown): StoredAsset => {
      if (!plain(item)) fail('資産形式が不正です。');
      exactKeys(item, [
        'storageName',
        'hash',
        'size',
        'name',
        'type',
        'lastModified',
      ]);
      if (
        typeof item.storageName !== 'string' ||
        !PATH.test(item.storageName) ||
        typeof item.hash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(item.hash) ||
        !item.storageName.endsWith(item.hash)
      )
        fail('資産参照が不正です。');
      if (
        !Number.isSafeInteger(item.size) ||
        (item.size as number) < 0 ||
        (item.size as number) > LIMITS.assetBytes ||
        !Number.isSafeInteger(item.lastModified) ||
        (item.lastModified as number) < 0
      )
        fail('資産容量または日時が不正です。');
      string(item.name, 'ファイル名');
      string(item.type, 'MIME type', 256);
      return { ...item } as StoredAsset;
    };
    if (Object.keys(value.audio).length > LIMITS.assetCount)
      fail('音声件数が上限を超えています。');
    const audio = Object.fromEntries(
      Object.entries(value.audio).map(([key, item]) => [
        string(key, '音声対応キー', 4096),
        asset(item),
      ]),
    );
    return {
      ...value,
      state: stateValue(value.state),
      audio,
      ...(value.source === undefined ? {} : { source: asset(value.source) }),
    } as SessionRecord;
  } catch (error) {
    throw new StorageError(
      'CORRUPT',
      '保存済み調査の形式が破損しています。バックアップから復元してください。',
      { cause: error },
    );
  }
}

function fileMetadata(
  file: File,
  hash: string,
  storageName: string,
): StoredAsset {
  return {
    storageName,
    hash,
    size: file.size,
    name: file.name,
    type: file.type,
    lastModified: file.lastModified,
  };
}

function checkFile(file: File, maximum: number) {
  if (
    !(file instanceof File) ||
    file.size > maximum ||
    !Number.isSafeInteger(file.size)
  )
    fail('ファイル容量が上限を超えているか、File形式ではありません。');
  string(file.name, 'ファイル名');
  string(file.type, 'MIME type', 256);
  if (!Number.isSafeInteger(file.lastModified) || file.lastModified < 0)
    fail('ファイル日時が不正です。');
}

function audioInput(files: Map<string, File> | undefined): Map<string, File> {
  if (files === undefined) return new Map();
  if (!(files instanceof Map) || files.size > LIMITS.assetCount)
    fail('音声対応は上限内のMapにしてください。');
  for (const [key, file] of files) {
    if (!string(key, '音声対応キー', 4096)) fail('音声対応キーが空です。');
    checkFile(file, LIMITS.assetBytes);
  }
  return new Map(files);
}

export async function createBrowserRepository(
  options: BrowserRepositoryOptions = {},
): Promise<BrowserRepository> {
  const mode = options.mode ?? 'persistent';
  if (mode !== 'persistent' && mode !== 'memory')
    fail('保存モードが不正です。');
  const maximum = limit(options.maxBundleBytes, LIMITS.bundleBytes);
  const totalMaximum = limit(options.maxTotalBytes, LIMITS.totalBytes);
  const name = string(
    options.databaseName ?? 'overlap-lab-v1',
    '保存領域名',
    128,
  );
  if (!name) fail('保存領域名が空です。');
  const platform = globalThis.navigator;
  const factory = options.indexedDB ?? globalThis.indexedDB;
  const storage = options.storageManager ?? platform?.storage;
  const locks = options.lockManager ?? platform?.locks;
  let closed = false;
  let directory: FileSystemDirectoryHandle | undefined;
  let granted = false;
  if (!globalThis.crypto?.randomUUID || !globalThis.crypto?.subtle)
    throw new StorageError(
      'UNAVAILABLE',
      '内容ハッシュを利用できません。HTTPS対応環境で開いてください。',
    );
  if (mode === 'persistent') {
    if (!factory || !locks || (!options.opfsRoot && !storage?.getDirectory))
      throw new StorageError(
        'UNAVAILABLE',
        'IndexedDB・OPFS・Web Locksを利用できません。一時モードは明示的に選択してください。',
      );
    try {
      const root = options.opfsRoot ?? (await storage!.getDirectory());
      const container = await root.getDirectoryHandle('overlap-lab-v1', {
        create: true,
      });
      directory = await container.getDirectoryHandle(
        await sha256(encodeJSON(name)),
        { create: true },
      );
      granted = storage?.persisted ? await storage.persisted() : false;
    } catch (error) {
      throw new StorageError(
        'UNAVAILABLE',
        'ブラウザー保存を開始できません。一時モードは明示的に選択してください。',
        { cause: error },
      );
    }
  }
  const metadata =
    mode === 'persistent'
      ? await indexedMetadata(factory!, name, () => {
          closed = true;
        }).catch((error: unknown) => {
          throw normalizeError(error);
        })
      : memoryMetadata();
  const memoryFiles = new Map<string, Blob>();
  const capabilities: StorageCapabilities = Object.freeze({
    mode,
    persistentStorageGranted: granted,
    indexedDB: !!factory,
    opfs: !!directory,
    crossTabLock: !!locks,
    maxBundleBytes: maximum,
    maxTotalBytes: totalMaximum,
  });
  let currentCapabilities = capabilities;
  let tail: Promise<unknown> = Promise.resolve();
  const assertOpen = () => {
    if (closed)
      throw new StorageError(
        'CLOSED',
        '保存領域は閉じられています。もう一度開いてください。',
      );
  };
  const exclusive = async <T>(body: () => Promise<T>): Promise<T> => {
    const run = async () => {
      assertOpen();
      try {
        return await body();
      } catch (error) {
        throw normalizeError(error);
      }
    };
    if (mode === 'persistent')
      return await locks!.request(
        `overlap-lab:storage:${name}`,
        { mode: 'exclusive' },
        run,
      );
    const result = tail.then(run, run);
    tail = result.catch(() => undefined);
    return result;
  };

  async function readAsset(asset: StoredAsset): Promise<File> {
    let blob: Blob;
    try {
      blob = directory
        ? await (await directory.getFileHandle(asset.storageName)).getFile()
        : memoryFiles.get(asset.storageName)!;
      if (
        !blob ||
        blob.size !== asset.size ||
        (await sha256(await blob.arrayBuffer())) !== asset.hash
      )
        throw new Error('Asset hash/size mismatch');
    } catch (error) {
      throw new StorageError(
        'CORRUPT',
        '元データまたは音声が欠損・破損しています。バックアップから復元してください。',
        { cause: error },
      );
    }
    return new File([blob], asset.name, {
      type: asset.type,
      lastModified: asset.lastModified,
    });
  }

  async function writeAsset(prepared: PreparedFile): Promise<StoredAsset> {
    assertOpen();
    // A unique staging object is never overwritten or exposed by a session
    // before its close + verification and the following IDB commit succeed.
    const storageName = `${crypto.randomUUID()}-${prepared.hash}`;
    const reference = fileMetadata(prepared.file, prepared.hash, storageName);
    if (directory) {
      const writable = await (
        await directory.getFileHandle(storageName, { create: true })
      ).createWritable();
      try {
        await writable.write(prepared.file);
        await writable.close();
      } catch (error) {
        try {
          await writable.abort();
        } catch {
          /* close may already have aborted */
        }
        throw error;
      }
    } else memoryFiles.set(storageName, prepared.file);
    await readAsset(reference);
    assertOpen();
    return reference;
  }

  async function prepare(files: File[]): Promise<Map<File, PreparedFile>> {
    // Conservative admission happens before decoding/hashing any file. Aliased
    // File objects count once, matching the bundle's content deduplication.
    const unique = [...new Set(files)];
    if (unique.reduce((sum, file) => sum + file.size, 0) > maximum)
      throw new StorageError(
        'QUOTA',
        '元データと音声の合計がバックアップ容量の上限を超えます。',
      );
    const result = new Map<File, PreparedFile>();
    for (const file of unique) {
      assertOpen();
      result.set(file, { file, hash: await sha256(await file.arrayBuffer()) });
    }
    return result;
  }

  async function checked(
    id: string,
  ): Promise<{ record: SessionRecord; dataset: DatasetEntry }> {
    string(id, '調査ID');
    const loaded = await metadata.get(id);
    const record = recordValue(loaded.record);
    try {
      const value = datasetValue(loaded.dataset.value);
      if (
        loaded.dataset.id !== record.datasetVersionId ||
        loaded.dataset.hash !== record.datasetHash ||
        (await sha256(encodeJSON(value))) !== record.datasetHash
      )
        throw new Error('Dataset hash mismatch');
      if (bundlePlan(record, value).size !== record.bundleBytes)
        throw new Error('Bundle size mismatch');
      return { record, dataset: { ...loaded.dataset, value } };
    } catch (error) {
      throw new StorageError(
        'CORRUPT',
        '保存済みデータの内容を検証できません。バックアップから復元してください。',
        { cause: error },
      );
    }
  }

  async function loadedSession(id: string): Promise<LoadedSession> {
    const { record, dataset } = await checked(id);
    const audioFiles = new Map<string, File>();
    for (const [key, asset] of Object.entries(record.audio))
      audioFiles.set(key, await readAsset(asset));
    const source = record.source ? await readAsset(record.source) : undefined;
    return {
      record,
      dataset: dataset.value,
      ...(source ? { source } : {}),
      audioFiles,
    };
  }

  function checkBudget(record: SessionRecord, dataset: DatasetEntry) {
    record.bundleBytes = bundlePlan(record, dataset.value).size;
    if (record.bundleBytes > maximum)
      throw new StorageError(
        'QUOTA',
        '調査全体が完全バックアップ可能な容量を超えています。',
      );
  }

  async function checkTotalBudget(candidate: SessionRecord) {
    const records = (await metadata.list()).map(recordValue);
    const total = records.reduce(
      (sum, record) =>
        sum + (record.id === candidate.id ? 0 : record.bundleBytes),
      candidate.bundleBytes,
    );
    if (!Number.isSafeInteger(total) || total > totalMaximum)
      throw new StorageError(
        'QUOTA',
        '保存済み調査の合計容量が上限を超えます。既存の調査をバックアップして整理してください。',
      );
  }

  async function create(input: CreateSessionInput): Promise<SessionRecord> {
    const title = string(input.title, '調査名');
    if (!title.trim()) fail('調査名を入力してください。');
    const datasetValueCopy = datasetValue(input.dataset);
    const state = stateValue(input.state);
    const audio = audioInput(input.audioFiles);
    if (input.source) checkFile(input.source, LIMITS.sourceBytes);
    const prepared = await prepare([
      ...(input.source ? [input.source] : []),
      ...audio.values(),
    ]);
    const timestamp = new Date().toISOString();
    const dataset: DatasetEntry = {
      id: crypto.randomUUID(),
      hash: await sha256(encodeJSON(datasetValueCopy)),
      value: datasetValueCopy,
    };
    const record: SessionRecord = {
      id: crypto.randomUUID(),
      datasetVersionId: dataset.id,
      title,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      state,
      audio: {},
      datasetHash: dataset.hash,
      bundleBytes: 0,
    };
    // Check the final manifest budget with temporary, never persisted references.
    const temporary = (file: File) =>
      fileMetadata(
        file,
        prepared.get(file)!.hash,
        `${crypto.randomUUID()}-${prepared.get(file)!.hash}`,
      );
    if (input.source) record.source = temporary(input.source);
    record.audio = Object.fromEntries(
      [...audio].map(([key, file]) => [key, temporary(file)]),
    );
    checkBudget(record, dataset);
    await checkTotalBudget(record);
    const assets = new Map<string, StoredAsset>();
    const persist = async (file: File) => {
      const item = prepared.get(file)!;
      let stored = assets.get(item.hash);
      if (!stored) {
        stored = await writeAsset(item);
        assets.set(item.hash, stored);
      }
      return fileMetadata(file, item.hash, stored.storageName);
    };
    if (input.source) record.source = await persist(input.source);
    const bindings: [string, StoredAsset][] = [];
    for (const [key, file] of audio) bindings.push([key, await persist(file)]);
    record.audio = Object.fromEntries(bindings);
    assertOpen();
    await metadata.create(record, dataset, totalMaximum);
    return structuredClone(record);
  }

  const repository: BrowserRepository = {
    mode,
    get capabilities() {
      return currentCapabilities;
    },
    listSessions: () =>
      exclusive(async () =>
        (await metadata.list())
          .map(recordValue)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      ),
    createSession: (input) => exclusive(() => create(input)),
    loadSession: (id) => exclusive(() => loadedSession(id)),
    saveSession: (id, input) =>
      exclusive(async () => {
        if (
          !Number.isSafeInteger(input.expectedRevision) ||
          input.expectedRevision < 1
        )
          fail('保存元revisionが不正です。');
        const operationId = string(input.operationId, '操作ID', 256);
        if (!operationId) fail('操作IDを指定してください。');
        const state = stateValue(input.state);
        const audio =
          input.audioFiles === undefined
            ? undefined
            : audioInput(input.audioFiles);
        const prepared = await prepare(audio ? [...audio.values()] : []);
        const audioDigest = audio
          ? [...audio]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, file]) => ({
                key,
                ...fileMetadata(file, prepared.get(file)!.hash, ''),
              }))
          : null;
        const digest = await sha256(
          encodeJSON({
            expectedRevision: input.expectedRevision,
            state,
            audio: audioDigest,
          }),
        );
        const key = JSON.stringify([id, operationId]);
        const { record: current, dataset } = await checked(id);
        const previous = await metadata.operation(key);
        if (previous) {
          if (previous.digest !== digest)
            throw new StorageError(
              'CONFLICT',
              '同じ操作IDに異なる保存内容が指定されました。',
            );
          // Retry never re-applies an old state. If later saves exist, return the
          // latest committed record, not an obsolete snapshot of the earlier save.
          return current;
        }
        if (current.revision !== input.expectedRevision)
          throw new StorageError(
            'CONFLICT',
            '別の画面で調査が更新されています。この画面の編集は未保存です。編集を残すには別の分析として保存してください。',
          );
        if (current.revision === Number.MAX_SAFE_INTEGER)
          fail('調査revisionの上限です。');
        const next = {
          ...current,
          state,
          revision: current.revision + 1,
          updatedAt: new Date().toISOString(),
        };
        if (audio)
          next.audio = Object.fromEntries(
            [...audio].map(([binding, file]) => [
              binding,
              fileMetadata(
                file,
                prepared.get(file)!.hash,
                `${crypto.randomUUID()}-${prepared.get(file)!.hash}`,
              ),
            ]),
          );
        checkBudget(next, dataset);
        await checkTotalBudget(next);
        if (audio) {
          const available = new Map(
            [
              ...(current.source ? [current.source] : []),
              ...Object.values(current.audio),
            ].map((asset) => [asset.hash, asset]),
          );
          const bindings: [string, StoredAsset][] = [];
          for (const [binding, file] of audio) {
            const item = prepared.get(file)!;
            let stored = available.get(item.hash);
            if (stored) await readAsset(stored);
            else {
              stored = await writeAsset(item);
              available.set(item.hash, stored);
            }
            bindings.push([
              binding,
              fileMetadata(file, item.hash, stored.storageName),
            ]);
          }
          next.audio = Object.fromEntries(bindings);
        }
        assertOpen();
        return metadata.save(
          next,
          input.expectedRevision,
          { key, sessionId: id, digest },
          totalMaximum,
        );
      }),
    deleteSession: (id, expected) =>
      exclusive(async () => {
        if (
          expected !== undefined &&
          (!Number.isSafeInteger(expected) || expected < 1)
        )
          fail('削除元revisionが不正です。');
        await metadata.remove(id, expected);
        // Assets remain until explicit/next-start recovery, never delete assets
        // before a metadata commit; a failed cleanup cannot turn deletion into a lie.
      }),
    exportBundle: (id) =>
      exclusive(async () => {
        const { record, dataset } = await checked(id);
        const plan = bundlePlan(record, dataset.value);
        if (plan.size > maximum)
          throw new StorageError(
            'QUOTA',
            'バックアップ容量がこの環境の上限を超えています。',
          );
        const files: File[] = [];
        for (const reference of plan.assets)
          files.push(await readAsset(reference));
        assertOpen();
        return assembleBundle(plan.header, files);
      }),
    importBundle: (blob) =>
      exclusive(async () => {
        const input = await readBundle(blob, maximum);
        const record = await create(input);
        // Import bytes and persisted assets have already been verified before
        // commit. Do not introduce a second fallible read after a successful
        // commit that could make the caller retry a completed import.
        return {
          record,
          dataset: input.dataset,
          ...(input.source ? { source: input.source } : {}),
          audioFiles: input.audioFiles ?? new Map(),
        };
      }),
    requestPersistence: () =>
      exclusive(async () => {
        if (mode === 'memory' || !storage?.persist) return false;
        const result = await storage.persist();
        currentCapabilities = Object.freeze({
          ...currentCapabilities,
          persistentStorageGranted: result,
        });
        return result;
      }),
    collectOrphans: () =>
      exclusive(async () => {
        const records = (await metadata.list()).map(recordValue);
        const references = new Set(
          records.flatMap((record) => [
            ...(record.source ? [record.source.storageName] : []),
            ...Object.values(record.audio).map((asset) => asset.storageName),
          ]),
        );
        let removed = 0;
        if (directory) {
          const entries = directory as FileSystemDirectoryHandle & {
            entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
          };
          for await (const [entry, handle] of entries.entries()) {
            // Only our generated flat asset names are eligible for collection.
            if (
              handle.kind === 'file' &&
              PATH.test(entry) &&
              !references.has(entry)
            ) {
              await directory.removeEntry(entry);
              removed++;
            }
          }
        } else {
          for (const entry of memoryFiles.keys())
            if (!references.has(entry)) {
              memoryFiles.delete(entry);
              removed++;
            }
        }
        return { removed };
      }),
    close() {
      closed = true;
      metadata.close();
      memoryFiles.clear();
    },
  };
  try {
    await repository.collectOrphans();
  } catch (error) {
    repository.close();
    throw error;
  }
  return repository;
}
