import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import * as wasm from '../public/wasm/audio_wasm.js';
import { parseWav, analyzeAudio, renderAudio, BLOB_LIMIT } from '../public/audio-processing.js';
import { makeWav, RATE } from './fixtures';

wasm.initSync({ module: readFileSync(new URL('../public/wasm/audio_wasm_bg.wasm', import.meta.url)) });
const fileOf = (bytes: Buffer) => new File([new Uint8Array(bytes)], 'recording.wav', { type: 'audio/wav' });

describe('client WASM audio processing', () => {
  it.each([
    { format: 1, bits: 24, rate: 48000, channels: 2, actual: '48 kHz・24-bit 整数PCM・stereo' },
    { format: 1, bits: 32, rate: 48000, channels: 1, actual: '48 kHz・32-bit 整数PCM・mono' },
    { format: 3, bits: 32, rate: 44100, channels: 2, actual: '44.1 kHz・32-bit float・stereo' },
    { format: 3, bits: 32, rate: 48000, channels: 6, actual: '48 kHz・32-bit float・6チャンネル' },
  ])('explains the detected unsupported format: $actual', async ({ format, bits, rate, channels, actual }) => {
    const bytes = makeWav(1);
    bytes.writeUInt16LE(format, 20); bytes.writeUInt16LE(channels, 22);
    bytes.writeUInt32LE(rate, 24); bytes.writeUInt16LE(bits, 34);
    await expect(parseWav(fileOf(bytes))).rejects.toThrow(actual);
    await expect(parseWav(fileOf(bytes))).rejects.toThrow('書き出してから、選び直してください');
  });

  it('analyzes across the 30-second seam and matches the continuous Rust analyzer', async () => {
    const bytes = makeWav(), file = fileOf(bytes), wav = await parseWav(file);
    const slice = vi.spyOn(file, 'slice');
    const report = await analyzeAudio(file, wav, wasm);
    const analyzer = new wasm.WasmAnalyzer(2);
    try {
      const samples = new Float32Array(wav.frames * 2);
      for (let i = 0; i < samples.length; i++) samples[i] = bytes.readFloatLE(44 + i * 4);
      analyzer.push(samples);
      const continuous = JSON.parse(analyzer.finish());
      const { waveform, ...chunked } = report;
      expect(chunked).toEqual(continuous);
      expect(waveform).toHaveLength(1400);
      expect(waveform.every(Number.isFinite)).toBe(true);
      expect(report.total_frames).toBe(RATE * 31);
      expect(slice.mock.calls.every(([start, end]) => Number(end) - Number(start) < 12_000_000)).toBe(true);
    } finally { analyzer.free(); }
  });

  it('exports both sides of a segment seam with one gain, exact bounds and valid float WAV', async () => {
    const bytes = makeWav(), file = fileOf(bytes), wav = await parseWav(file);
    const startFrame = 4800, endFrame = wav.frames - 4800;
    const result = await renderAudio(file, wav, { startFrame, endFrame, normalize: true, targetDb: -1 }, wasm);
    const output = Buffer.from(await result.blob!.arrayBuffer());
    const rendered = await parseWav(new Blob([output]));
    expect(rendered.frames).toBe(endFrame - startFrame);
    expect(rendered.channels).toBe(2);
    expect(rendered.offset).toBe(56);
    expect(output.subarray(36, 40).toString()).toBe('fact');
    expect(output.readUInt32LE(44)).toBe(rendered.frames);
    expect(result.gain).toBeCloseTo(10 ** (-1 / 20) / .25, 6);
    let peak = 0;
    for (let i = 0; i < rendered.frames; i++) {
      const left = output.readFloatLE(56 + i * 8), right = output.readFloatLE(60 + i * 8);
      peak = Math.max(peak, Math.abs(left));
      if (i % 997 === 0 || Math.abs(i - RATE * 30) < 3) {
        expect(left).toBeCloseTo(bytes.readFloatLE(44 + (i + startFrame) * 8) * result.gain, 6);
        expect(right).toBeCloseTo(left * .5, 6);
      }
    }
    expect(peak).toBeCloseTo(10 ** (-1 / 20), 6);
    // Re-export with another range/normalization option without a server job state.
    const second = await renderAudio(file, wav, { startFrame: RATE * 4, endFrame: RATE * 5, normalize: false, targetDb: -1 }, wasm);
    expect(Buffer.from(await second.blob!.arrayBuffer()).subarray(56)).toEqual(bytes.subarray(44 + RATE * 4 * 8, 44 + RATE * 5 * 8));
  });

  it('streams output to a sink, including silent mono without infinite gain', async () => {
    const file = fileOf(makeWav(1, 1)), wav = await parseWav(file);
    const chunks: Uint8Array[] = [];
    const result = await renderAudio(file, wav, { startFrame: 0, endFrame: wav.frames, normalize: true, targetDb: -1 }, wasm, undefined, {
      write: async (bytes: Uint8Array) => { chunks.push(bytes); },
    });
    expect(result.gain).toBe(1); expect(result.blob).toBeUndefined();
    expect(await parseWav(new Blob(chunks as BlobPart[]))).toMatchObject({ frames: RATE, channels: 1 });
    expect(chunks[1].every(value => value === 0)).toBe(true);
  });

  it('rejects damaged WAVs, non-finite PCM and invalid output ranges', async () => {
    const bytes = makeWav(1);
    const damaged = Buffer.from(bytes); damaged.writeUInt32LE(1, 4);
    await expect(parseWav(fileOf(damaged))).rejects.toThrow('チャンク');
    const wrongRate = Buffer.from(bytes); wrongRate.writeUInt32LE(44100, 24);
    await expect(parseWav(fileOf(wrongRate))).rejects.toThrow('48 kHz');
    bytes.writeFloatLE(NaN, 44);
    const file = fileOf(bytes), wav = await parseWav(file);
    await expect(analyzeAudio(file, wav, wasm)).rejects.toThrow('non-finite');
    await expect(renderAudio(file, wav, { startFrame: 0, endFrame: wav.frames, normalize: false, targetDb: -1 }, wasm)).rejects.toThrow('non-finite');
    await expect(renderAudio(file, wav, { startFrame: 20, endFrame: 10, normalize: true, targetDb: -1 }, wasm)).rejects.toThrow('開始');
  });

  it('rejects an oversized Blob fallback before reading audio', async () => {
    const slice = vi.fn();
    const frames = Math.ceil(BLOB_LIMIT / 8);
    await expect(renderAudio({ slice }, { frames, channels: 2, blockAlign: 8 }, { startFrame: 0, endFrame: frames, normalize: true, targetDb: -1 }, wasm)).rejects.toThrow('256 MiB');
    expect(slice).not.toHaveBeenCalled();
  });
});
