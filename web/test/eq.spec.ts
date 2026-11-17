import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import * as wasm from '../src/wasm/audio_wasm.js';
import { M5Equalizer, M5_PROFILE } from '../src/m5-eq.js';
import { parseWav, measureNormalization, renderAudio } from '../src/audio-processing.js';
import { makeWav, RATE } from './fixtures';

wasm.initSync({ module: readFileSync(new URL('../src/wasm/audio_wasm_bg.wasm', import.meta.url)) });

describe('nominal M5 correction', () => {
  it('keeps filter state across chunks and applies identical coefficients without channel mixing', () => {
    const samples = new Float32Array(RATE * 2);
    for (let frame = 0; frame < RATE; frame++) {
      const value = .2 * Math.sin(2 * Math.PI * 8000 * frame / RATE) + .1 * Math.sin(2 * Math.PI * 123 * frame / RATE);
      samples[frame * 2] = value; samples[frame * 2 + 1] = value * .37;
    }
    const continuous = new M5Equalizer(2).process(samples), chunked = new Float32Array(samples.length);
    const equalizer = new M5Equalizer(2);
    for (let start = 0; start < samples.length; start += 734) chunked.set(equalizer.process(samples.subarray(start, start + 734)), start);
    expect(Buffer.compare(Buffer.from(chunked.buffer), Buffer.from(continuous.buffer))).toBe(0);
    for (let i = 2048; i < samples.length; i += 998) if (Math.abs(continuous[i]) > .01) expect(continuous[i + 1] / continuous[i]).toBeCloseTo(.37, 5);
    const impulse = new Float32Array(4000); impulse[0] = 1;
    const output = new M5Equalizer(2).process(impulse);
    expect(output.filter((_, i) => i % 2 === 1).every(value => value === 0)).toBe(true);
  });

  it('has a bounded, stable response with the intended high-frequency correction', () => {
    expect(M5_PROFILE.source.url).toMatch(/^https:\/\/edge\.rode\.com\//);
    expect(M5_PROFILE.source.sha256).toHaveLength(64);
    for (const { coefficients: [, , , a1, a2] } of M5_PROFILE.design.bands) {
      // Second-order Jury stability conditions.
      expect(Math.abs(a2)).toBeLessThan(1);
      expect(1 + a1 + a2).toBeGreaterThan(0);
      expect(1 - a1 + a2).toBeGreaterThan(0);
    }
    for (const [, , db] of M5_PROFILE.design.curve) expect(Math.abs(db)).toBeLessThanOrEqual(3);
    const tone = Float32Array.from({ length: RATE }, (_, i) => .25 * Math.sin(2 * Math.PI * 8000 * i / RATE));
    const corrected = new M5Equalizer(1).process(tone);
    let before = 0, after = 0;
    for (let i = RATE / 2; i < RATE; i++) { before += tone[i] ** 2; after += corrected[i] ** 2; }
    expect(10 * Math.log10(after / before)).toBeLessThan(-2);
    expect(10 * Math.log10(after / before)).toBeGreaterThan(-3);
    expect(() => new M5Equalizer(2).process(new Float32Array([NaN, 0]))).toThrow('不正');
  });

  it('normalizes the corrected selected range and preserves state across the 30-second seam', async () => {
    const bytes = makeWav(31);
    for (let frame = 0; frame < 31 * RATE; frame++) {
      const value = .2 * Math.sin(2 * Math.PI * 8000 * frame / RATE) + .1 * Math.sin(2 * Math.PI * 440 * frame / RATE);
      bytes.writeFloatLE(value, 44 + frame * 8); bytes.writeFloatLE(value * .5, 48 + frame * 8);
    }
    const file = new Blob([new Uint8Array(bytes)]), wav = await parseWav(file);
    const source = new Float32Array(bytes.buffer, bytes.byteOffset + 44, wav.frames * 2);
    const corrected = new M5Equalizer(2).process(source);
    const plan = { startFrame: 4801, endFrame: wav.frames - 10, normalize: true, targetDb: -1, eq: 'rode-m5' };
    let peak = 0;
    for (let i = plan.startFrame * 2; i < plan.endFrame * 2; i++) peak = Math.max(peak, Math.abs(corrected[i]));
    const measured = await measureNormalization(file, wav, plan, wasm);
    expect(measured.peak).toBe(peak);
    const rendered = await renderAudio(file, wav, plan, wasm);
    const output = Buffer.from(await rendered.blob!.arrayBuffer());
    expect(rendered.gain).toBe(measured.gain);
    let outputPeak = 0;
    for (let frame = 0; frame < rendered.frames; frame++) {
      const left = output.readFloatLE(56 + frame * 8), right = output.readFloatLE(60 + frame * 8);
      outputPeak = Math.max(outputPeak, Math.abs(left), Math.abs(right));
      if (frame % 997 === 0 || Math.abs(frame - RATE * 30) < 3) {
        expect(left).toBeCloseTo(corrected[(frame + plan.startFrame) * 2] * rendered.gain, 6);
        expect(right).toBeCloseTo(left * .5, 6);
      }
    }
    expect(outputPeak).toBeCloseTo(10 ** (-1 / 20), 6);
  }, 15000);
});
