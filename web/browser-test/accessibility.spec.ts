import { test, expect } from '@playwright/test';
import { makeWav } from '../test/fixtures';

test('completes the editor flow with keyboard controls and announces the download', async ({ page }) => {
  const externalRequests: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (['http:', 'https:'].includes(url.protocol) && url.hostname !== '127.0.0.1') externalRequests.push(request.url());
  });
  await page.setViewportSize({ width: 1280, height: 960 });
  await page.goto('/');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: '本文へ移動' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'WAVファイルを選択' })).toBeFocused();
  const chooserEvent = page.waitForEvent('filechooser');
  await page.keyboard.press('Enter');
  await (await chooserEvent).setFiles({ name: 'keyboard.wav', mimeType: 'audio/wav', buffer: makeWav() });
  await expect(page.getByRole('button', { name: '解析を開始' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'クリップ範囲を確認する' })).toBeFocused();
  const start = page.getByRole('spinbutton', { name: '開始（秒）' });
  await start.fill('1');
  await page.getByRole('spinbutton', { name: '終了（秒）' }).fill('2');
  const normalize = page.getByRole('checkbox', { name: 'ピークを揃える（ノーマライズ）' });
  await normalize.focus();
  await page.keyboard.press('Space');
  await expect(normalize).not.toBeChecked();
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#export').focus();
  await page.keyboard.press('Enter');
  expect((await downloadEvent).suggestedFilename()).toBe('keyboard_clip.wav');
  await expect(page.locator('#export-status')).toContainText('keyboard_clip.wav のダウンロードを開始しました');
  await expect(page.locator('#error')).toBeHidden();
  expect(externalRequests).toEqual([]);
  await page.screenshot({ path: 'test-results/editor-desktop.png', fullPage: true });
});

test('reports invalid files and accepts a replacement through the drop area', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file').setInputFiles({ name: 'unsupported.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('invalid') });
  await expect(page.getByRole('alert')).toContainText('WAVファイルを選択してください');
  await expect(page.getByRole('button', { name: 'WAVファイルを選択' })).toBeEnabled();
  await expect(page.locator('#workspace')).toBeHidden();
  const dataTransfer = await page.evaluateHandle(bytes => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], 'replacement.wav', { type: 'audio/wav' }));
    return transfer;
  }, Array.from(makeWav(1)));
  await page.locator('#drop').dispatchEvent('drop', { dataTransfer });
  await dataTransfer.dispose();
  await expect(page.getByRole('alert')).toBeHidden();
  await expect(page.locator('#filename')).toHaveText('replacement.wav');
  await expect(page.getByRole('button', { name: '解析を開始' })).toBeFocused();
});

test('keeps the editor readable and operable on narrow screens and with reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/');
  await page.locator('#file').setInputFiles({ name: `${'long-filename-'.repeat(8)}.wav`, mimeType: 'audio/wav', buffer: makeWav(1) });
  await page.locator('#begin-analysis').click();
  await expect(page.locator('#editor')).toBeVisible();
  // Check real rendered targets, including dynamically generated detection buttons.
  for (const button of await page.locator('button:visible:enabled').all()) {
    const bounds = (await button.boundingBox())!;
    expect(bounds.width, await button.textContent() || '').toBeGreaterThanOrEqual(44);
    expect(bounds.height, await button.textContent() || '').toBeGreaterThanOrEqual(44);
  }
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/editor-mobile.png', fullPage: true });
  await page.addStyleTag({ content: 'html { font-size: 200%; }' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator('.spinner').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
});
