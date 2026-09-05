import type {
  CreateSessionInput,
  SessionRecord,
  StorageDataset,
  StoredAsset,
} from '../contracts/storage.ts';
import {
  LIMITS,
  StorageError,
  datasetValue,
  encodeJSON,
  exactKeys,
  fail,
  plain,
  sha256,
  stateValue,
  string,
} from './validation.ts';

const MAGIC = new TextEncoder().encode('OVLAB001');
const PREFIX_BYTES = 12;
type PortableAsset = Omit<StoredAsset, 'storageName'>;

function portable(asset: StoredAsset): PortableAsset {
  const { storageName: _path, ...result } = asset;
  return result;
}

export function bundlePlan(record: SessionRecord, dataset: StorageDataset) {
  const refs = [
    ...(record.source ? [record.source] : []),
    ...Object.values(record.audio),
  ];
  const assets = Array.from(
    new Map(refs.map((asset) => [asset.hash, asset])).values(),
  ).sort((a, b) => a.hash.localeCompare(b.hash));
  const metadata = {
    format: 'overlap-lab',
    version: 1,
    title: record.title,
    state: record.state,
    dataset,
    datasetHash: record.datasetHash,
    ...(record.source ? { source: portable(record.source) } : {}),
    audio: Object.entries(record.audio)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, asset]) => ({ key, asset: portable(asset) })),
    assets: assets.map(({ hash, size }) => ({ hash, size })),
  };
  const header = encodeJSON(metadata);
  if (header.byteLength > LIMITS.metadataBytes + LIMITS.stateBytes)
    fail('バックアップのmetadataが上限を超えています。');
  return {
    header,
    assets,
    size:
      PREFIX_BYTES +
      header.byteLength +
      assets.reduce((sum, asset) => sum + asset.size, 0),
  };
}

export function assembleBundle(
  header: Uint8Array<ArrayBuffer>,
  assets: Blob[],
): Blob {
  const prefix = new Uint8Array(PREFIX_BYTES);
  prefix.set(MAGIC);
  new DataView(prefix.buffer).setUint32(8, header.byteLength, false);
  return new Blob([prefix, header, ...assets], {
    type: 'application/x-overlap-lab-bundle',
  });
}

function assetValue(value: unknown): PortableAsset {
  if (!plain(value)) fail('資産情報が不正です。');
  exactKeys(value, ['hash', 'size', 'name', 'type', 'lastModified']);
  const hash = string(value.hash, '資産hash', 64);
  if (
    !/^[a-f0-9]{64}$/.test(hash) ||
    !Number.isSafeInteger(value.size) ||
    (value.size as number) < 0 ||
    (value.size as number) > LIMITS.assetBytes
  )
    fail('資産hashまたは容量が不正です。');
  if (
    !Number.isSafeInteger(value.lastModified) ||
    (value.lastModified as number) < 0
  )
    fail('資産日時が不正です。');
  return {
    hash,
    size: value.size as number,
    name: string(value.name, 'ファイル名'),
    type: string(value.type, 'MIME type', 256),
    lastModified: value.lastModified as number,
  };
}

