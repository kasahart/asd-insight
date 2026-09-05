import type { StorageDataset } from '../contracts/storage.ts';

export type StorageErrorCode =
  | 'UNAVAILABLE'
  | 'QUOTA'
  | 'CONFLICT'
  | 'NOT_FOUND'
  | 'CORRUPT'
  | 'VALIDATION'
  | 'CLOSED'
  | 'BLOCKED'
  | 'IO';

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  constructor(code: StorageErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StorageError';
    this.code = code;
  }
}

export const LIMITS = Object.freeze({
  bundleBytes: 128 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
  assetBytes: 80 * 1024 * 1024,
  sourceBytes: 20 * 1024 * 1024,
  metadataBytes: 48 * 1024 * 1024,
  stateBytes: 2 * 1024 * 1024,
  assetCount: 2000,
  rows: 100_000,
  columns: 128,
});

export function fail(message: string): never {
  throw new StorageError('VALIDATION', message);
}

export function plain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function string(value: unknown, label: string, maximum = 1024): string {
  if (typeof value !== 'string' || value.length > maximum)
    fail(`${label}が不正です。`);
  return value;
}

export function exactKeys(
  value: Record<string, unknown>,
  allowed: string[],
  required = allowed,
): void {
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  ) {
    fail('保存形式に未対応または欠落した項目があります。');
  }
}

/** Only plain, finite JSON. Accessors, cycles, holes and silent JSON coercions are rejected. */
export function jsonValue(value: unknown): unknown {
  const ancestors = new Set<object>();
  let nodes = 0;
  function visit(input: unknown, depth: number): unknown {
    if (++nodes > 1_000_000 || depth > 64) fail('保存する状態が複雑すぎます。');
    if (
      input === null ||
      typeof input === 'boolean' ||
      typeof input === 'string'
    )
      return input;
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) fail('NaN/Infinityは保存できません。');
      return input;
    }
    if (!Array.isArray(input) && !plain(input))
      fail('保存する状態は通常のJSONにしてください。');
    if (ancestors.has(input)) fail('循環する状態は保存できません。');
    ancestors.add(input);
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(input).some((key) => typeof key === 'symbol'))
      fail('Symbolは保存できません。');
    for (const descriptor of Object.values(descriptors)) {
      if ('get' in descriptor || 'set' in descriptor)
        fail('アクセサーは保存できません。');
    }
    let result: unknown;
    if (Array.isArray(input)) {
      if (
        Object.keys(input).length !== input.length ||
        Object.keys(input).some((key, i) => key !== String(i))
      )
        fail('欠落要素や追加属性のある配列は保存できません。');
      result = input.map((item) => visit(item, depth + 1));
    } else {
      result = Object.fromEntries(
        Object.keys(input)
          .sort()
          .map((key) => [key, visit(descriptors[key].value, depth + 1)]),
      );
    }
    ancestors.delete(input);
    return result;
  }
  return visit(value, 0);
}

export function encodeJSON(value: unknown): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(value));
}

export function stateValue(value: unknown): Record<string, unknown> {
  if (!plain(value)) fail('調査状態はJSONオブジェクトにしてください。');
  const result = jsonValue(value) as Record<string, unknown>;
  if (encodeJSON(result).byteLength > LIMITS.stateBytes)
    fail('調査状態は2MiB以下にしてください。');
  return result;
}

export function datasetValue(value: unknown): StorageDataset {
  if (!plain(value)) fail('データ形式が不正です。');
  exactKeys(value, ['name', 'columns', 'rows', 'demo']);
  const name = string(value.name, 'データ名');
  if (
    !name.trim() ||
    typeof value.demo !== 'boolean' ||
    !Array.isArray(value.columns) ||
    !Array.isArray(value.rows)
  )
    fail('データ形式が不正です。');
  const columns = value.columns.map((item) => string(item, '列名', 4096));
  if (
    !columns.length ||
    columns.length > LIMITS.columns ||
    new Set(columns).size !== columns.length ||
    columns.some((column) => !column.trim())
  )
    fail('列は重複のない1〜128列にしてください。');
  if (!value.rows.length || value.rows.length > LIMITS.rows)
    fail('行数は1〜100,000行にしてください。');
  const rows = value.rows.map((row) => {
    if (!plain(row)) fail('行形式が不正です。');
    exactKeys(row, columns);
    return Object.fromEntries(
      columns.map((column) => [
        column,
        string(row[column], 'セル', LIMITS.sourceBytes),
      ]),
    );
  });
  const dataset = { name, columns, rows, demo: value.demo };
  if (encodeJSON(dataset).byteLength > LIMITS.metadataBytes)
    fail('展開後データが保存上限を超えています。');
  return dataset;
}

export async function sha256(
  bytes: ArrayBuffer | Uint8Array<ArrayBuffer>,
): Promise<string> {
  if (!globalThis.crypto?.subtle)
    throw new StorageError(
      'UNAVAILABLE',
      '内容ハッシュを計算できません。HTTPS対応環境で開いてください。',
    );
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (part) =>
    part.toString(16).padStart(2, '0'),
  ).join('');
}

export function normalizeError(error: unknown): StorageError {
  if (error instanceof StorageError) return error;
  const name = error instanceof Error ? error.name : '';
  if (name === 'QuotaExceededError')
    return new StorageError(
      'QUOTA',
      'ブラウザーの保存容量が不足しています。既存データは保持されています。',
      { cause: error },
    );
  return new StorageError(
    'IO',
    'ブラウザー保存に失敗しました。再試行またはバックアップを行ってください。',
    { cause: error },
  );
}
