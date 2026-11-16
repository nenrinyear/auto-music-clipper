import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import * as wasm from '../src/wasm/audio_wasm.js';
import { parseWav, analyzeAudio, renderAudio } from '../src/audio-processing.js';
import { selectionFrames, frameSeconds } from '../src/trim-view.js';
import { makeConcertWav, RATE } from './fixtures';

wasm.initSync({ module: readFileSync(new URL('../src/wasm/audio_wasm_bg.wasm', import.meta.url)) });

describe('sample-aligned trimming', () => {
  it('round-trips frame positions including one-sample boundaries and long recordings', () => {
    for (const frame of [0, 1, 47999, 48000, 48001, 345599999, 345600000]) {
      expect(selectionFrames(frameSeconds(frame), frameSeconds(frame))).toEqual({ startFrame: frame, endFrame: frame });
    }
    expect(selectionFrames('', '1').startFrame).toBeNaN();
    expect(selectionFrames('invalid', '1').startFrame).toBeNaN();
    expect(selectionFrames('1.000019', '2.000019')).toEqual({ startFrame: RATE + 1, endFrame: RATE * 2 + 1 });
  });

  it('retains both movements and the entire internal gap when exporting detected or manual bounds', async () => {
    const bytes = makeConcertWav(), file = new Blob([new Uint8Array(bytes)]), wav = await parseWav(file);
    const report = await analyzeAudio(file, wav, wasm);
    expect(report.music_start).not.toBeNull();
    expect(report.tail_end).not.toBeNull();
    expect(report.final_applause_start.frame).toBeGreaterThan(RATE * 6);
    expect(report.possible_breaks).toHaveLength(1);
    expect(report.start_frame).toBeLessThan(RATE);
    expect(report.end_frame).toBeGreaterThan(RATE * 6);
    expect(report.end_frame).toBeLessThan(report.final_applause_start.frame);
    for (const bounds of [
      selectionFrames(frameSeconds(report.start_frame), frameSeconds(report.end_frame)),
      selectionFrames('0.000019', '6.100019'),
    ]) {
      const rendered = await renderAudio(file, wav, { ...bounds, normalize: false, targetDb: -1 }, wasm);
      const output = Buffer.from(await rendered.blob!.arrayBuffer());
      const parsed = await parseWav(new Blob([new Uint8Array(output)]));
      expect(parsed.frames).toBe(bounds.endFrame - bounds.startFrame);
      expect(Buffer.compare(output.subarray(parsed.offset), bytes.subarray(44 + bounds.startFrame * 8, 44 + bounds.endFrame * 8))).toBe(0);
      const gapStart = 2 * RATE - bounds.startFrame, gapEnd = 5 * RATE - bounds.startFrame;
      expect(output.subarray(parsed.offset + gapStart * 8, parsed.offset + gapEnd * 8).every(sample => sample === 0)).toBe(true);
      // The second movement stays at its original offset after the full three-second pause.
      expect(Math.abs(output.readFloatLE(parsed.offset + (5 * RATE + 20 - bounds.startFrame) * 8))).toBeGreaterThan(.01);
    }
  });
});