/** A bounded, non-compressed format: no archive paths, symlinks or extraction expansion. */
export async function readBundle(
  blob: Blob,
  maxBytes: number,
): Promise<CreateSessionInput> {
  try {
    if (
      !(blob instanceof Blob) ||
      blob.size < PREFIX_BYTES ||
      blob.size > maxBytes
    )
      fail('復元bundleの容量が不正です。');
    const prefix = new Uint8Array(
      await blob.slice(0, PREFIX_BYTES).arrayBuffer(),
    );
    if (MAGIC.some((byte, i) => prefix[i] !== byte))
      fail('未対応の復元bundleです。');
    const headerBytes = new DataView(prefix.buffer).getUint32(8, false);
    if (
      !headerBytes ||
      headerBytes > LIMITS.metadataBytes + LIMITS.stateBytes ||
      PREFIX_BYTES + headerBytes > blob.size
    )
      fail('復元bundleのmetadata長が不正です。');
    const metadata: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        await blob
          .slice(PREFIX_BYTES, PREFIX_BYTES + headerBytes)
          .arrayBuffer(),
      ),
    );
    if (!plain(metadata)) fail('復元metadataが不正です。');
    exactKeys(
      metadata,
      [
        'format',
        'version',
        'title',
        'state',
        'dataset',
        'datasetHash',
        'source',
        'audio',
        'assets',
      ],
      [
        'format',
        'version',
        'title',
        'state',
        'dataset',
        'datasetHash',
        'audio',
        'assets',
      ],
    );
    if (metadata.format !== 'overlap-lab' || metadata.version !== 1)
      fail('未対応の復元bundleの版です。');
    const title = string(metadata.title, '調査名');
    const dataset = datasetValue(metadata.dataset);
    const state = stateValue(metadata.state);
    if ((await sha256(encodeJSON(dataset))) !== metadata.datasetHash)
      fail('データ内容とhashが一致しません。');
    if (
      !Array.isArray(metadata.audio) ||
      !Array.isArray(metadata.assets) ||
      metadata.audio.length > LIMITS.assetCount ||
      metadata.assets.length > LIMITS.assetCount + 1
    )
      fail('復元資産の件数が不正です。');
    const source =
      metadata.source === undefined ? undefined : assetValue(metadata.source);
    if (source && source.size > LIMITS.sourceBytes)
      fail('元CSV/TSVが容量上限を超えています。');
    const audio = metadata.audio.map((item) => {
      if (!plain(item)) fail('音声対応が不正です。');
      exactKeys(item, ['key', 'asset']);
      const key = string(item.key, '音声対応キー', 4096);
      if (!key) fail('音声対応キーが空です。');
      return { key, asset: assetValue(item.asset) };
    });
    if (new Set(audio.map(({ key }) => key)).size !== audio.length)
      fail('音声対応が重複しています。');
    const referenced = new Map<string, number>();
    for (const asset of [
      ...(source ? [source] : []),
      ...audio.map(({ asset }) => asset),
    ]) {
      if (
        referenced.has(asset.hash) &&
        referenced.get(asset.hash) !== asset.size
      )
        fail('同一hashの容量が一致しません。');
      referenced.set(asset.hash, asset.size);
    }
    const blobs = new Map<string, Blob>();
    let offset = PREFIX_BYTES + headerBytes;
    for (const entry of metadata.assets) {
      if (!plain(entry)) fail('資産entryが不正です。');
      exactKeys(entry, ['hash', 'size']);
      const hash = string(entry.hash, '資産hash', 64);
      if (
        !referenced.has(hash) ||
        referenced.get(hash) !== entry.size ||
        blobs.has(hash)
      )
        fail('未知・重複・不一致の資産entryです。');
      const size = entry.size as number;
      if (offset + size > blob.size)
        fail('復元bundleの資産が途中で切れています。');
      const part = blob.slice(offset, offset + size);
      if ((await sha256(await part.arrayBuffer())) !== hash)
        fail('復元資産の内容hashが一致しません。');
      blobs.set(hash, part);
      offset += size;
    }
    if (offset !== blob.size || blobs.size !== referenced.size)
      fail('復元bundleに欠落または余分な内容があります。');
    const file = (asset: PortableAsset) =>
      new File([blobs.get(asset.hash)!], asset.name, {
        type: asset.type,
        lastModified: asset.lastModified,
      });
    return {
      title,
      dataset,
      state,
      ...(source ? { source: file(source) } : {}),
      audioFiles: new Map(audio.map(({ key, asset }) => [key, file(asset)])),
    };
  } catch (error) {
    if (error instanceof StorageError && error.code === 'UNAVAILABLE')
      throw error;
    throw new StorageError(
      'CORRUPT',
      '復元bundleを検証できません。既存の調査は変更していません。',
      { cause: error },
    );
  }
}
