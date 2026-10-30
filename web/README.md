# 余韻 Web / Client WASM

音声の解析・切り出し・ノーマライズを、ブラウザのWeb Worker内のRust/WASMで実行します。録音はアップロードしません。CloudflareはHTML・JavaScript・WASMの静的配信だけに使い、Workers Paid、R2、Rustバックエンド、Tunnelは不要です。

既存の波形表示、開始・終了の調整、原音の試聴を維持しています。トリミング位置の可視化の強化とRØDE M5補正EQは、別工程の [TODO](../docs/TODO.md) に記載しており、今回は実装していません。

## ビルドと起動

Node.js 22以降と [rustup](https://rustup.rs/) を使用します。RustとWASMターゲットは `rust-toolchain.toml` で固定し、`wasm-bindgen-cli` は `Cargo.lock` と同じバージョンをビルドスクリプトが `.build-tools/` へ導入します。

```sh
npm --prefix web ci
npm --prefix web run dev
```

`predev` でブラウザ用のWASMを生成します。`http://localhost:8787` を開いてください。HTTPSまたはlocalhostで使用します。`file://` ではES ModulesやWeb Workerを読み込めません。Windowsでもshの導入は不要です。

単独で生成する場合は `npm --prefix web run build:wasm` を実行します。出力先は `web/public/wasm/` で、`wasm-bindgen --target web` のローダーをWeb Workerから初期化します。

## ファイルと保存

- 対応形式: RIFF/WAVE、48 kHz、IEEE float32、mono/stereo。IEEE_FLOATのWAVE_FORMAT_EXTENSIBLEも対応。
- 設計上限: 120分。端末の性能・空き容量によって利用できる長さは変わります。
- 原本は `File.slice()` で30秒単位に読み、録音全体をPCM配列へ展開しません。
- 出力は選択範囲の48 kHz float32 WAV。fmt/fact/dataチャンクを生成します。
- ノーマライズ時は選択範囲全体のピークを計測し、左右共通のゲイン（増幅上限24 dB）を適用します。EQや新たなフェード処理は追加していません。
- 対応ブラウザでは出力をOrigin Private File System（OPFS）の `yoin-exports` に小分けに書き、ダウンロードします。原本へ書き込みません。
- 一時出力は大きなファイルのダウンロードを中断しないよう保持します。24時間を超えた一時出力は、次回の解析・書き出し時に削除します。ブラウザのサイトデータ削除でも消せます。
- OPFSを利用できないブラウザではBlobへ出力します。この場合はメモリ消費を抑えるため、出力を256 MiB以下に制限します。
- 容量不足や処理エラーの場合は未完成の一時出力を破棄します。保存先はブラウザのダウンロード設定に従います。

試聴は元ファイルをブラウザの音声プレイヤーで再生します。float32 WAVの再生に対応していない環境では試聴が失敗する場合があります。解析・書き出しとは別のブラウザ機能です。

解析後は波形上のオレンジの線とシークバーで再生位置を確認できます。波形のクリック・ドラッグ、またはシークバー（キーボード操作にも対応）で再生位置を移動します。緑の開始・終了線をドラッグすると切り出し範囲を調整できます。試聴中のボタンをもう一度押すか「停止」で再生を止め、「再生」で現在位置から再開します。

## Cloudflare公式GitHub連携

初回接続から公開後の確認、手動デプロイ、トラブル対応までの手順は [Cloudflareデプロイ手順](../docs/cloudflare-deploy.md) を参照してください。

| 設定 | 値 |
| --- | --- |
| Root directory | `web` |
| Build command | `npm run build:wasm` |
| Deploy command | `npx wrangler deploy` |
| Build variable | `NODE_VERSION=22` |
| Build watch paths | 初回は全体を対象にする。絞る場合も `web/**`, `crates/**`, `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml` を含める |

依存パッケージの自動インストールは有効にします。Rustの共有クレートを参照するため、リポジトリ全体をチェックアウトする必要があります。Linuxにrustupがなければビルドスクリプトがチェックアウト内へ導入します。

ローカルの `npm run deploy` も `predeploy` でWASMを生成します。Git連携では二重ビルドを避けるため上表のDeploy commandを使用します。Wrangler設定にはサーバーのエントリーポイントやR2バインディング、cron、Paid専用のCPU設定はありません。

公式資料: [静的アセットの配信](https://developers.cloudflare.com/workers/static-assets/get-started/)、[静的配信の料金と制限](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)。

## 検証

```sh
cargo test --workspace --locked
npm --prefix web run build:wasm
npm --prefix web run typecheck
npm --prefix web run test:ci
npm --prefix web exec -- playwright install chromium
npm --prefix web run test:browser
npm --prefix web run benchmark:wasm
npm --prefix web run check:deploy
```

ブラウザテストはWranglerをローカル起動し、実際のWeb WorkerとWASMで解析・ダウンロードします。インストール済みEdgeを使う場合は環境変数 `PLAYWRIGHT_CHANNEL=msedge` を設定できます。GitHub Actionsでもテスト・バンドル検証を実行し、デプロイは行いません。

`benchmark:wasm` はNode上で同じブラウザ用WASMを測定します。時間・メモリは端末によって異なり、実録音の判定精度やモバイル端末での最大ファイル長を保証するものではありません。
