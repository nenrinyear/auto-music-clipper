import { test, expect } from '@playwright/test';
import { makeWav } from '../test/fixtures';

test('stops previews and synchronizes waveform, seeking and playback time', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeAudio = window.Audio;
    window.Audio = class extends NativeAudio {
      constructor(src?: string) {
        super(src);
        (window as Window & { previewAudio?: HTMLAudioElement }).previewAudio = this;
      }
    };
  });
  await page.goto('/');
  await page.locator('#file').setInputFiles({ name: 'recording.wav', mimeType: 'audio/wav', buffer: makeWav() });
  await page.locator('#begin-analysis').click();
  await expect(page.locator('#editor')).toBeVisible();
  const currentTime = () => page.evaluate(() => (window as Window & { previewAudio?: HTMLAudioElement }).previewAudio!.currentTime);
  const paused = () => page.evaluate(() => (window as Window & { previewAudio?: HTMLAudioElement }).previewAudio!.paused);
  const seek = page.getByRole('slider', { name: '再生位置' });
  await page.locator('#start').fill('4');
  await page.locator('#end').fill('27');
  await page.locator('#listen-start').click();
  await expect(page.locator('#listen-start')).toHaveText('■ 停止');
  await expect.poll(currentTime).toBeGreaterThan(4.1);
  await expect.poll(async () => Number(await seek.inputValue())).toBeGreaterThan(4.1);
  await expect(page.locator('#playback-time')).toContainText('0:04');
  await page.locator('#listen-start').click();
  await expect.poll(paused).toBe(true);
  await expect(page.locator('#listen-start')).toHaveAttribute('aria-pressed', 'false');

  await page.locator('#listen-end').click();
  await expect.poll(currentTime).toBeGreaterThanOrEqual(19);
  await expect.poll(paused).toBe(false);
  await page.locator('#stop').click();
  await expect.poll(paused).toBe(true);
  await expect(page.locator('#listen-end')).toHaveAttribute('aria-pressed', 'false');

  const canvas = page.locator('#wave'), bounds = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: bounds.width / 2, y: bounds.height / 2 } });
  await expect.poll(currentTime).toBeCloseTo(15.5, 1);
  await expect(page.locator('#start')).toHaveValue('4');
  await expect(page.locator('#end')).toHaveValue('27');
  await expect.poll(() => canvas.evaluate(element => {
    const canvas = element as HTMLCanvasElement;
    return Array.from(canvas.getContext('2d')!.getImageData(600, 90, 1, 1).data).slice(0, 3);
  })).toEqual([229, 164, 110]);

  // Drag the trim handle without moving the playback position.
  await page.mouse.move(bounds.x + bounds.width * 4 / 31, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 5 / 31, bounds.y + bounds.height / 2);
  await page.mouse.up();
  expect(Number(await page.locator('#start').inputValue())).toBeCloseTo(5, 1);
  await expect.poll(currentTime).toBeCloseTo(15.5, 1);

  await page.locator('#play').click();
  await expect.poll(paused).toBe(false);
  await seek.focus();
  await seek.press('Home');
  await expect.poll(currentTime).toBeLessThan(2);
  await seek.press('End');
  await expect.poll(paused).toBe(true);
  await expect(page.locator('#play')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#stop')).toBeDisabled();
  await expect(page.locator('#error')).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/playback-mobile.png', fullPage: true });
});

test('clears the spinner on WASM load failure and allows retry', async ({ page }) => {
  await page.route('**/*.wasm', route => route.abort());
  await page.goto('/');
  await page.locator('#file').setInputFiles({ name: 'recording.wav', mimeType: 'audio/wav', buffer: makeWav(1) });
  await page.locator('#begin-analysis').click();
  await expect(page.locator('#error')).toBeVisible();
  await expect(page.locator('#progress')).toBeHidden();
  await expect(page.locator('#preflight')).toBeVisible();
  await expect(page.locator('#begin-analysis')).toBeEnabled();
  await page.unroute('**/*.wasm');
  await page.locator('#begin-analysis').click();
  await expect(page.locator('#editor')).toBeVisible();
  await expect(page.locator('#progress')).toBeHidden();
  await expect(page.locator('#error')).toBeHidden();
});
