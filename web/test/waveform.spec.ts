import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseWav, readWaveform } from '../src/audio-processing.js';
import { WaveformView } from '../src/waveform-view.js';
import { makeWav, RATE } from './fixtures';

afterEach(() => vi.unstubAllGlobals());

describe('waveform detail', () => {
  it('reads the visible interval and retains both-channel peaks across chunks', async () => {
    const bytes = makeWav(31);
    bytes.writeFloatLE(1.5, 44 + RATE * 30 * 8 + 4);
    const file = new Blob([new Uint8Array(bytes)]), wav = await parseWav(file);
    const slice = vi.spyOn(file, 'slice');
    const peaks = await readWaveform(file, wav, { startFrame: 0, endFrame: wav.frames, bins: 31 });
    expect(peaks[30]).toBe(1.5);
    expect(peaks[0]).toBe(0);
    expect(slice.mock.calls.every(([a, b]) => Number(b) - Number(a) <= RATE * 30 * 8)).toBe(true);
    const detail = await readWaveform(file, wav, { startFrame: RATE * 30 - 1, endFrame: RATE * 30 + 3, bins: 4 });
    expect(Array.from(detail)).toEqual([0, 1.5, 0, 0]);
  });

  it('rejects invalid detail ranges and non-finite samples', async () => {
    const bytes = makeWav(1), file = new Blob([new Uint8Array(bytes)]), wav = await parseWav(file);
    await expect(readWaveform(file, wav, { startFrame: 0, endFrame: wav.frames + 1 })).rejects.toThrow('表示範囲');
    bytes.writeFloatLE(NaN, 44);
    await expect(readWaveform(new Blob([new Uint8Array(bytes)]), wav, { startFrame: 0, endFrame: 1 })).rejects.toThrow('サンプル');
  });

  it('maps viewport coordinates and discards obsolete detail requests', () => {
    const workers: FakeWorker[] = [];
    class FakeWorker {
      onmessage?: (event: { data: { peaks: Float32Array } }) => void;
      terminate = vi.fn();
      postMessage = vi.fn();
      constructor() { workers.push(this); }
    }
    vi.stubGlobal('Worker', FakeWorker);
    const view = new WaveformView(vi.fn());
    view.reset(new Blob(), { frames: 40 * RATE, sampleRate: RATE }, [0]);
    view.set(10, 5);
    expect(view.timeAt(.5)).toBe(12.5);
    expect(view.xAt(11, 1200)).toBe(240);
    view.set(20, 5);
    expect(workers[0].terminate).toHaveBeenCalled();
    workers[0].onmessage!({ data: { peaks: new Float32Array([1]) } });
    expect(view.peaks).toBeUndefined();
    workers[1].onmessage!({ data: { peaks: new Float32Array([.5]) } });
    expect(Array.from(view.peaks!)).toEqual([.5]);
    view.set(39, 5);
    expect(view.start).toBe(35);
    expect(view.end).toBe(40);
    view.zoom(1000, 40);
    expect(view.span).toBeCloseTo(.1);
    expect(view.end).toBe(40);
    view.set(0, 40);
    expect(view.span).toBe(40);
    expect(view.peaks).toBeUndefined();
  });
});
