export const RATE = 48_000;
const MAX_FRAMES = RATE * 60 * 120;
const CHUNK_FRAMES = RATE * 30;
const HOP = 480;
const WINDOW = 2048;
const FEATURE_BYTES = 24;
export const BLOB_LIMIT = 256 * 1024 * 1024;

const tag = (bytes, offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));

export async function parseWav(file) {
  const invalid = () => { throw Error('WAVのチャンク情報が不正です。'); };
  const riff = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (riff.length !== 12 || tag(riff, 0) !== 'RIFF' || tag(riff, 8) !== 'WAVE') {
    throw Error('RIFF/WAVE形式のファイルではありません。');
  }
  if (new DataView(riff.buffer).getUint32(4, true) + 8 !== file.size) invalid();
  let fmt, data;
  for (let offset = 12; offset < file.size;) {
    if (offset + 8 > file.size) invalid();
    const header = new Uint8Array(await file.slice(offset, offset + 8).arrayBuffer());
    const size = new DataView(header.buffer).getUint32(4, true);
    const start = offset + 8, next = start + size + (size & 1);
    if (next > file.size) invalid();
    const id = tag(header, 0);
    if (id === 'fmt ') {
      if (fmt || data || size < 16) invalid();
      const bytes = new Uint8Array(await file.slice(start, start + Math.min(size, 40)).arrayBuffer());
      const v = new DataView(bytes.buffer);
      let format = v.getUint16(0, true);
      const channels = v.getUint16(2, true), sampleRate = v.getUint32(4, true);
      const byteRate = v.getUint32(8, true), blockAlign = v.getUint16(12, true), bits = v.getUint16(14, true);
      if (format === 0xfffe) {
        if (size < 40 || v.getUint16(16, true) < 22 || 18 + v.getUint16(16, true) > size) invalid();
        const guid = [3, 0, 0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113];
        if (!guid.every((value, i) => bytes[24 + i] === value) || v.getUint16(18, true) !== 32) invalid();
        const mask = v.getUint32(20, true);
        if (mask !== 0 && mask !== (channels === 2 ? 3 : 4)) invalid();
        format = 3;
      }
      if (format !== 3 || sampleRate !== RATE || bits !== 32 || ![1, 2].includes(channels)) {
        const encoding = format === 1 ? '整数PCM' : format === 3 ? 'float' : `形式コード 0x${format.toString(16)}`;
        const channelLabel = channels === 1 ? 'mono' : channels === 2 ? 'stereo' : `${channels}チャンネル`;
        const actual = `${sampleRate / 1000} kHz・${bits}-bit ${encoding}・${channelLabel}`;
        throw Error(`このWAVは読み込めません。選択したファイル: ${actual}。対応形式: 48 kHz・32-bit float・mono / stereo。音声編集ソフトで対応形式のWAVに書き出してから、選び直してください。32-bit整数PCMは32-bit floatとは異なります。`);
      }
      if (blockAlign !== channels * 4 || byteRate !== sampleRate * blockAlign) invalid();
      fmt = { format, channels, sampleRate, blockAlign, bits };
    } else if (id === 'data') {
      if (!fmt || data || size === 0 || size % fmt.blockAlign !== 0) invalid();
      data = { offset: start, size, frames: size / fmt.blockAlign };
    }
    offset = next;
  }
  if (!fmt || !data) invalid();
  if (data.frames > MAX_FRAMES) throw Error('120分以内の録音を選択してください。');
  return { ...fmt, ...data };
}

async function readSamples(file, wav, start, end) {
  const bytes = await file.slice(wav.offset + start * wav.blockAlign, wav.offset + end * wav.blockAlign).arrayBuffer();
  if (bytes.byteLength !== (end - start) * wav.blockAlign) throw Error('音声の読み込みが途中で終了しました。');
  const view = new DataView(bytes), samples = new Float32Array(bytes.byteLength / 4);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getFloat32(i * 4, true);
  return samples;
}

export async function analyzeAudio(file, wav, wasm, progress = () => {}) {
  const parts = [];
  let length = 0;
  for (let start = 0; start < wav.frames; start += CHUNK_FRAMES) {
    const end = Math.min(wav.frames, start + CHUNK_FRAMES);
    const sourceStart = Math.max(0, start - HOP);
    const sourceEnd = Math.min(wav.frames, end + WINDOW + HOP);
    const samples = await readSamples(file, wav, sourceStart, sourceEnd);
    const features = wasm.analyze_features(samples, wav.channels, sourceStart, start, end);
    parts.push(features); length += features.byteLength;
    progress({ phase: 'analyze', fraction: end / wav.frames * 0.9 });
  }
  const packed = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { packed.set(part, offset); offset += part.length; }
  const report = JSON.parse(wasm.finish_analysis(wav.channels, wav.frames, packed));
  const waveform = new Array(1400).fill(0), view = new DataView(packed.buffer);
  const count = packed.length / FEATURE_BYTES;
  for (let i = 0; i < count; i++) {
    const bin = Math.min(1399, Math.floor(i * 1400 / count));
    waveform[bin] = Math.max(waveform[bin], Math.abs(view.getFloat32(i * FEATURE_BYTES + 12, true)));
  }
  progress({ phase: 'analyze', fraction: 1 });
  return { ...report, waveform };
}

