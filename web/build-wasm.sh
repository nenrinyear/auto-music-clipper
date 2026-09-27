#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
OUT="$ROOT/web/src/wasm"
if ! command -v wasm-bindgen >/dev/null 2>&1; then
  echo "wasm-bindgen CLI is required. Install it with: cargo install wasm-bindgen-cli --version 0.2.129" >&2
  exit 1
fi
cd "$ROOT"
cargo build --release -p audio-wasm --target wasm32-unknown-unknown
mkdir -p "$OUT"
wasm-bindgen --target bundler --out-dir "$OUT" --out-name audio_wasm "$ROOT/target/wasm32-unknown-unknown/release/audio_wasm.wasm"
