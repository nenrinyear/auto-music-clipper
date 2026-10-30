# 余韻 Web / Client WASM

音声の解析・切り出し・ノーマライズを、ブラウザのWeb Worker内のRust/WASMで実行します。録音はアップロードしません。CloudflareはHTML・JavaScript・WASMの静的配信だけに使い、Workers Paid、R2、Rustバックエンド、Tunnelは不要です。

波形表示、検出候補と保存境界の可視化、開始・終了の調整、ノーマライズを反映した試聴に対応しています。RØDE M5補正EQは、次の工程として [TODO](../docs/TODO.md) に記載しています。

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

試聴は元ファイルをブラウザの音声プレイヤーで再生し、Web Audioの一つのGainNodeで左右共通のゲインを適用します。ノーマライズが有効なら、最初の試聴前に選択範囲を30秒単位でピーク測定し、書き出しと同じ計算（ピーク上限・増幅上限24 dB）を使用します。録音全体の展開や試聴用WAVの生成は行いません。範囲・ノーマライズ・ピーク上限を変更すると試聴を停止し、次の再生で設定を反映します。ノーマライズをオフにすると原音の音量です。float32 WAVの再生やWeb Audioに対応していない環境では試聴が失敗する場合があります。

解析後は波形上のオレンジの線とシークバーで再生位置を確認できます。波形のクリック・ドラッグ、またはシークバー（キーボード操作にも対応）で再生位置を移動します。緑の開始・終了線をドラッグすると切り出し範囲を調整できます。再生操作と停止操作は分離し、「停止」で再生を止め、「再生」で現在位置から再開します。

波形の＋／−で時間軸を拡大・縮小できます。「選択範囲」「開始付近」「終了付近」で編集箇所へ移動し、「表示位置」のスライダーで拡大中の区間を横に動かします。「全体」で全体表示に戻ります。表示区間は最小0.1秒まで拡大でき、その区間だけを別Workerで読み直して左右どちらのピークも保持します。表示の拡大や移動は切り出し範囲・再生位置・ノーマライズのゲインを変更しません。

拍手などの大きなピークをトリミング範囲から外した場合、次の試聴・書き出しで残す区間のピークからゲインを再計算します。以前のノーマライズを重ね掛けせず、元音声に対して左右共通のゲインを一度適用します。再計算の状態と適用ゲインは、ピーク上限の下に表示します。

演奏開始・余韻終了・拍手開始の候補は点線で示し、確度と時刻を併記します。未検出の候補は未検出と表示し、候補ボタンで該当箇所を拡大できます。明るい区間が保存、暗い区間がカット対象です。緑の実線は保存境界で、手動調整後も元の自動境界を残します。「自動検出の範囲に戻す」で復元できます。候補の時刻と、前後の余白・拍手回避を含む自動保存境界は異なる場合があります。

境界は48 kHzの整数サンプル位置に丸め、波形・選択範囲の時刻と長さ・試聴用ゲインの計測範囲・書き出しに共通で使います。終了位置のサンプルは含みません。楽章間候補は参考表示であり、範囲内の無音や楽章を削除しません。

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
