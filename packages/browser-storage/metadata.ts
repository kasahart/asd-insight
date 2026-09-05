import type { SessionRecord, StorageDataset } from '../contracts/storage.ts';
import { StorageError } from './validation.ts';

export type DatasetEntry = { id: string; hash: string; value: StorageDataset };
type Operation = { key: string; sessionId: string; digest: string };
export interface Metadata {
  list(): Promise<SessionRecord[]>;
  get(id: string): Promise<{ record: SessionRecord; dataset: DatasetEntry }>;
  operation(key: string): Promise<Operation | undefined>;
  create(
    record: SessionRecord,
    dataset: DatasetEntry,
    limit: number,
  ): Promise<void>;
  save(
    record: SessionRecord,
    expected: number,
    operation: Operation,
    limit: number,
  ): Promise<SessionRecord>;
  remove(id: string, expected?: number): Promise<void>;
  close(): void;
}

function required<T>(value: T | undefined): T {
  if (!value)
    throw new StorageError('NOT_FOUND', '保存済みの調査が見つかりません。');
  return value;
}

function quota(
  records: SessionRecord[],
  candidate: SessionRecord,
  maximum: number,
) {
  const bytes = records
    .filter((record) => record.id !== candidate.id)
    .reduce((sum, record) => sum + record.bundleBytes, candidate.bundleBytes);
  if (!Number.isSafeInteger(bytes) || bytes > maximum)
    throw new StorageError(
      'QUOTA',
      '保存済み調査の合計容量が上限を超えます。既存の調査をバックアップして整理してください。',
    );
}

const clone = <T>(value: T): T => structuredClone(value);

export function memoryMetadata(): Metadata {
  const sessions = new Map<string, SessionRecord>();
  const datasets = new Map<string, DatasetEntry>();
  const operations = new Map<string, Operation>();
  return {
    async list() {
      return clone([...sessions.values()]);
    },
    async get(id) {
      const record = required(sessions.get(id));
      return clone({
        record,
        dataset: required(datasets.get(record.datasetVersionId)),
      });
    },
    async operation(key) {
      return clone(operations.get(key));
    },
    async create(record, dataset, maximum) {
      quota([...sessions.values()], record, maximum);
      if (sessions.has(record.id) || datasets.has(dataset.id))
        throw new StorageError('CONFLICT', '調査IDが重複しています。');
      datasets.set(dataset.id, clone(dataset));
      sessions.set(record.id, clone(record));
    },
    async save(record, expected, operation, maximum) {
      const current = required(sessions.get(record.id));
      const previous = operations.get(operation.key);
      if (previous) {
        if (previous.digest !== operation.digest)
          throw new StorageError(
            'CONFLICT',
            '同じ操作IDに異なる保存内容が指定されました。',
          );
        return clone(current);
      }
      if (current.revision !== expected)
        throw new StorageError(
          'CONFLICT',
          '別の画面で調査が更新されています。この画面の編集は未保存です。編集を残すには別の分析として保存してください。',
        );
      quota([...sessions.values()], record, maximum);
      sessions.set(record.id, clone(record));
      operations.set(operation.key, clone(operation));
      return clone(record);
    },
    async remove(id, expected) {
      const record = required(sessions.get(id));
      if (expected !== undefined && record.revision !== expected)
        throw new StorageError(
          'CONFLICT',
          '別の画面で調査が更新されています。',
        );
      sessions.delete(id);
      datasets.delete(record.datasetVersionId);
      for (const [key, value] of operations)
        if (value.sessionId === id) operations.delete(key);
    },
    close() {
      sessions.clear();
      datasets.clear();
      operations.clear();
    },
  };
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
}

function transaction<T>(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  body: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let result: T;
    let error: unknown;
    const tx = db.transaction(stores, mode);
    tx.oncomplete = () => resolve(result);
    tx.onabort = () =>
      reject(
        error ??
          tx.error ??
          new StorageError('IO', '保存transactionが中断されました。'),
      );
    tx.onerror = () => {
      /* onabort settles after rollback */
    };
    // Only IDB request promises are awaited inside this transaction.
    // No file access, hash work or unrelated timers may be added here.
    body(tx).then(
      (value) => {
        result = value;
      },
      (failure) => {
        error = failure;
        try {
          tx.abort();
        } catch {
          reject(failure);
        }
      },
    );
  });
}

