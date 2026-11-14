import { M5Equalizer } from './m5-eq.js';

export const RATE = 48_000;
const MAX_SECONDS = 60 * 120;
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
      let validBits = bits;
      if (format === 0xfffe) {
        if (size < 40 || v.getUint16(16, true) < 22 || 18 + v.getUint16(16, true) > size) invalid();
        format = v.getUint16(24, true);
        const guidTail = [0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113];
        if (!guidTail.every((value, i) => bytes[26 + i] === value)) invalid();
        validBits = v.getUint16(18, true);
        const mask = v.getUint32(20, true);
        if (mask !== 0 && mask !== (channels === 2 ? 3 : 4)) invalid();
      }
      const supported = format === 1 && [8, 16, 24, 32].includes(bits)
        || format === 3 && [32, 64].includes(bits);
      if (!supported || ![1, 2].includes(channels)) {
        const encoding = format === 1 ? '整数PCM' : format === 3 ? 'float' : `形式コード 0x${format.toString(16)}`;
        const channelLabel = channels === 1 ? 'mono' : channels === 2 ? 'stereo' : `${channels}チャンネル`;
        const actual = `${sampleRate / 1000} kHz・${bits}-bit ${encoding}・${channelLabel}`;
        throw Error(`このWAVは読み込めません。選択したファイル: ${actual}。モノラルまたはステレオの整数PCM・浮動小数点WAVを選択してください。`);
      }
      if (!sampleRate || validBits < 1 || validBits > bits || (format === 3 && validBits !== bits)
        || blockAlign !== channels * bits / 8 || byteRate !== sampleRate * blockAlign) invalid();
      fmt = { format, channels, sampleRate, blockAlign, bits, validBits };
    } else if (id === 'data') {
      if (!fmt || data || size === 0 || size % fmt.blockAlign !== 0) invalid();
      data = { offset: start, size, frames: size / fmt.blockAlign };
    }
    offset = next;
  }
  if (!fmt || !data) invalid();
  if (data.frames > fmt.sampleRate * MAX_SECONDS) throw Error('120分以内の録音を選択してください。');
  return { ...fmt, ...data };
}

async function readSamples(file, wav, start, end) {
  const bytes = await file.slice(wav.offset + start * wav.blockAlign, wav.offset + end * wav.blockAlign).arrayBuffer();
  if (bytes.byteLength !== (end - start) * wav.blockAlign) throw Error('音声の読み込みが途中で終了しました。');
  const view = new DataView(bytes), samples = new Float32Array((end - start) * wav.channels);
  const stride = wav.bits / 8;
  const readers = wav.format === 3
    ? { 32: offset => view.getFloat32(offset, true), 64: offset => view.getFloat64(offset, true) }
    : {
      8: offset => (view.getUint8(offset) - 128) / 128,
      16: offset => view.getInt16(offset, true) / 32768,
      24: offset => (view.getUint16(offset, true) + view.getInt8(offset + 2) * 65536) / 8388608,
      32: offset => view.getInt32(offset, true) / 2147483648,
    };
  const read = readers[wav.bits];
  for (let i = 0; i < samples.length; i++) samples[i] = read(i * stride);
  return samples;
}

// Keep the detector's 48 kHz timebase. Read with absolute positions so the
// same analysis frame has identical samples on either side of a chunk seam.
async function readAnalysisSamples(file, wav, start, end) {
  if (wav.sampleRate === RATE) return readSamples(file, wav, start, end);
  const ratio = wav.sampleRate / RATE, { channels } = wav;
  const first = Math.floor(start * ratio);
  const last = Math.min(wav.frames, Math.ceil(end * ratio) + 1);
  const input = await readSamples(file, wav, first, last);
  if (!input.every(Number.isFinite)) throw Error('audio contains a non-finite sample');
  const output = new Float32Array((end - start) * channels);
  for (let frame = start; frame < end; frame++) {
    const position = frame * ratio;
    const left = Math.floor(position);
    const index = (frame - start) * channels;
    if (ratio <= 1) {
      const fraction = position - left;
      const a = (left - first) * channels, b = Math.min(a + channels, input.length - channels);
      for (let ch = 0; ch < channels; ch++) output[index + ch] = input[a + ch] * (1 - fraction) + input[b + ch] * fraction;
    } else {
      const right = Math.min(wav.frames, (frame + 1) * ratio);
      for (let ch = 0; ch < channels; ch++) {
        let sum = 0;
        for (let src = left; src < right; src++) {
          const weight = Math.min(right, src + 1) - Math.max(position, src);
          sum += input[(src - first) * channels + ch] * weight;
        }
        output[index + ch] = sum / (right - position);
      }
    }
  }
  return output;
}

