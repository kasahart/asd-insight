'use client';

import { Button } from '@/components/ui/button';
import { PersistentDetails } from '@/components/view-preferences';

const CSV_EXAMPLE = `sample_id,score,group,audio_file
sample-001,0.12,基準,sample-001.wav
sample-003,0.35,比較,sample-003.wav`;

export function CsvFormatGuide({
  onDownloadTemplate,
}: {
  onDownloadTemplate: () => void;
}) {
  return (
    <div className="csv-import-guide">
      <Button
        className="csv-import-template"
        type="button"
        variant="link"
        size="sm"
        onClick={onDownloadTemplate}
      >
        テンプレートCSVを保存
      </Button>
      <PersistentDetails
        preferenceKey="import.csvFormat"
        className="csv-format-details"
      >
        <summary>CSV・TSVの形式</summary>
        <div className="csv-format-content">
          <p className="csv-format-intro">
            列名は自由で、追加の列も使えます。表示後に「評価条件」で列を割り当てます。
          </p>
          <div className="csv-format-main">
            <section className="csv-format-columns" aria-label="列の役割">
              <table>
                <caption>比較に使う列</caption>
                <thead>
                  <tr>
                    <th scope="col">役割</th>
                    <th scope="col">列名の例</th>
                    <th scope="col">必要性</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row">異常度</th>
                    <td>
                      <code>score</code>
                    </td>
                    <td>必要・数値</td>
                  </tr>
                  <tr>
                    <th scope="row">群分け</th>
                    <td>
                      <code>group</code>
                    </td>
                    <td>必要・別の列</td>
                  </tr>
                  <tr>
                    <th scope="row">サンプル名</th>
                    <td>
                      <code>sample_id</code>
                    </td>
                    <td>任意</td>
                  </tr>
                  <tr>
                    <th scope="row">音声の対応</th>
                    <td>
                      <code>audio_file</code>
                    </td>
                    <td>任意</td>
                  </tr>
                </tbody>
              </table>
              <p>
                群分けはカテゴリ（基準・比較など）、または主観点数などの数値で指定できます。
                数値列だけでも読み込めますが、2群の比較には別の群分け列が必要です。
              </p>
              <p>
                <code>sample_id</code> / <code>id</code> /{' '}
                <code>inspection_id</code> / <code>検査id</code>{' '}
                は、空欄・重複なしにしてください。
              </p>
            </section>
            <section className="csv-format-example" aria-label="CSVの記入例">
              <h3>記入例 · 2検査</h3>
              {/* Keyboard access is needed when a narrow dialog clips a CSV line. */}
              {/* oxlint-disable jsx-a11y/no-noninteractive-tabindex */}
              <pre tabIndex={0} aria-label="列名と2検査のCSV例">
                <code>{CSV_EXAMPLE}</code>
              </pre>
              {/* oxlint-enable jsx-a11y/no-noninteractive-tabindex */}
              <p>
                1行目は列名、以降は1行＝1検査。TSVはカンマをタブに置き換えます。
              </p>
              <div className="csv-format-audio">
                <h3>音声はあとから追加</h3>
                <p>
                  音声なしでも比較できます。試聴・スペクトログラムを使う場合は、表示後の「サンプル名・試聴音声」で音声を追加します。
                </p>
                <p>
                  <code>audio_file</code>{' '}
                  には拡張子つきファイル名を記入し、選択する音声の名前と一致させます。パスの場合は末尾のファイル名で照合します。CSVのURLやパスからは自動取得しません。
                </p>
              </div>
            </section>
          </div>
          <dl className="csv-format-rules">
            <div>
              <dt>保存・上限</dt>
              <dd>UTF-8（BOM可）・20MBまで。データ100,000行・128列まで。</dd>
            </div>
            <div>
              <dt>列と区切り</dt>
              <dd>
                列名は空欄・重複なし。CSVはカンマ、TSVはタブ区切り。欠測でも区切りを残し、全行を同じ列数にします。
              </dd>
            </div>
            <div>
              <dt>数値</dt>
              <dd>
                小数点は <code>.</code>、桁区切りなし（例：<code>0.12</code> /{' '}
                <code>1.2e-3</code>）。欠測・非数値の異常度は集計対象外です。
              </dd>
            </div>
            <div>
              <dt>引用符</dt>
              <dd>
                区切りや改行を含む値は <code>&quot;...&quot;</code> で囲み、値の{' '}
                <code>&quot;</code> は <code>&quot;&quot;</code> と書きます。
              </dd>
            </div>
          </dl>
        </div>
      </PersistentDetails>
    </div>
  );
}