export async function indexedMetadata(
  factory: IDBFactory,
  name: string,
  onClose: () => void,
): Promise<Metadata> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const opening = factory.open(name, 1);
    let rejected = false;
    opening.onupgradeneeded = () => {
      const value = opening.result;
      value.createObjectStore('sessions', { keyPath: 'id' });
      value.createObjectStore('datasets', { keyPath: 'id' });
      value
        .createObjectStore('operations', { keyPath: 'key' })
        .createIndex('sessionId', 'sessionId');
    };
    opening.onblocked = () => {
      rejected = true;
      reject(
        new StorageError(
          'BLOCKED',
          '別タブが保存領域を使用しています。別タブを閉じて再試行してください。',
        ),
      );
    };
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      if (rejected) opening.result.close();
      else resolve(opening.result);
    };
  });
  db.onversionchange = () => {
    db.close();
    onClose();
  };
  db.onclose = onClose;
  return {
    list: () =>
      transaction(
        db,
        ['sessions'],
        'readonly',
        async (tx) =>
          request(tx.objectStore('sessions').getAll()) as Promise<
            SessionRecord[]
          >,
      ),
    get: (id) =>
      transaction(db, ['sessions', 'datasets'], 'readonly', async (tx) => {
        const record = required(
          (await request(tx.objectStore('sessions').get(id))) as
            | SessionRecord
            | undefined,
        );
        const dataset = (await request(
          tx.objectStore('datasets').get(record.datasetVersionId),
        )) as DatasetEntry | undefined;
        if (!dataset)
          throw new StorageError(
            'CORRUPT',
            '調査に対応するデータが欠損しています。バックアップから復元してください。',
          );
        return { record, dataset };
      }),
    operation: (key) =>
      transaction(
        db,
        ['operations'],
        'readonly',
        async (tx) =>
          request(tx.objectStore('operations').get(key)) as Promise<
            Operation | undefined
          >,
      ),
    create: (record, dataset, maximum) =>
      transaction(db, ['sessions', 'datasets'], 'readwrite', async (tx) => {
        quota(
          await request(tx.objectStore('sessions').getAll()),
          record,
          maximum,
        );
        await request(tx.objectStore('datasets').add(dataset));
        await request(tx.objectStore('sessions').add(record));
      }),
    save: (record, expected, operation, maximum) =>
      transaction(db, ['sessions', 'operations'], 'readwrite', async (tx) => {
        const sessionStore = tx.objectStore('sessions');
        const operationStore = tx.objectStore('operations');
        const current = required(
          (await request(sessionStore.get(record.id))) as
            | SessionRecord
            | undefined,
        );
        const previous = (await request(operationStore.get(operation.key))) as
          | Operation
          | undefined;
        if (previous) {
          if (previous.digest !== operation.digest)
            throw new StorageError(
              'CONFLICT',
              '同じ操作IDに異なる保存内容が指定されました。',
            );
          return current;
        }
        if (current.revision !== expected)
          throw new StorageError(
            'CONFLICT',
            '別の画面で調査が更新されています。この画面の編集は未保存です。編集を残すには別の分析として保存してください。',
          );
        quota(await request(sessionStore.getAll()), record, maximum);
        await request(sessionStore.put(record));
        await request(operationStore.add(operation));
        return record;
      }),
    remove: (id, expected) =>
      transaction(
        db,
        ['sessions', 'datasets', 'operations'],
        'readwrite',
        async (tx) => {
          const record = required(
            (await request(tx.objectStore('sessions').get(id))) as
              | SessionRecord
              | undefined,
          );
          if (expected !== undefined && expected !== record.revision)
            throw new StorageError(
              'CONFLICT',
              '別の画面で調査が更新されています。',
            );
          await request(tx.objectStore('sessions').delete(id));
          await request(
            tx.objectStore('datasets').delete(record.datasetVersionId),
          );
          const keys = await request(
            tx.objectStore('operations').index('sessionId').getAllKeys(id),
          );
          await Promise.all(
            keys.map((key) =>
              request(tx.objectStore('operations').delete(key)),
            ),
          );
        },
      ),
    close: () => db.close(),
  };
}
