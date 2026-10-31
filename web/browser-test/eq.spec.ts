import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { makeWav, RATE } from '../test/fixtures';

declare global { interface Window { eqAudio: HTMLAudioElement; } }

test('uses the exact corrected export for preview and preserves original timeline seeking', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeAudio = window.Audio;
    window.Audio = class extends NativeAudio {
      constructor(src?: string) { super(src); window.eqAudio = this; }
    };
  });
  const requests: string[] = [];
  page.context().on('request', request => requests.push(request.method()));
  await page.goto('/');
  const input = makeWav(8);
  for (let frame = 0; frame < 8 * RATE; frame++) {
    const value = .2 * Math.sin(2 * Math.PI * 8000 * frame / RATE) + .1 * Math.sin(2 * Math.PI * 440 * frame / RATE);
    input.writeFloatLE(value, 44 + frame * 8); input.writeFloatLE(value * .5, 48 + frame * 8);
  }
  await page.locator('#file').setInputFiles({ name: 'concert.wav', mimeType: 'audio/wav', buffer: input });
  await page.locator('#begin-analysis').click();
  await expect(page.locator('#editor')).toBeVisible();
  await expect(page.locator('#m5-eq')).not.toBeChecked();
  await page.locator('#start').fill('1.000019');
  await page.locator('#end').fill('4.000019');
  await page.locator('#m5-eq').check();
  await page.locator('#listen-start').click();
  await expect(page.locator('#progress')).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.eqAudio.paused)).toBe(false);
  await expect.poll(async () => Number(await page.locator('#seek').inputValue())).toBeGreaterThan(1);
  await page.locator('#stop').click();
  const preparedUrl = await page.evaluate(() => window.eqAudio.src);
  const preview = Buffer.from(await page.evaluate(async () => Array.from(new Uint8Array(await (await fetch(window.eqAudio.src)).arrayBuffer()))));
  expect(preview.readUInt32LE(44)).toBe(3 * RATE);
  let peak = 0;
  for (let offset = 56; offset < preview.length; offset += 8) {
    const left = preview.readFloatLE(offset), right = preview.readFloatLE(offset + 4);
    peak = Math.max(peak, Math.abs(left), Math.abs(right));
    if (offset % 997 === 0 && Math.abs(left) > .01) expect(right / left).toBeCloseTo(.5, 5);
  }
  expect(peak).toBeCloseTo(10 ** (-1 / 20), 6);
  const downloaded = page.waitForEvent('download');
  await page.locator('#export').click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe('concert_clip_m5.wav');
  const exported = await readFile((await download.path())!);
  expect(Buffer.compare(preview, exported)).toBe(0);

  // Reuse the processed preview and keep the full-file time coordinate system.
  await page.locator('#listen-start').click();
  await expect.poll(() => page.evaluate(() => window.eqAudio.src)).toBe(preparedUrl);
  const seek = page.getByRole('slider', { name: '再生位置', exact: true });
  await seek.focus(); await seek.press('End');
  await expect.poll(() => page.evaluate(() => window.eqAudio.paused)).toBe(true);
  await expect.poll(async () => Number(await seek.inputValue())).toBeCloseTo(4, 2);
  await page.locator('#m5-eq').uncheck();
  expect(await page.evaluate(() => window.eqAudio.src)).not.toBe(preparedUrl);
  await page.locator('#m5-eq').check();
  await page.locator('#start').fill('2');
  await page.locator('#listen-start').click();
  await expect(page.locator('#progress')).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.eqAudio.paused)).toBe(false);
  expect(await page.evaluate(() => window.eqAudio.src)).not.toBe(preparedUrl);
  await expect.poll(async () => Number(await seek.inputValue())).toBeGreaterThanOrEqual(2);
  await page.locator('#stop').click();
  await page.locator('.eq-panel summary').click();
  await expect(page.locator('#eq-curve polyline')).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/m5-eq-mobile.png', fullPage: true });
  await expect(page.locator('#error')).toBeHidden();
  expect(requests.every(method => method === 'GET')).toBe(true);
});

test('does not begin playback after stopping EQ preview preparation', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeAudio = window.Audio;
    window.Audio = class extends NativeAudio {
      constructor(src?: string) { super(src); window.eqAudio = this; }
    };
  });
  await page.route('**/audio-worker.js', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\nconst handler = self.onmessage; self.onmessage = event => { if (event.data.type === 'preview') setTimeout(() => handler(event), 500); else handler(event); };` });
  });
  await page.goto('/');
  await page.locator('#file').setInputFiles({ name: 'recording.wav', mimeType: 'audio/wav', buffer: makeWav(8) });
  await page.locator('#begin-analysis').click();
  await expect(page.locator('#editor')).toBeVisible();
  await page.locator('#m5-eq').check();
  await page.locator('#listen-start').click();
  await expect(page.locator('#progress')).toBeVisible();
  await page.locator('#stop').click();
  await expect(page.locator('#progress')).toBeHidden();
  expect(await page.evaluate(() => window.eqAudio.paused)).toBe(true);
  await expect(page.locator('#error')).toBeHidden();
});
