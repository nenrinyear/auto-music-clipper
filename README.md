# Auto Music Clipper

吹奏楽・アンサンブルの録音から演奏範囲を推定し、前後を整えて保存するツールです。ブラウザで使うWeb版と、コマンドラインで使うCLI版があります。

## 入力形式

| | チャンネル | サンプリングレート | WAVのサンプル形式 |
| --- | --- | --- | --- |
| Web版 | モノラル／ステレオ | 48 kHz固定の制限なし | 整数PCM（8・16・24・32 bit）とIEEE浮動小数点（32・64 bit） |
| CLI版 | モノラル／ステレオ | 48 kHz | 32-bit float |

Web版はRIFF/WAVE形式で120分まで読み込めます。自動検出には48 kHzに変換した音声を使い、書き出しは元のサンプリングレートの32-bit float WAVです。詳細は [Web版の入力と保存](web/README.md#ファイルと保存) を参照してください。

## Build

```sh
cargo build --workspace
cargo test --workspace
cargo check -p audio-wasm --target wasm32-unknown-unknown
```

WASMターゲットがない場合は `rustup target add wasm32-unknown-unknown` で追加できます。

## CLI

```sh
# WAVの解析。JSONをファイルにも保存する。
cargo run -p audio-cli -- analyze recording.wav --report analysis.json

# 自動判定がreadyの場合だけ自動で書き出す。要確認の場合も解析JSONを保存する。
cargo run -p audio-cli -- auto recording.wav --out recording.trimmed.wav

# 解析結果を聴いて秒単位で境界を指定して書き出す。
cargo run -p audio-cli -- trim recording.wav \
  --start 12.3 --end 184.5 --out recording.trimmed.wav

# ノーマライズをしない場合。
cargo run -p audio-cli -- trim recording.wav \
  --start 12.3 --end 184.5 --normalize false --out recording.trimmed.wav
```

自動判定はヒューリスティックの初期版です。拍手と打楽器、弱い楽章、余韻が重なるケースは要確認になります。`trim` は手動指定した区間を切り出し、左右共通ゲインと短いフェードを適用します。

## Workspace

- `crates/audio-core`: チャンク単位の特徴抽出、候補判定、フェードと共通ゲイン。
- `crates/audio-cli`: WAVファイルの解析と書き出し。
- `crates/audio-wasm`: ブラウザ内で解析・ピーク測定・ゲイン適用を行うWASM API。
- `web`: 音声をアップロードせず、Web Worker内のRust/WASMで解析・書き出しする画面。

ブラウザが端末内のWAVを分割して読み、Rust/WASMで解析します。画面で境界を調整後、左右共通ゲインを適用してWAVをダウンロードします。Cloudflareは静的配信のみで、Workers PaidやR2は不要です。起動とGitHub連携の設定は [web/README.md](web/README.md) を参照してください。

作業は [TODO](docs/TODO.md) の順に進めます。Client WASMへの移行、トリミング位置の可視化、[RØDE M5公称特性の補正EQ](docs/m5-eq.md)まで実装済みです。実録音での拍手検出の改善とEQ試聴・書き出しの一致も[検証済み](docs/verification-real-recording.md)です。移行前のサーバー処理版には `worker-wasm-before-client` タグを付けています。

設計の詳細は [`docs/spec.md`](docs/spec.md) を参照してください。

公開方法は [Cloudflareデプロイ手順](docs/cloudflare-deploy.md) にまとめています。
