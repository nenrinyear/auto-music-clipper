# 余韻 Web / Cloudflare Workers

ブラウザで録音 WAV をプレビューし、ユーザーが **解析を開始** した後に Cloudflare へ 8 MiB ごとに送信します。Worker が R2 上の音声を 30 秒単位で読み込み、Rust/WASM で解析した候補を返します。ブラウザ上で開始・終了位置を調整し、書き出し時は Worker の Rust/WASM が選択範囲を処理して float32 WAV をストリーミングします。ノーマライズは全区間のピークを測ってから、左右チャンネルに共通のゲインを適用します。

ブラウザが処理区間ごとに Worker API を呼ぶため、長時間の処理を一回の Worker invocation に閉じ込めません。中間データと出力は一時的に R2 に保存し、毎時の cron が24時間を超えた job オブジェクトを削除します。ページには Cloudflare への送信と一時保管を開始前に表示します。Worker API と R2 は現状認証なしなので、一般公開前に Turnstile などのアクセス制御を追加してください。

## Requirements

- Cloudflare Workers Paid: この Worker は invocation あたり最大 300,000 ms の CPU limit を要求します。
- R2 bucket `yoin-audio-tmp` (デプロイ時に Cloudflare connector で作成・接続)。
- Rust target `wasm32-unknown-unknown`。
- WASM glue generator `wasm-bindgen-cli` version `0.2.129`。

## Local development

```sh
npm --prefix web install
npm --prefix web run dev
```

`predev` が Worker 用 WASM glue をビルドします。Wrangler local mode は R2 をローカルシミュレーションします。単独で WASM を作り直す場合は `npm --prefix web run build:wasm` を実行します。生成物は `web/src/wasm` に置き、Worker bundle から import します。ブラウザでは WASM を実行しません。

対応音声は RIFF/WAVE、mono/stereo、48 kHz IEEE float32、最大120分です。解析・ピーク測定・書き出しは30秒単位で実行します。実録音で処理時間と上限を測定してください。

デプロイはここでは実行しません。R2 bucket の作成・接続とデプロイは Cloudflare connector から行います。
