'use client';

import { useId } from 'react';
import type { CSVColumnCountDiagnostic } from '@/lib/csv-diagnostics';

function visibleSeparators(value: string) {
  return value.replaceAll('\t', '⇥').replace(/\r\n|\r|\n/g, '↵\n');
}

export function CsvImportError({
  message,
  diagnostic,
}: {
  message: string;
  diagnostic?: CSVColumnCountDiagnostic;
}) {
  const titleId = useId();
  return (
    <div
      className="data-source-error csv-import-error"
      role="alert"
      aria-labelledby={titleId}
    >
      <p id={titleId} className="csv-import-error-title">
        {message}
      </p>
      {diagnostic && (
        <>
          <p className="csv-import-error-context">
            <span>{diagnostic.fileName}</span>
            <span>
              区切り：
              {diagnostic.delimiter === '\t' ? 'タブ（⇥）' : 'カンマ（,）'}
            </span>
            <span>ヘッダー：ファイルの{diagnostic.headerLine}行目から</span>
          </p>
          <div className="csv-import-error-comparison">
            {/* This bounded evidence table remains keyboard-scrollable. */}
            {/* oxlint-disable jsx-a11y/no-noninteractive-tabindex */}
            <section
              className="csv-import-error-table"
              tabIndex={0}
              aria-label="ヘッダーと読み取った列の比較"
            >
              <table>
                <caption>
                  必要な列数 {diagnostic.expectedColumns} ／ 読み取った列数{' '}
                  {diagnostic.actualColumns}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">列</th>
                    <th scope="col">ヘッダー</th>
                    <th scope="col">読み取った値</th>
                  </tr>
                </thead>
                <tbody>
                  {diagnostic.columns.map((column) => (
                    <tr
                      key={column.position}
                      data-mismatch={
                        column.header === null || column.value === null
                      }
                    >
                      <th scope="row">{column.position}</th>
                      <td>
                        {column.header === null ? (
                          <span className="csv-import-missing">
                            対応する列なし
                          </span>
                        ) : (
                          visibleSeparators(column.header)
                        )}
                      </td>
                      <td>
                        {column.value === null ? (
                          <span className="csv-import-missing">セル不足</span>
                        ) : column.value === '' ? (
                          <span className="csv-import-empty">空欄</span>
                        ) : (
                          visibleSeparators(column.value)
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {diagnostic.omittedColumns > 0 && (
                <p className="csv-import-evidence-note">
                  中間の{diagnostic.omittedColumns}列は省略しています。
                </p>
              )}
            </section>
            {/* oxlint-enable jsx-a11y/no-noninteractive-tabindex */}
            <div className="csv-import-error-record">
              <h4>
                該当箇所：ファイルの{diagnostic.startLine}
                {diagnostic.endLine !== diagnostic.startLine
                  ? `〜${diagnostic.endLine}`
                  : ''}
                行目
              </h4>
              {/* oxlint-disable jsx-a11y/no-noninteractive-tabindex */}
              <pre tabIndex={0} aria-label="該当箇所の元データ">
                <code>{visibleSeparators(diagnostic.rawRecord)}</code>
              </pre>
              {/* oxlint-enable jsx-a11y/no-noninteractive-tabindex */}
              <p className="csv-import-evidence-note">
                ⇥ はタブ、↵ はセル内の改行です。
                {diagnostic.rawRecordTruncated &&
                  '長い内容は一部を「…」で省略しています。'}
              </p>
              <ul>
                {diagnostic.hints.map((hint, index) => (
                  <li key={index}>{hint}</li>
                ))}
              </ul>
            </div>
          </div>
          <p className="csv-import-evidence-note">
            左から読み取った順の比較です。値がずれ始めた位置は、この表だけでは確定できません。
            長いセル内容は「…」で省略します。
          </p>
          <p className="csv-import-error-retry">
            ファイルを修正して、もう一度選び直してください。表示中のデータは変更していません。
          </p>
        </>
      )}
    </div>
  );
}
