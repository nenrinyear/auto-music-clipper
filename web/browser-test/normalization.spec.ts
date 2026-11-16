import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { makeWav } from '../test/fixtures';

type PreviewProbe = {
  audio: HTMLAudioElement;
  gain: GainNode;
  left: AnalyserNode;
  right: AnalyserNode;
  measurements: number;
};
declare global {
  interface Window { previewProbe: PreviewProbe; }
}

test('previews and exports with the same stereo gain, including changed settings', async ({ page }) => {
  await page.addInitScript(() => {
    const probe = window.previewProbe = { measurements: 0 } as PreviewProbe;
    const NativeAudio = window.Audio, NativeContext = window.AudioContext, NativeWorker = window.Worker;
    window.Audio = class extends NativeAudio {
      constructor(src?: string) { super(src); probe.audio = this; }
    };
    window.AudioContext = class extends NativeContext {
      createGain() {
        const gain = super.createGain(), splitter = this.createChannelSplitter(2);
        const left = this.createAnalyser(), right = this.createAnalyser(), silent = super.createGain();
        silent.gain.value = 0;
        gain.connect(splitter); splitter.connect(left, 0); splitter.connect(right, 1);
        left.connect(silent); right.connect(silent); silent.connect(this.destination);
        Object.assign(probe, { gain, left, right });
        return gain;
      }
    };
    window.Worker = class extends NativeWorker {
      postMessage(message: { type?: string }) {
        if (message.type === 'measure') probe.measurements++;
        super.postMessage(message);
      }
    };
  });
  const levels = () => page.evaluate(() => {
    const probe = window.previewProbe;
    const peak = (analyser: AnalyserNode) => {
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      return Math.max(...samples.map(Math.abs));
    };
    return { gain: probe.gain.gain.value, left: peak(probe.left), right: peak(probe.right), measurements: probe.measurements };
  });
  await page.goto('/');
  const input = makeWav();
  // A higher right-channel peak in another selection must cause a new measurement.
  input.writeFloatLE(.8, 44 + 10 * 48000 * 8 + 4);
  await page.locator('#file').setInputFiles({ name: 'recording.wav', mimeType: 'audio/wav', buffer: input });
  await page.locator('#begin-analysis').click();
  await expect(page.locator('#editor')).toBeVisible();
  await page.locator('#start').fill('4');
  await page.locator('#end').fill('6');
  await page.locator('#listen-start').click();
  const expected = 10 ** (-1 / 20);
  await expect.poll(async () => (await levels()).left).toBeGreaterThan(expected * .99);
  const normalized = await levels();
  expect(normalized.gain).toBeCloseTo(expected / .25, 6);
  expect(normalized.left).toBeCloseTo(expected, 3);
  expect(normalized.right / normalized.left).toBeCloseTo(.5, 3);
  expect(normalized.measurements).toBe(1);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#tab-export').click();
  await page.locator('#export').click();
  const output = await readFile((await (await downloadPromise).path())!);
  let exportPeak = 0;
  for (let offset = 56; offset < output.length; offset += 8) exportPeak = Math.max(exportPeak, Math.abs(output.readFloatLE(offset)));
  expect(normalized.left).toBeCloseTo(exportPeak, 3);

  // Same selection/settings reuse the measured gain; seeking does not change it.
  await page.locator('#tab-trim').click();
  await page.locator('#listen-start').click();
  await expect.poll(async () => (await levels()).left).toBeGreaterThan(.88);
  expect((await levels()).measurements).toBe(1);
  await page.locator('#tab-audio').click();
  await page.locator('#normalize').uncheck();
  await expect.poll(() => page.evaluate(() => window.previewProbe.audio.paused)).toBe(true);
  await page.locator('#tab-trim').click();
  await page.locator('#listen-start').click();
  await expect.poll(async () => (await levels()).gain).toBe(1);
  await expect.poll(async () => (await levels()).left).toBeCloseTo(.25, 3);

  await page.locator('#tab-audio').click();
  await page.locator('#normalize').check();
  await page.locator('#target').selectOption('-0.5');
  await page.locator('#tab-trim').click();
  await page.locator('#listen-start').click();
  await expect.poll(async () => (await levels()).gain).toBeCloseTo(10 ** (-.5 / 20) / .25, 6);
  await page.locator('#stop').click();
  await page.locator('#start').fill('10');
  await page.locator('#end').fill('11');
  await page.locator('#listen-start').click();
  await expect.poll(async () => (await levels()).gain).toBeCloseTo(10 ** (-.5 / 20) / .8, 6);
  expect((await levels()).measurements).toBe(3);
  await page.locator('#stop').click();
  // Remove the loud applause-like peak, then normalize the remaining performance again.
  await page.locator('#start').fill('4');
  await page.locator('#end').fill('6');
  await expect(page.locator('#normalization-info')).toContainText('再計算します');
  await page.locator('#listen-start').click();
  await expect.poll(async () => (await levels()).gain).toBeCloseTo(10 ** (-.5 / 20) / .25, 6);
  expect((await levels()).measurements).toBe(4);
  await expect(page.locator('#normalization-info')).toContainText('再計算済み');
  const trimmedDownload = page.waitForEvent('download');
  await page.locator('#tab-export').click();
  await page.locator('#export').click();
  const trimmed = await readFile((await (await trimmedDownload).path())!);
  let trimmedPeak = 0;
  for (let offset = 56; offset < trimmed.length; offset += 8) {
    const left = trimmed.readFloatLE(offset), right = trimmed.readFloatLE(offset + 4);
    trimmedPeak = Math.max(trimmedPeak, Math.abs(left));
    if (offset % 997 === 0 && Math.abs(left) > .01) expect(right / left).toBeCloseTo(.5, 6);
  }
  expect(trimmedPeak).toBeCloseTo(10 ** (-.5 / 20), 6);
  await expect(page.locator('#progress')).toBeHidden();
  await expect(page.locator('#error')).toBeHidden();
});

test('stopping during peak measurement does not start playback later', async ({ page }) => {
  await page.addInitScript(() => {
    window.previewProbe = {} as PreviewProbe;
    const NativeAudio = window.Audio;
    window.Audio = class extends NativeAudio {
      constructor(src?: string) { super(src); window.previewProbe.audio = this; }
    };
  });
  await page.route('**/audio-worker.js', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\nconst handler = self.onmessage; self.onmessage = event => { if (event.data.type === 'measure') setTimeout(() => handler(event), 500); else handler(event); };` });
  });
  await page.goto('/');
  await page.locator('#file').setInputFiles({ name: 'recording.wav', mimeType: 'audio/wav', buffer: makeWav() });
  await page.locator('#begin-analysis').click();
  await expect(page.locator('#editor')).toBeVisible();
  await page.locator('#listen-start').click();
  await expect(page.locator('#progress')).toBeVisible();
  await page.locator('#stop').click();
  await expect(page.locator('#progress')).toBeHidden();
  expect(await page.evaluate(() => window.previewProbe.audio.paused)).toBe(true);
  await expect(page.locator('#listen-start')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#error')).toBeHidden();
});
