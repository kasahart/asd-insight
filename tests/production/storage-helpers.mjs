import { IDBFactory } from 'fake-indexeddb';

export function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function fixture() {
  const control = {
    writeError: null,
    closeError: null,
    truncateWrite: false,
    beforeRead: null,
    beforeClose: null,
  };
  function directory(name) {
    const children = new Map();
    return {
      kind: 'directory',
      name,
      children,
      async getDirectoryHandle(key, options = {}) {
        if (!children.has(key)) {
          if (!options.create)
            throw new DOMException('Missing directory', 'NotFoundError');
          children.set(key, directory(key));
        }
        const value = children.get(key);
        if (value.kind !== 'directory')
          throw new DOMException('Not a directory', 'TypeMismatchError');
        return value;
      },
      async getFileHandle(key, options = {}) {
        if (!children.has(key)) {
          if (!options.create)
            throw new DOMException('Missing file', 'NotFoundError');
          const handle = {
            kind: 'file',
            name: key,
            blob: new Blob(),
            async getFile() {
              if (control.beforeRead) await control.beforeRead(handle);
              return new File([handle.blob], key);
            },
            async createWritable() {
              let pending = new Blob();
              return {
                async write(blob) {
                  if (control.writeError) {
                    const error = control.writeError;
                    control.writeError = null;
                    throw error;
                  }
                  pending = blob;
                },
                async close() {
                  if (control.beforeClose) await control.beforeClose(handle);
                  if (control.closeError) {
                    const error = control.closeError;
                    control.closeError = null;
                    throw error;
                  }
                  handle.blob = control.truncateWrite
                    ? pending.slice(0, Math.max(0, pending.size - 1))
                    : pending;
                },
                async abort() {
                  pending = new Blob();
                },
              };
            },
          };
          children.set(key, handle);
        }
        return children.get(key);
      },
      async removeEntry(key) {
        children.delete(key);
      },
      async *entries() {
        for (const entry of children) yield entry;
      },
    };
  }
  const root = directory('root');
  const tails = new Map();
  const locks = {
    async request(name, _options, body) {
      const prior = tails.get(name) ?? Promise.resolve();
      const result = prior.then(() => body({ name, mode: 'exclusive' }));
      tails.set(
        name,
        result.catch(() => undefined),
      );
      return result;
    },
  };
  let persistent = false;
  const storageManager = {
    async getDirectory() {
      return root;
    },
    async persist() {
      persistent = true;
      return true;
    },
    async persisted() {
      return persistent;
    },
  };
  const indexedDB = new IDBFactory();
  const databaseName = `storage-test-${crypto.randomUUID()}`;
  const options = {
    indexedDB,
    opfsRoot: root,
    storageManager,
    lockManager: locks,
    databaseName,
  };
  const files = () => {
    const result = [];
    const visit = (entry) => {
      if (entry.kind === 'file') result.push(entry);
      else for (const child of entry.children.values()) visit(child);
    };
    visit(root);
    return result;
  };
  return { options, control, root, files, indexedDB, databaseName };
}

export function input(overrides = {}) {
  return {
    title: 'Synthetic review',
    dataset: {
      name: 'sample.csv',
      columns: ['sample_id', 'score', 'group'],
      rows: [{ sample_id: 's1', score: '0.25', group: 'A' }],
      demo: false,
    },
    source: new File(['sample_id,score,group\r\ns1,0.25,A\r\n'], 'sample.csv', {
      type: 'text/csv',
      lastModified: 1000,
    }),
    state: { selected: 0, notes: { s1: 'check' }, excluded: [] },
    audioFiles: new Map([
      [
        's1',
        new File([new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4])], 's1.wav', {
          type: 'audio/wav',
          lastModified: 2000,
        }),
      ],
    ]),
    ...overrides,
  };
}

export async function rawDatabase(fixture) {
  return new Promise((resolve, reject) => {
    const request = fixture.indexedDB.open(fixture.databaseName, 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function rawTransaction(db, stores, body) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite');
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error);
    body(tx);
  });
}

export async function rewriteBundle(blob, change, changeBody = (body) => body) {
  const prefix = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const length = new DataView(prefix.buffer).getUint32(8, false);
  const metadata = JSON.parse(await blob.slice(12, 12 + length).text());
  change(metadata);
  const header = new TextEncoder().encode(JSON.stringify(metadata));
  new DataView(prefix.buffer).setUint32(8, header.byteLength, false);
  return new Blob([prefix, header, changeBody(blob.slice(12 + length))]);
}
