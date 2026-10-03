import { useEffect, useMemo, useRef, useState } from 'react';
import { audioPopulation } from '@domain/audio-population';
import type { Dataset } from '@/lib/demo';
import { downloadBlob } from './production-app';
import { Button } from './ui/button';

export function AudioPopulationNotice({
  dataset,
  idColumn,
  audioColumn,
  files,
  notes,
  downloads,
}: {
  dataset: Dataset;
  idColumn: string;
  audioColumn: string;
  files: Map<string, File>;
  notes: Record<number, string>;
  downloads: boolean;
}) {
  const population = useMemo(
    () => audioPopulation(dataset, idColumn, audioColumn, files),
    [dataset, idColumn, audioColumn, files],
  );
  const pagingKey = `${population.signature}:${files.size}`;
  const [paging, setPaging] = useState({ key: pagingKey, page: 0 });
  const page = paging.key === pagingKey ? paging.page : 0;
  const [diagnosticsPaging, setDiagnosticsPaging] = useState({
    key: pagingKey,
    page: 0,
  });
  const diagnosticsPage =
    diagnosticsPaging.key === pagingKey ? diagnosticsPaging.page : 0;
  const [selectedKey, setSelectedKey] = useState('');
  const player = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const element = player.current;
    if (!element) return;
    const file = files.get(selectedKey);
    if (!file) {
      element.pause();
      element.removeAttribute('src');
      element.load();
      return;
    }
    const url = URL.createObjectURL(file);
    element.src = url;
    return () => {
      element.pause();
      element.removeAttribute('src');
      element.load();
      URL.revokeObjectURL(url);
    };
  }, [files, selectedKey]);
  const unjoined = useMemo(
    () =>
      population.inventory.filter((entry) => entry.rowIndex === undefined)
        .length,
    [population],
  );
  const rows = useMemo(
    () =>
      [
        ...population.missing.map((row) => ({
          index: row.index,
          status: '音源未対応',
          detail: row.expected.join(' / '),
        })),
        ...population.ambiguous.map((row) => ({
          index: row.index,
          status: '音源候補が曖昧',
          detail: row.candidates.join(' / '),
        })),
        ...population.duplicates.map((row) => ({
          index: row.index,
          status: '重複・非採用',
          detail: `${row.key}：元CSV ${row.adoptedIndex + 1}行目を採用`,
        })),
      ].sort((a, b) => a.index - b.index),
    [population],
  );
  if (dataset.demo) return null;
  return (
    <section className="audio-import-preview" aria-label="音源とCSV属性の対応">
      <h2>音源とCSV属性の対応</h2>
      <output>
        音源 {files.size.toLocaleString()}件、CSV属性を採用した音源{' '}
        {population.adopted.size.toLocaleString()}件、CSV属性なし{' '}
        {unjoined.toLocaleString()}件。
      </output>
      <p>
        元CSVの上から最初の一致行を音源の属性として採用します。表示順・ソートでは変わりません。複数行の属性を混ぜません。
      </p>
      <p>
        音源未対応 {population.missing.length.toLocaleString()}行、候補が曖昧{' '}
        {population.ambiguous.length.toLocaleString()}行、重複で非採用{' '}
        {population.duplicates.length.toLocaleString()}
        行は解析対象外です。元CSV・メモ・手動除外は保持します。
      </p>
      {!population.adopted.size && (
        <p role="alert">
          解析対象は0件です。CSVとWAVフォルダの対応を確認してください。入力準備中は指標を計算しません。
        </p>
      )}
      {rows.length > 0 && (
        <details>
          <summary>対象外の元CSV行（{rows.length.toLocaleString()}行）</summary>
          <ul>
            {rows
              .slice(diagnosticsPage * 100, (diagnosticsPage + 1) * 100)
              .map((row) => (
                <li key={row.index}>
                  元CSV {row.index + 1}行目：{row.status} — {row.detail}
                  {notes[row.index] ? ` / メモ：${notes[row.index]}` : ''}
                </li>
              ))}
          </ul>
          {rows.length > 100 && (
            <p>100行ずつ表示します。全行を診断ファイルでも確認できます。</p>
          )}
          {rows.length > 100 && (
            <>
              <Button
                disabled={!diagnosticsPage}
                onClick={() =>
                  setDiagnosticsPaging({
                    key: pagingKey,
                    page: diagnosticsPage - 1,
                  })
                }
              >
                対象外の前の100行
              </Button>
              <Button
                disabled={(diagnosticsPage + 1) * 100 >= rows.length}
                onClick={() =>
                  setDiagnosticsPaging({
                    key: pagingKey,
                    page: diagnosticsPage + 1,
                  })
                }
              >
                対象外の次の100行
              </Button>
            </>
          )}
          {downloads && (
            <Button
              onClick={() =>
                downloadBlob(
                  new Blob(
                    [
                      JSON.stringify(
                        {
                          policy: population.policy,
                          rows: rows.map((row) => ({
                            sourceRow: row.index + 1,
                            status: row.status,
                            detail: row.detail,
                            note: notes[row.index] ?? '',
                            attributes: dataset.rows[row.index],
                          })),
                        },
                        null,
                        2,
                      ),
                    ],
                    { type: 'application/json' },
                  ),
                  'audio-csv-diagnostics.json',
                )
              }
            >
              対象外の全行をダウンロード
            </Button>
          )}
        </details>
      )}
      <details>
        <summary>音源一覧（{files.size.toLocaleString()}件）</summary>
        <p>
          CSV属性のない音源も再生できます。スコア・群情報が欠測の音源は対応する指標の対象外です。
        </p>
        <ul>
          {population.inventory
            .slice(page * 50, (page + 1) * 50)
            .map((entry) => (
              <li key={entry.key}>
                <Button
                  variant="ghost"
                  onClick={() => setSelectedKey(entry.key)}
                >
                  {entry.key}
                </Button>{' '}
                —{' '}
                {entry.rowIndex === undefined
                  ? 'CSV属性なし'
                  : `CSV属性あり：元CSV ${entry.rowIndex + 1}行目`}
              </li>
            ))}
        </ul>
        <Button
          disabled={!page}
          onClick={() => setPaging({ key: pagingKey, page: page - 1 })}
        >
          前の50件
        </Button>
        <Button
          disabled={(page + 1) * 50 >= files.size}
          onClick={() => setPaging({ key: pagingKey, page: page + 1 })}
        >
          次の50件
        </Button>
        {/* Acoustic recordings do not have speech captions. */}
        {/* oxlint-disable jsx-a11y/media-has-caption */}
        <audio
          ref={player}
          hidden={!files.has(selectedKey)}
          controls
          aria-label={`${selectedKey} の再生`}
        />
        {/* oxlint-enable jsx-a11y/media-has-caption */}
      </details>
    </section>
  );
}
