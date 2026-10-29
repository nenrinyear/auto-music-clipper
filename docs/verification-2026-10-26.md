# Workers / Rust WASM 検証記録

> 移行前のWorker側WASM構成の記録です。現在のクライアントWASM構成については [web/README.md](../web/README.md) を参照してください。

2026-10-26、Windows上のNode.js 24.22.1、Rust 1.98.1、wasm-bindgen 0.2.129で検証。

## 確認できたこと

- `cargo test --workspace --locked`: 音声コアの6テスト成功。
- `npm run build:wasm`: WASMターゲットとCLIの初回導入を含む生成に成功。
- `npm run typecheck`: Worker本体とテストの型チェックに成功。
- `npm run test:ci`: Worker実行環境内の3テスト成功。
- `npm run check:deploy`: デプロイ前のバンドル生成に成功。アップロード前サイズ438.72 KiB、gzip 147.38 KiB。

統合テストでは31秒・48 kHz float32ステレオの合成音声を使用。8 MiB境界をまたぐアップロード、30秒境界をまたぐ解析、開始と終了の手動指定、ピーク計測、左右共通ゲイン、WAVダウンロードを通して実行した。出力長、出力サンプルと入力サンプル×ゲインの一致、左右比、-1 dBFSのピークを確認。

## Node上で実行したWASMの参考測定

`npm run benchmark:wasm` の1回の結果。同じWASMインスタンスで以下を順に実行した。

| 処理 | 経過時間 | 処理後のWASM線形メモリ |
| --- | ---: | ---: |
| 30秒ステレオの特徴抽出 | 258 ms | 12.44 MiB |
| 120分相当の合成特徴タイムラインの集約 | 58 ms | 45.44 MiB |
| 30秒ステレオのピーク計測・ゲイン適用・出力ピーク確認 | 60 ms | 45.44 MiB |

120分の集約では720,000件、17,280,000 bytesの特徴データを渡し、全体のフレーム数を保持した演奏候補を取得。120分のPCM音声全体を解析した測定ではない。

## 未検証

- Cloudflare Workers Builds上のLinuxでの初回rustup導入と実ビルド。
- CloudflareへのGitHub接続、R2作成、本番デプロイ。
- 本番WorkerのCPU時間、JavaScript/R2バッファも含む総メモリ、同時リクエスト時の挙動。
- 実録音の境界判定精度、120分の録音全体をアップロードして処理する試験。

WASM線形メモリの測定はWorker全体の128 MB制限内で動く保証にはならない。実録音で本番の計測をしてから処理区間長と同時実行数を確定する。
