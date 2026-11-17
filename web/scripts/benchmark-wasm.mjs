// Node-hosted WASM measurements: useful for sizing, not production Worker CPU/RSS.
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import * as bindings from "../src/wasm/audio_wasm.js";

const exports = bindings.initSync({ module: readFileSync(new URL("../src/wasm/audio_wasm_bg.wasm", import.meta.url)) });

function measure(name, run) {
  const started = performance.now();
  const result = run();
  console.log(JSON.stringify({ name, milliseconds: Math.round(performance.now() - started),
    wasmMemoryMiB: +(exports.memory.buffer.byteLength / 1024 ** 2).toFixed(2), ...result }));
}

const rate = 48_000;
measure("analyze-30s-stereo", () => {
  // Include the same right-hand context as a non-final Worker segment.
  const samples = new Float32Array((rate * 30 + 2048 + 480) * 2);
  for (let i = 0; i < samples.length / 2; i++) {
    samples[i * 2] = Math.sin(2 * Math.PI * 440 * i / rate) * 0.25;
    samples[i * 2 + 1] = samples[i * 2] * 0.5;
  }
  const features = bindings.analyze_features(samples, 2, 0, 0, rate * 30);
  return { inputMiB: +(samples.byteLength / 1024 ** 2).toFixed(2), featureBytes: features.byteLength };
});

measure("finish-120min-feature-timeline", () => {
  const count = 120 * 60 * 100;
  const packed = new Uint8Array(count * 24);
  const view = new DataView(packed.buffer);
  for (let i = 0; i < count; i++) {
    view.setBigUint64(i * 24, BigInt(i * 480 + 1024), true);
    const active = i >= count * 0.15 && i < count * 0.85;
    view.setFloat32(i * 24 + 8, active ? -20 : -90, true);
    view.setFloat32(i * 24 + 12, active ? 0.25 : 0, true);
    view.setFloat32(i * 24 + 16, 0.05, true);
    view.setFloat32(i * 24 + 20, 0, true);
  }
  const report = JSON.parse(bindings.finish_analysis(2, rate * 120 * 60, packed));
  if (report.total_frames !== rate * 120 * 60) throw new Error("Frame count changed");
  if (report.start_frame === null || report.end_frame === null) throw new Error("Expected a music candidate");
  return { featureBytes: packed.byteLength, status: report.status };
});

measure("gain-30s-stereo", () => {
  const samples = new Float32Array(rate * 30 * 2).fill(0.25);
  const peak = bindings.measure_chunk_peak(samples);
  const output = bindings.apply_gain(samples, 10 ** (-1 / 20) / peak);
  return { peak: bindings.measure_chunk_peak(output), outputBytes: output.byteLength };
});
