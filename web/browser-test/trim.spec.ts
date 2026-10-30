import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { makeConcertWav, makeWav } from '../test/fixtures';

test('shows detected and manual boundaries and exports exactly the displayed sample range', async ({ page }) => {
  await page.goto('/');
  const bytes = makeConcertWav();
  await page.locator('#file').setInputFiles({ name: 'concert.wav', mimeType: 'audio/wav', buffer: bytes });
  await page.locator('#begin-analysis').click();
  await expect(page.locator('#editor')).toBeVisible();
  const markers = page.locator('#detection-markers button');
  await expect(markers).toHaveCount(3);
  for (const key of ['music_start', 'tail_end', 'final_applause_start']) {
    await expect(page.locator(`[data-marker="${key}"]`)).toBeEnabled();
    await expect(page.locator(`[data-marker="${key}"]`)).toContainText('確度');
  }
  await expect(page.locator('[data-marker="final_applause_start"]')).toContainText('低・要確認');
  await expect(page.locator('#break-info')).toContainText('楽章間候補 1か所');
  await expect(page.locator('#trim-state')).toContainText('自動検出の範囲');
  const originalStart = await page.locator('#start').inputValue(), originalEnd = await page.locator('#end').inputValue();
  const originalMarkers = await markers.allTextContents();
  // Confirm that each of the three candidate colors is actually drawn on the waveform.
  const candidateColors = await page.locator('#wave').evaluate(element => {
    const canvas = element as HTMLCanvasElement, pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    return [[128, 201, 236], [197, 162, 238], [255, 154, 134]].map(color => {
      let count = 0;
      for (let i = 0; i < pixels.length; i += 4) if (color.every((value, j) => pixels[i + j] === value)) count++;
      return count;
    });
  });
  expect(candidateColors.every(count => count > 10)).toBe(true);
  await page.locator('[data-marker="final_applause_start"]').click();
  await expect(page.locator('#zoom-level')).not.toHaveText('1.0×');
  await page.locator('#zoom-all').click();
  await page.locator('#normalize').uncheck();
  await page.locator('#start').fill('0.000019');
  await page.locator('#end').fill('6.000019');
  await page.locator('#end').blur();
  await expect(page.locator('#trim-state')).toContainText('手動調整した範囲');
  await expect(page.locator('#trim-state')).toContainText('0:00.000021–0:06.000021');
  await expect(page.locator('#trim-state')).toContainText('288,000サンプル');
  expect(await markers.allTextContents()).toEqual(originalMarkers);
  const downloaded = page.waitForEvent('download');
  await page.locator('#export').click();
  const output = await readFile((await (await downloaded).path())!);
  expect(output.readUInt32LE(44)).toBe(288000);
  expect(Buffer.compare(output.subarray(56), bytes.subarray(44 + 8, 44 + 288001 * 8))).toBe(0);
  await page.locator('#reset-trim').click();
  await expect(page.locator('#start')).toHaveValue(originalStart);
  await expect(page.locator('#end')).toHaveValue(originalEnd);
  await expect(page.locator('#trim-state')).toContainText('自動検出の範囲');
  await expect(page.locator('#reset-trim')).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/trim-markers-mobile.png', fullPage: true });
});

test('shows missing candidates explicitly for silent recordings', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file').setInputFiles({ name: 'silence.wav', mimeType: 'audio/wav', buffer: makeWav(1) });
  await page.locator('#begin-analysis').click();
  await expect(page.locator('#editor')).toBeVisible();
  await expect(page.locator('#detection-markers button:disabled')).toHaveCount(3);
  for (const key of ['music_start', 'tail_end', 'final_applause_start']) await expect(page.locator(`[data-marker="${key}"]`)).toContainText('未検出');
  await expect(page.locator('#break-info')).toContainText('連続して保持');
  await expect(page.locator('#error')).toBeHidden();
});
