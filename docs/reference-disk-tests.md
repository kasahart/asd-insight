# 実ディスクWAVによる軽量保存の回帰テスト

PR #13 の軽量保存・再開経路を既存のPlaywright E2Eで検証します。OSのフォルダ選択ダイアログはPlaywrightの `input[webkitdirectory].setInputFiles(directory)` で代替し、Chromiumが実ディスクのFileを読みます。CSV/WAVのバイト列、IndexedDB、OPFS、音声ランタイム、HTML audioは実物です。合成FileSystem handlesや同一バイト列の繰り返しは、この試験には使用しません。

これは隔離されたブラウザープロファイルでの自動回帰試験です。ユーザーの手動Chrome操作、Chrome拡張によるファイルアクセス、OSダイアログの動作確認や、その動画エビデンスとは別です。権限設定を変更しません。

## 通常の回帰テスト

```sh
npm run e2e -- tests/e2e/reference-disk.spec.ts
```

テスト出力領域に異なる内容の4,044バイトPCM WAVを8件生成し、以下を確認します。

- 軽量保存でCSVと実ディスクのWAVフォルダを取り込み、メモ・手動除外・探索しきい値・判断絞り込みを設定する。
- reload後に保存分析を開き、同じCSVを再指定する。音声未指定のまま解析設定・しきい値・メモ・除外履歴・検索条件を照合する。
- 同じWAVフォルダを再指定し、状態を再度照合する。CSV群分けとWAVフォルダ階層の群分けを別ケースにする。
- URL.createObjectURLで作られる実際の末尾audio Blobを観測し、SHA-256を実ディスクの末尾WAVと照合する（CSPを変更せず、blob URLへのfetchは行わない）。0.25秒の音声をnative controlsから再生する。playing/endedイベントとcurrentTimeを確認する。
- 保存recordに音声assetも元CSV assetもなく、保存datasetのrowsが空で、OPFSファイルが0件であることを確認する。
- ダウンロードしたversion 2バックアップの容量がrecord.bundleBytesと一致し、全バイトがmanifestだけで入力本体のframeがないことを確認する。

## 重い規模テスト（明示指定時のみ）

従来の100,001件の合成handle規模テストも `OVERLAP_E2E_SCALE=1` のときだけ実行します。通常の `npm run e2e` から高コストの2試験を除きます。

404 MBの実ディスクfixtureはgitへ追加しません。生成先には未作成のディレクトリを指定してください。既存fixtureは上書きしません。

```sh
python3 scripts/generate-reference-wav-fixture.py \
  --count 100001 --output /tmp/asd-reference-wav-100001
OVERLAP_E2E_DISK_FIXTURE=/tmp/asd-reference-wav-100001 npm run e2e:scale
```

既存fixtureを再利用して実ディスク試験だけ実行する場合:

```sh
OVERLAP_E2E_SCALE=1 \
OVERLAP_E2E_DISK_FIXTURE=/absolute/path/to/stage-100001 \
npm run e2e -- tests/e2e/reference-disk-scale.spec.ts
```

fixtureは `manifest.json`、`synthetic-100001.csv`、`wav/group_*/device_*/syn_*.wav` を含みます。テストはmanifestの申告だけに依存せず、全CSV行の参照先・全WAVの実バイト数/PCM header/SHA-256を走査し、100,001件すべて異なる内容であることを確認します。WAV合計404,404,044バイト。生成データは合成ノイズで、実録音や個人情報を含みません。

実ディスク試験は通常ケースと同じ保存・再開・再指定・末尾再生を100,001件で行い、バックアップがWAV本体の25%未満であることも確認します。WAVフォルダ階層で群分けし、しきい値と判断絞り込みの保存状態も規模条件で確認します。通常ケースにはCSV群分けも残します。

実行結果の件数・容量・段階別経過時間・OPFSファイル数・末尾音声hash/再生時間は `test-results/**/disk-reference-result.json` とPlaywrightの添付に残ります。失敗時は標準のtraceとスクリーンショットを保存します。音声全件のデコードや再生、ネイティブFile System Access APIのpicker、任意形式/長時間音声の性能を保証する試験ではありません。時間は端末負荷、ディスク、ブラウザーによって変わります。

## 再開時の回帰仕様

保存時に群設定オブジェクトのキーが整列しても、設定の意味が同じならしきい値・判断絞り込みを維持します。既存のscope保存形式を保ち、比較時だけJSONオブジェクトのキー順を正規化します。配列の順序、値、CSVの論理hash、フォルダmembership signatureなどが変わった場合は区別します。新しい通常WAV階層ケースで修正前のしきい値消失を再現し、修正後の保持を検証します。

## 実測結果（2026-10-02）

既存の合成データ `stage-100001` を再利用した、実ディスク・WAV階層群分けの重い試験は成功しました。

| 項目 | 実測 |
|---|---:|
| 異なるWAV内容 | 100,001件 |
| WAV本体合計 | 404,404,044バイト |
| CSV | 7,100,104バイト |
| fixture全件照合 | 3.429秒 |
| 初回WAV取り込み完了（開始から） | 15.241秒 |
| 軽量バックアップ取得完了（開始から） | 51.216秒 |
| CSV再開完了（開始から） | 63.676秒 |
| 再指定・末尾再生を含む全体 | 117.789秒 |
| ダウンロードした軽量バックアップ | 10,803,992バイト |
| 再指定後の保存recordのbundleBytes | 10,802,947バイト |
| OPFSファイル数 | 0件 |
| 末尾再生 | 0.25秒、playing/endedを確認 |
| pageerror | 0件 |

末尾の実音声Blobと実ディスクWAVのSHA-256は `8905300f488a23c47f5e1fbb6d68b1a390d1bf7d016af07bc806a34e524155c3` で一致しました。保存recordとバックアップの数値は異なる時点の測定です。音声解析結果のメタデータが非同期に更新されるため、バックアップ取得時点の保存recordを読み直して容量一致を検証します。時間はこの環境での実測であり、上限の保証ではありません。

通常E2Eは30件成功、opt-inの2件はスキップ。型検査・lint・本番build・単体テスト20ファイルは成功。通常WAV階層ケースと規模ケースの両方で、しきい値と判断絞り込みの保持を確認しました。
opt-inの規模試験は実ディスク版と従来の合成handle版の2件とも成功（合計約3.7分）。通常E2Eと合わせて全32ケース成功です。