// Read only the visible interval. Preserve peaks from either channel when zooming.
export async function readWaveform(file, wav, { startFrame, endFrame, bins = 1200 }) {
  if (!Number.isSafeInteger(startFrame) || !Number.isSafeInteger(endFrame) || startFrame < 0
    || endFrame > wav.frames || endFrame <= startFrame || !Number.isSafeInteger(bins) || bins < 1 || bins > 4096) {
    throw Error('波形の表示範囲が不正です。');
  }
  const peaks = new Float32Array(bins), frames = endFrame - startFrame;
  for (let start = startFrame; start < endFrame; start += CHUNK_FRAMES) {
    const end = Math.min(endFrame, start + CHUNK_FRAMES);
    const samples = await readSamples(file, wav, start, end);
    for (let frame = start; frame < end; frame++) {
      const bin = Math.min(bins - 1, Math.floor((frame - startFrame) * bins / frames));
      for (let channel = 0; channel < wav.channels; channel++) {
        const value = samples[(frame - start) * wav.channels + channel];
        if (!Number.isFinite(value)) throw Error('音声に不正なサンプル値が含まれています。');
        peaks[bin] = Math.max(peaks[bin], Math.abs(value));
      }
    }
  }
  return peaks;
}

export function wavHeader(frames, channels) {
  const bytes = new Uint8Array(56), view = new DataView(bytes.buffer);
  const text = (offset, value) => { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i); };
  const size = frames * channels * 4;
  text(0, 'RIFF'); view.setUint32(4, 48 + size, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 3, true); view.setUint16(22, channels, true);
  view.setUint32(24, RATE, true); view.setUint32(28, RATE * channels * 4, true);
  view.setUint16(32, channels * 4, true); view.setUint16(34, 32, true);
  text(36, 'fact'); view.setUint32(40, 4, true); view.setUint32(44, frames, true);
  text(48, 'data'); view.setUint32(52, size, true);
  return bytes;
}

function validatePlan(wav, plan) {
  const { startFrame, endFrame, normalize, targetDb } = plan;
  if (!Number.isSafeInteger(startFrame) || !Number.isSafeInteger(endFrame) || startFrame < 0
    || endFrame > wav.frames || endFrame <= startFrame || typeof normalize !== 'boolean'
    || !Number.isFinite(targetDb) || targetDb < -6 || targetDb > 0) throw Error('開始・終了位置とピーク上限を確認してください。');
}

// Preview and export use the same peak measurement and linked-channel gain.
export async function measureNormalization(file, wav, plan, wasm, progress = () => {}) {
  validatePlan(wav, plan);
  const { startFrame, endFrame, normalize, targetDb } = plan;
  let peak = 0;
  if (normalize) for (let start = startFrame; start < endFrame; start += CHUNK_FRAMES) {
    const end = Math.min(endFrame, start + CHUNK_FRAMES);
    peak = Math.max(peak, wasm.measure_chunk_peak(await readSamples(file, wav, start, end)));
    progress({ phase: 'measure', fraction: (end - startFrame) / (endFrame - startFrame) });
  }
  const gain = normalize && peak > 0 ? Math.min(10 ** (targetDb / 20) / peak, 10 ** (24 / 20)) : 1;
  return { peak, gain };
}

// A sink writes chunks to a temporary local file. Small-file Blob fallback is bounded.
export async function renderAudio(file, wav, plan, wasm, progress = () => {}, sink) {
  validatePlan(wav, plan);
  const { startFrame, endFrame } = plan;
  const frames = endFrame - startFrame;
  if (!sink && 56 + frames * wav.blockAlign > BLOB_LIMIT) {
    throw Error('このブラウザでは大きなWAVの保存に対応していません。Chrome / Edge等のローカル一時保存対応ブラウザを使用するか、256 MiB以下の区間を選択してください。');
  }
  const { gain } = await measureNormalization(file, wav, plan, wasm,
    value => progress({ ...value, fraction: value.fraction * 0.45 }));
  const pieces = [];
  const write = async bytes => { if (sink) await sink.write(bytes); else pieces.push(bytes); };
  await write(wavHeader(frames, wav.channels));
  for (let start = startFrame; start < endFrame; start += CHUNK_FRAMES) {
    const end = Math.min(endFrame, start + CHUNK_FRAMES);
    const output = wasm.apply_gain(await readSamples(file, wav, start, end), gain);
    const bytes = new Uint8Array(output.byteLength), view = new DataView(bytes.buffer);
    for (let i = 0; i < output.length; i++) view.setFloat32(i * 4, output[i], true);
    await write(bytes);
    progress({ phase: 'render', fraction: 0.5 + (end - startFrame) / frames * 0.5 });
  }
  return { frames, gain, blob: sink ? undefined : new Blob(pieces, { type: 'audio/wav' }) };
}
