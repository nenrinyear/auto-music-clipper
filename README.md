# Auto Music Clipper

吹奏楽・アンサンブルの録音から演奏範囲を推定し、前後を整えて保存するRustの試作です。入力は48 kHz・32 bit float WAV、モノラルまたはステレオを想定しています。

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

ブラウザが端末内のWAVを30秒ずつ読み、Rust/WASMで解析します。画面で境界を調整後、左右共通ゲインを適用してWAVをダウンロードします。Cloudflareは静的配信のみで、Workers PaidやR2は不要です。起動とGitHub連携の設定は [web/README.md](web/README.md) を参照してください。

作業は [TODO](docs/TODO.md) の順に進めます。今回はClient WASMへの移行のみで、トリミング位置の可視化の強化とRØDE M5補正EQは別の変更に分けます。移行前のサーバー処理版には `worker-wasm-before-client` タグを付けています。

設計の詳細は [`docs/spec.md`](docs/spec.md) を参照してください。

公開方法は [Cloudflareデプロイ手順](docs/cloudflare-deploy.md) にまとめています。
