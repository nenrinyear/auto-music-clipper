import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import * as wasm from '../public/wasm/audio_wasm.js';
import { parseWav, analyzeAudio, readWaveform, renderAudio, measureNormalization, BLOB_LIMIT } from '../public/audio-processing.js';
import { makeWav, RATE } from './fixtures';

wasm.initSync({ module: readFileSync(new URL('../public/wasm/audio_wasm_bg.wasm', import.meta.url)) });
const fileOf = (bytes: Buffer) => new File([new Uint8Array(bytes)], 'recording.wav', { type: 'audio/wav' });

describe('client WASM audio processing', () => {
  it('uses the selected range and the louder channel for preview and export gain', async () => {
    const bytes = makeWav(1);
    // Outside the selected range: a higher peak must not affect normalization.
    bytes.writeFloatLE(1, 44);
    const startFrame = 100, endFrame = 200;
    bytes.writeFloatLE(.125, 44 + startFrame * 8);
    bytes.writeFloatLE(-.5, 48 + startFrame * 8);
    const file = fileOf(bytes), wav = await parseWav(file);
    const plan = { startFrame, endFrame, normalize: true, targetDb: -1 };
    const preview = await measureNormalization(file, wav, plan, wasm);
    const rendered = await renderAudio(file, wav, plan, wasm);
    expect(preview.peak).toBe(.5);
    expect(preview.gain).toBeCloseTo(10 ** (-1 / 20) / .5, 6);
    expect(preview.gain).toBe(rendered.gain);
    const output = Buffer.from(await rendered.blob!.arrayBuffer());
    expect(output.readFloatLE(56)).toBeCloseTo(.125 * preview.gain, 6);
    expect(output.readFloatLE(60)).toBeCloseTo(-.5 * preview.gain, 6);
    expect(output.readFloatLE(60) / output.readFloatLE(56)).toBeCloseTo(-4, 6);
    const noRead = vi.spyOn(file, 'slice');
    expect(await measureNormalization(file, wav, { ...plan, normalize: false }, wasm)).toMatchObject({ gain: 1 });
    expect(noRead).not.toHaveBeenCalled();
  });

  it('leaves silence unchanged and normalizes quiet samples to the requested peak', async () => {
    const bytes = makeWav(1, 1), file = fileOf(bytes), wav = await parseWav(file);
    const plan = { startFrame: 0, endFrame: wav.frames, normalize: true, targetDb: -1 };
    expect(await measureNormalization(file, wav, plan, wasm)).toEqual({ peak: 0, gain: 1 });
    bytes.writeFloatLE(.00001, 44);
    const quiet = fileOf(bytes);
    const measured = await measureNormalization(quiet, wav, plan, wasm);
    expect(measured.gain).toBeGreaterThan(10 ** (24 / 20));
    const rendered = await renderAudio(quiet, wav, plan, wasm);
    const output = Buffer.from(await rendered.blob!.arrayBuffer());
    expect(output.readFloatLE(56)).toBeCloseTo(10 ** (-1 / 20), 6);
  });

  it.each([
    { format: 6, bits: 8, rate: 8000, channels: 1, actual: '8 kHz・8-bit 形式コード 0x6・mono' },
    { format: 3, bits: 32, rate: 48000, channels: 6, actual: '48 kHz・32-bit float・6チャンネル' },
  ])('explains the detected unsupported format: $actual', async ({ format, bits, rate, channels, actual }) => {
    const bytes = makeWav(1);
    bytes.writeUInt16LE(format, 20); bytes.writeUInt16LE(channels, 22);
    bytes.writeUInt32LE(rate, 24); bytes.writeUInt16LE(bits, 34);
    await expect(parseWav(fileOf(bytes))).rejects.toThrow(actual);
  });

  it.each([
    [8000, 8, 1, 1], [44100, 16, 2, 1], [96000, 24, 2, 1],
    [192000, 32, 1, 1], [44100, 32, 2, 3], [96000, 64, 1, 3],
  ])('reads and exports %i Hz, %i-bit WAV with %i channel(s), format %i', async (sampleRate, bits, channels, format) => {
    const stride = bits / 8, blockAlign = channels * stride;
    const frames = sampleRate + 1;
    const bytes = Buffer.alloc(44 + frames * blockAlign + (frames * blockAlign % 2));
    makeWav(1).copy(bytes, 0, 0, 44);
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.writeUInt16LE(format, 20);
    bytes.writeUInt16LE(channels, 22);
    bytes.writeUInt32LE(sampleRate, 24);
    bytes.writeUInt32LE(sampleRate * blockAlign, 28);
    bytes.writeUInt16LE(blockAlign, 32);
    bytes.writeUInt16LE(bits, 34);
    bytes.writeUInt32LE(frames * blockAlign, 40);
    for (let i = 0; i < frames * channels; i++) {
      const value = i % 2 === 0 ? -.5 : .25, offset = 44 + i * stride;
      if (format === 3) {
        if (bits === 32) bytes.writeFloatLE(value, offset);
        else bytes.writeDoubleLE(value, offset);
      } else if (bits === 8) bytes.writeUInt8(128 + value * 128, offset);
      else bytes.writeIntLE(value * 2 ** (bits - 1), offset, stride);
    }
    const file = fileOf(bytes), wav = await parseWav(file);
    expect(wav).toMatchObject({ sampleRate, bits, channels, frames });
    expect(await analyzeAudio(file, wav, wasm)).toMatchObject({ sample_rate: sampleRate, total_frames: frames });
    expect(await readWaveform(file, wav, { startFrame: 0, endFrame: 2, bins: 1 })).toEqual(new Float32Array([.5]));
    const { blob } = await renderAudio(file, wav, { startFrame: 1, endFrame: 3, normalize: false, targetDb: -1 }, wasm);
    expect(await parseWav(blob!)).toMatchObject({ sampleRate, channels, bits: 32, format: 3, frames: 2 });
    const output = Buffer.from(await blob!.arrayBuffer());
    expect(output.readFloatLE(56)).toBe(channels === 1 ? .25 : -.5);
  });

  it('decodes 24 valid bits left-aligned in a 32-bit extensible PCM container', async () => {
    const bytes = Buffer.alloc(76);
    bytes.write('RIFF'); bytes.writeUInt32LE(68, 4); bytes.write('WAVEfmt ', 8);
    bytes.writeUInt32LE(40, 16); bytes.writeUInt16LE(0xfffe, 20); bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(192000, 28);
    bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(32, 34); bytes.writeUInt16LE(22, 36);
    bytes.writeUInt16LE(24, 38); bytes.writeUInt32LE(4, 40);
    Buffer.from('0100000000001000800000aa00389b71', 'hex').copy(bytes, 44);
    bytes.write('data', 60); bytes.writeUInt32LE(8, 64);
    bytes.writeInt32LE(-0x40000000, 68); bytes.writeInt32LE(0x20000000, 72);
    const file = fileOf(bytes), wav = await parseWav(file);
    expect(wav).toMatchObject({ format: 1, bits: 32, validBits: 24 });
    expect(await readWaveform(file, wav, { startFrame: 0, endFrame: 2, bins: 2 })).toEqual(new Float32Array([.5, .25]));
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
    await expect(parseWav(fileOf(wrongRate))).rejects.toThrow('チャンク');
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
