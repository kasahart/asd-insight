# ASD Insight

ASD Insight は、二つの基準群のスコア分布を比較し、重なりと基準との不一致候補を探索する、ブラウザー完結型の参考分析ツールです。検査合否、群分けの正しさ、真の誤判定率を決める用途には使用しません。

実データは音源を解析単位とし、CSV/TSVの属性を照合します。1音源に複数行が対応する場合は元CSVの最初の一致行を採用し、未対応・曖昧・非採用行を通知します。CSVだけの状態は入力準備として扱い、音源再指定まで集計しません。

データはブラウザー内で処理します。保存済み分析は同じブラウザープロファイルを使う利用者から参照できるため、共有端末ではブラウザーデータの管理方針に従ってください。

## 含まれるもの

- React / TypeScript による分析UI
- CSV診断、評価、保存、音声解析のドメイン実装
- 単体テストとPlaywrightのエンドツーエンドテスト
- 合成デモデータだけを使う利用者マニュアルと画面画像
- 固定バージョンの音声解析ランタイム準備スクリプト

生成済みの配布物、音声ランタイムのバイナリ、利用者データはGit管理しません。

## 必要条件

- Node.js 24.15 以上、25 未満
- Python 3
- E2Eテスト用のChromium（`npx playwright install chromium` などで別途準備）

## ローカル実行

```sh
npm ci
npm run runtime:prepare
npm run dev
```

開発サーバーは `http://127.0.0.1:5173` で起動します。`runtime:prepare` は、`runtime/lock.json` に固定された公開依存ファイルをローカルに準備します。生成物はGit管理しません。

## 階層WAVの対応づけ

「データを選ぶ」→「音源から開始」でWAVフォルダを選び、CSV/TSVから属性を付けます。対応列と未対応・曖昧・重複非採用を確認し、「対応を確認して解析を開始」を押すまで解析は作成しません。対応0件では開始できず、音源・CSV・対応列を選び直せます。CSVなしで新規解析は作成できません。作成済み解析の音源一覧では、CSV属性のない音源も再生できますが、分布比較には使いません。WAVから異常スコアは生成しません。従来のCSV先行の準備や軽量保存の再開でも、画面上部の「WAVフォルダを選択」から次へ進めます。選択したフォルダの直下を基準とする相対パス（例 `正常/設備A/001.wav`）でWAVを区別します。CSVに相対パスがあれば完全一致で照合し、ファイル名だけなら候補が一つのときだけ対応づけます。未対応行、曖昧な行、未参照WAV、重複参照は追加前の確認画面に表示されます。

一部音源を取り込んだ後に完全なフォルダを選び直すと、既存と同じ相対パスは全バイトの一致を確認して元のFile・メモ・手動除外・設定を保持し、不足分だけ追加します。同サイズ・同更新日時でも異なる内容は拒否します。選択内の同パス重複や、既存の対応が変わる／曖昧になる追加もバッチ全体を拒否し、一部適用しません。確認中・確認後の取消は元の分析を保ちます。照合は同パスだけ1 MiBずつ読み、PCMデコードはしません。軽量保存を再開してまだ読み戻していない音源は、従来どおり保存時の容量・更新日時で照合します（音源の全バイト照合情報を保存しているわけではありません）。

検出したフォルダ階層は群分け・絞り込みの列へ自動追加されます。現在の群分けは変更しません。サンプル一覧の「ファイル名」と「相対パス」はCSV/TSVの音声列から表示し、WAVの対応結果によって値を置き換えません。WAVが未対応または曖昧な行では、グレーの音声アイコンにカーソルを合わせると理由を確認できます。音声列は専用列に表示されるため属性列に重ねて表示しません。スコアと元のCSVは変更しません。「音源の指標対象件数」で実際の集計件数とスコア欠測・比較群欠測・条件外・手動除外などを確認できます。WAV数・CSV行数・採用音源数と指標対象件数は区別してください。

サンプル一覧は2×2の候補分類表から絞り込めます。表の列は表示の切り替えと並びの変更ができ、選択中のサンプルは先頭の固定表示と元の位置の両方に表示されます。固定表示は件数やCSV出力に重複して含めません。除外したサンプルは詳細パネルから集計に戻せます。

## 検証

```sh
npm test
npm run lint
npm run typecheck
npm run test:audio
npm run e2e
```

`npm run build` は静的配布物を `dist/` に出力します。配布時は、ビルド出力と音声ランタイムを同じリリースとして配置してください。

件数の固定上限は設けず、10万WAVを基準に検証しています。計測条件、容量制約、再現手順は[大規模データの検証](docs/scalability.md)を参照してください。

大容量音声には、CSV読み込み画面の「軽量保存」を選択できます。元CSV・WAV本体を複製せず、解析設定・調査メモ・除外履歴・入力照合情報を保存します。再開時は元CSVを選び直し、必要な音声フォルダを再選択してください。全量保存で容量不足になった場合も、現在の調査を軽量保存へコピーできます。[保存方式と再開手順](docs/reference-sessions.md)に、保存する内容、照合方法、容量条件を記載しています。

## マニュアル

ブラウザーで `manual/index.html` を開くと、合成デモデータに基づく操作手順を確認できます。

マニュアルには、実画面を使った約2分の操作動画、日本語字幕、練習用のCSV/WAV（`inspection.csv` / `tone.wav`）を含みます。動画は旧画面で撮影したため、音声取り込みは現行の操作順を参照してください。字幕はGitHub PagesなどHTTPで配信されたマニュアルで確認してください。`file://` で直接開くと、ブラウザーの制限で字幕を読み込めない場合があります。

## データの取り扱い

このリポジトリには実データ、実音源、個別案件の記録を含めません。利用時は組織のデータ分類、共有端末、バックアップ、DLPの規程に従ってください。

## ライセンス

このリポジトリにはライセンスを付与していません。利用・再配布についてはリポジトリ所有者に確認してください。音声ランタイムの依存コンポーネントには個別の上流ライセンスが適用されます。

### Shared spectrogram GUI kernel

`packages/wandas-gui-core` is a private, dependency-free source snapshot of
`audio-wandas-analyzer/src/shared/gui-core`. `upstream.json` pins its commit and
SHA-256 hashes; build rejects an edited snapshot. Update both files together with
`node scripts/sync-gui-core.mjs --from <Analyzer checkout>/src/shared/gui-core`
after committing the canonical package. No npm publication or Git submodule is required.

`src/lib/spectrogram-display.ts` keeps Insight's size limits, kHz controls, dBFS
reference, frequency/time interval selection, calculation floor, and legacy boundary
arithmetic. The shared kernel performs pooling and palette conversion. The React
chart retains resize/playhead/keyboard/accessibility behavior. Physical-axis and
boundary corrections from the standalone prototype are deliberately not part of
this stage; they require a separate rendering-contract change.

The pin may name the reviewed Analyzer PR head while that PR is unmerged.
Insight builds use the complete checked-in source and hashes; they do not fetch
that commit at runtime or build time. Keep the Analyzer source branch until both
changes are integrated, and re-pin Insight to the merged Analyzer commit after
squash/rebase merges. Sync validates the canonical directory and repository
origin and reads committed Git blobs, avoiding checkout line-ending filters.