export async function analyzeAudio(file, wav, wasm, progress = () => {}) {
  const parts = [];
  let length = 0;
  const frames = Math.max(1, Math.round(wav.frames * RATE / wav.sampleRate));
  const chunkFrames = HOP * Math.max(1, Math.floor(CHUNK_FRAMES / (HOP * Math.max(1, wav.sampleRate / RATE))));
  for (let start = 0; start < frames; start += chunkFrames) {
    const end = Math.min(frames, start + chunkFrames);
    const sourceStart = Math.max(0, start - HOP);
    const sourceEnd = Math.min(frames, end + WINDOW + HOP);
    const samples = await readAnalysisSamples(file, wav, sourceStart, sourceEnd);
    const features = wasm.analyze_features(samples, wav.channels, sourceStart, start, end);
    parts.push(features); length += features.byteLength;
    progress({ phase: 'analyze', fraction: end / frames * 0.9 });
  }
  const packed = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { packed.set(part, offset); offset += part.length; }
  const report = JSON.parse(wasm.finish_analysis(wav.channels, frames, packed));
  if (wav.sampleRate !== RATE) {
    const toSourceFrame = frame => Math.min(wav.frames, Math.round(frame * wav.sampleRate / RATE));
    for (const key of ['start_frame', 'end_frame']) {
      if (report[key] != null) report[key] = report[key] === frames ? wav.frames : toSourceFrame(report[key]);
    }
    for (const key of ['music_start', 'last_music_end', 'tail_end', 'final_applause_start']) {
      if (report[key]) report[key].frame = toSourceFrame(report[key].frame);
    }
    for (const gap of report.possible_breaks) {
      gap.start_frame = toSourceFrame(gap.start_frame);
      gap.end_frame = toSourceFrame(gap.end_frame);
    }
    report.sample_rate = wav.sampleRate;
    report.total_frames = wav.frames;
  }
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

export function wavHeader(frames, channels, sampleRate = RATE) {
  const bytes = new Uint8Array(56), view = new DataView(bytes.buffer);
  const text = (offset, value) => { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i); };
  const size = frames * channels * 4;
  text(0, 'RIFF'); view.setUint32(4, 48 + size, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 3, true); view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * channels * 4, true);
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
  if (plan.eq !== undefined && !['none', 'rode-m5'].includes(plan.eq)) throw Error('マイク補正の設定が不正です。');
}

async function* processingChunks(file, wav, plan) {
  const equalizer = plan.eq === 'rode-m5' ? new M5Equalizer(wav.channels, wav.sampleRate) : undefined;
  // Prime from the original preceding audio, excluding this context from output
  // and peak measurement. Both passes use identical initial filter state.
  if (equalizer && plan.startFrame > 0) {
    const contextStart = Math.max(0, plan.startFrame - Math.min(CHUNK_FRAMES, Math.floor(wav.sampleRate / 2)));
    equalizer.process(await readSamples(file, wav, contextStart, plan.startFrame));
  }
  for (let start = plan.startFrame; start < plan.endFrame; start += CHUNK_FRAMES) {
    const end = Math.min(plan.endFrame, start + CHUNK_FRAMES);
    const samples = await readSamples(file, wav, start, end);
    yield { end, samples: equalizer ? equalizer.process(samples) : samples };
  }
}

// Preview and export use the same peak measurement and linked-channel gain.
export async function measureNormalization(file, wav, plan, wasm, progress = () => {}) {
  validatePlan(wav, plan);
  const { startFrame, endFrame, normalize, targetDb } = plan;
  let peak = 0;
  if (normalize) for await (const { end, samples } of processingChunks(file, wav, plan)) {
    peak = Math.max(peak, wasm.measure_chunk_peak(samples));
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
  const outputSize = 56 + frames * wav.channels * 4;
  if (outputSize - 8 > 0xffffffff || wav.sampleRate * wav.channels * 4 > 0xffffffff) {
    throw Error('書き出す区間がRIFF/WAVの上限（約4 GiB）を超えています。短い区間を選択してください。');
  }
  if (!sink && outputSize > BLOB_LIMIT) {
    throw Error('このブラウザでは大きなWAVの保存に対応していません。Chrome / Edge等のローカル一時保存対応ブラウザを使用するか、256 MiB以下の区間を選択してください。');
  }
  const { gain } = await measureNormalization(file, wav, plan, wasm,
    value => progress({ ...value, fraction: value.fraction * 0.45 }));
  const pieces = [];
  const write = async bytes => { if (sink) await sink.write(bytes); else pieces.push(bytes); };
  await write(wavHeader(frames, wav.channels, wav.sampleRate));
  for await (const { end, samples } of processingChunks(file, wav, plan)) {
    const output = wasm.apply_gain(samples, gain);
    const bytes = new Uint8Array(output.byteLength), view = new DataView(bytes.buffer);
    for (let i = 0; i < output.length; i++) view.setFloat32(i * 4, output[i], true);
    await write(bytes);
    progress({ phase: 'render', fraction: 0.5 + (end - startFrame) / frames * 0.5 });
  }
  return { frames, gain, blob: sink ? undefined : new Blob(pieces, { type: 'audio/wav' }) };
}
