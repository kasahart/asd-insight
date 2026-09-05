# Audio runtime

`lock.json` は音声解析で使う Wandas / Pyodide とその依存ファイルの固定バージョンおよびハッシュを記録します。

準備には Python 3 が必要です。

```sh
python3 scripts/prepare-audio-runtime.py
python3 scripts/prepare-audio-runtime.py --check
```

準備済みファイルは `runtime/prepared/runtime/audio/` に生成され、Git管理しません。静的配布では、このディレクトリをアプリケーションと同じリリースに含めてください。

生成物には上流コンポーネントのライセンス条件が適用されます。配布前に、固定された依存関係と同梱されるライセンス通知を確認してください。
