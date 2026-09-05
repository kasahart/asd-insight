export type StorageDataset = {
  name: string;
  columns: string[];
  rows: Record<string, string>[];
  demo: boolean;
};

export type StorageMode = 'persistent' | 'memory';
export type StoredAsset = {
  storageName: string;
  hash: string;
  size: number;
  name: string;
  type: string;
  lastModified: number;
};

export type SessionRecord = {
  id: string;
  datasetVersionId: string;
  title: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  state: Record<string, unknown>;
  audio: Record<string, StoredAsset>;
  source?: StoredAsset;
  datasetHash: string;
  /** Complete bundle size, including its manifest, for this revision. */
  bundleBytes: number;
};

export type LoadedSession = {
  record: SessionRecord;
  dataset: StorageDataset;
  source?: File;
  audioFiles: Map<string, File>;
};

export type CreateSessionInput = {
  title: string;
  dataset: StorageDataset;
  source?: File;
  state: Record<string, unknown>;
  audioFiles?: Map<string, File>;
};

export type SaveSessionInput = {
  expectedRevision: number;
  operationId: string;
  state: Record<string, unknown>;
  /** Omitted: retain bindings. Present: replace the complete binding map. */
  audioFiles?: Map<string, File>;
};

export type StorageCapabilities = {
  mode: StorageMode;
  persistentStorageGranted: boolean;
  indexedDB: boolean;
  opfs: boolean;
  crossTabLock: boolean;
  maxBundleBytes: number;
  maxTotalBytes: number;
};

export interface BrowserRepository {
  readonly mode: StorageMode;
  readonly capabilities: StorageCapabilities;
  listSessions(): Promise<SessionRecord[]>;
  createSession(input: CreateSessionInput): Promise<SessionRecord>;
  loadSession(id: string): Promise<LoadedSession>;
  saveSession(id: string, input: SaveSessionInput): Promise<SessionRecord>;
  deleteSession(id: string, expectedRevision?: number): Promise<void>;
  exportBundle(id: string): Promise<Blob>;
  importBundle(blob: Blob): Promise<LoadedSession>;
  requestPersistence(): Promise<boolean>;
  collectOrphans(): Promise<{ removed: number }>;
  close(): void;
}
