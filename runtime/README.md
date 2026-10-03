# Audio runtime

`lock.json` は音声解析で使う Wandas / Pyodide とその依存ファイルの固定バージョンおよびハッシュを記録します。

準備には Python 3 が必要です。

```sh
python3 scripts/prepare-audio-runtime.py
python3 scripts/prepare-audio-runtime.py --check
```

準備済みファイルは `runtime/prepared/runtime/audio/` に生成され、Git管理しません。静的配布では、このディレクトリをアプリケーションと同じリリースに含めてください。

生成物には上流コンポーネントのライセンス条件が適用されます。配布前に、固定された依存関係と同梱されるライセンス通知を確認してください。

## 未公開APIを使うローカル試作

現在のlockは `experimental: true` です。公開版Wandas 0.8.0だけでは、この試作の `inspect` / `frame_center_times` APIを満たしません。公開用runtimeとして扱わないでください。

`upstreamCommit` と一致するWandasのclean checkoutとuvを用意し、以下の順で準備します。ビルドは一時ディレクトリで行い、元のcheckoutを変更しません。hatchlingを固定し、生成wheelのSHA-256とサイズがlockに一致した場合だけ配置します。

```sh
python3 scripts/build-candidate-wandas.py --source /path/to/wandas-checkout
python3 scripts/prepare-audio-runtime.py
python3 scripts/prepare-audio-runtime.py --check
npm ci
npm run test:audio
npm run test:inputs
CI=1 npm run e2e
```

公開への依存順序は、WandasのAPI変更を検証・マージし、別途承認された正式リリースを公開した後、Insightのlockを公開wheelのURL・バージョン・ハッシュに更新して再検証することです。このローカル試作はリリースやデプロイを行いません。
