import type { DataRow, Dataset } from './demo.ts';

const views = new WeakMap<Dataset, DataRow[]>();

/**
 * Read-only row views for algorithms/UI that consume named cells. Source rows
 * are never copied or modified. Only canonical Dataset values cross the worker
 * boundary; proxies must not be structured-cloned. Enumeration is supported for
 * the inspector and explicit CSV exports, including unusual source column names.
 * Datasets and derived maps are immutable once published, as with worker caching.
 */
export function datasetRows(dataset: Dataset): DataRow[] {
  if (!dataset.derivedColumns?.size) return dataset.rows;
  let rows = views.get(dataset);
  if (rows) return rows;
  const columns = new Set(dataset.columns);
  const value = (index: number, column: string) =>
    dataset.derivedColumns!.has(column)
      ? (dataset.derivedColumns!.get(column)!.get(index) ?? '')
      : dataset.rows[index][column];
  const handler: ProxyHandler<{ index: number }> = {
    get: (target, key) =>
      typeof key === 'string' && columns.has(key)
        ? value(target.index, key)
        : undefined,
    has: (_target, key) => typeof key === 'string' && columns.has(key),
    ownKeys: () => dataset.columns.slice(),
    getOwnPropertyDescriptor: (target, key) =>
      typeof key === 'string' && columns.has(key)
        ? {
            configurable: true,
            enumerable: true,
            writable: false,
            value: value(target.index, key),
          }
        : undefined,
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
    preventExtensions: () => false,
    setPrototypeOf: () => false,
  };
  rows = dataset.rows.map(
    (_row, index) => new Proxy({ index }, handler) as unknown as DataRow,
  );
  views.set(dataset, rows);
  return rows;
}
