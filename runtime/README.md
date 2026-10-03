# Audio runtime

`lock.json` は音声解析で使う Wandas / Pyodide とその依存ファイルの固定バージョンおよびハッシュを記録します。

公開版Wandas 0.8.1のwheelをPyPIから取得します。`upstreamCommit` は対応する `v0.8.1` タグのcommitです。`inspect` / `frame_center_times` はこの公開版のAPIを使用します。

準備には Python 3 が必要です。

```sh
python3 scripts/prepare-audio-runtime.py
python3 scripts/prepare-audio-runtime.py --check
npm ci
npm run test:audio
npm run test:inputs
CI=1 npm run e2e
```

準備済みファイルは `runtime/prepared/runtime/audio/` に生成され、Git管理しません。準備時に取得内容のSHA-256をlockと照合します。静的配布では、このディレクトリをアプリケーションと同じリリースに含めてください。

生成物には上流コンポーネントのライセンス条件が適用されます。配布前に、固定された依存関係と同梱されるライセンス通知を確認してください。

CIは公開wheelを準備して数値・入力契約・headlessブラウザーの回帰を検証します。`Released runtime dependency gate` は未公開の `experimental` / `local-build:` 依存を拒否します。`scripts/build-candidate-wandas.py` は実験版lock専用で、現在の公開版runtimeの準備には使用しません。
