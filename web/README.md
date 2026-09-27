# 余韻 web

Cloudflare Worker hosts the static editing page and a lightweight `/api/health` endpoint. Audio stays in the browser: the page reads 48 kHz IEEE float32 WAV chunks, passes them to the Rust/WASM analyzer, and exports a trimmed WAV without uploading the recording.

## Local development

1. Install the matching WASM glue generator once: `cargo install wasm-bindgen-cli --version 0.2.129`
2. Build the browser module from the repository root: `npm --prefix web run build:wasm`
3. Start the Worker: `npm --prefix web run dev`

Open the Wrangler URL (normally `http://localhost:8787`). The browser editor currently supports mono/stereo 48 kHz, 32-bit IEEE float WAV input and limits assembled browser exports to 512 MiB. The app does not upload audio or persist recordings.

Deploy is intentionally not part of the local workflow; use the Cloudflare connector when ready.
