import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { makeWav } from '../test/fixtures';

test('processes and downloads locally without any audio upload', async ({ page }) => {
  const requests: { method: string; url: string }[] = [];
  const errors: string[] = [];
  page.context().on('request', request => requests.push({ method: request.method(), url: request.url() }));
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#progress')).toBeHidden();
  await expect(page.locator('#preflight')).toBeHidden();
  await expect(page.locator('.privacy')).toContainText('この端末内');
  const input = makeWav();
  await page.locator('#file').setInputFiles({ name: 'recording.wav', mimeType: 'audio/wav', buffer: input });
  await expect(page.locator('#empty-note')).toBeHidden();
  await expect(page.locator('#progress')).toBeHidden();
  await page.getByRole('button', { name: '解析を開始' }).click();
  await expect(page.locator('#editor')).toBeVisible();
  await expect(page.locator('#progress')).toBeHidden();
  await expect(page.locator('#preflight')).toBeHidden();
  await expect(page.locator('#export')).toBeEnabled();
  await page.locator('#start').fill('4');
  await page.locator('#end').fill('5');
  await page.locator('#normalize').uncheck();
  const downloaded = page.waitForEvent('download');
  await page.locator('#export').click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe('recording_clip.wav');
  const output = await readFile((await download.path())!);
  expect(output.subarray(0, 4).toString()).toBe('RIFF');
  expect(output.subarray(56)).toEqual(input.subarray(44 + 48_000 * 4 * 8, 44 + 48_000 * 5 * 8));
  await expect(page.locator('#export')).toBeEnabled();
  // A second export must work with the same source, using a new range.
  await page.locator('#end').fill('6');
  const nextDownload = page.waitForEvent('download');
  await page.locator('#export').click();
  const next = await nextDownload;
  expect((await readFile((await next.path())!)).length).toBe(56 + 48_000 * 2 * 8);
  const temporaryFiles = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle('yoin-exports');
    // Directory iterators are supported by the tested browsers but absent in some DOM type versions.
    const entries = (directory as unknown as { entries(): AsyncIterable<[string, unknown]> }).entries();
    let count = 0;
    for await (const [name] of entries) if (name.endsWith('.wav')) count++;
    return count;
  });
  expect(temporaryFiles).toBeGreaterThanOrEqual(2);
  expect(requests.every(request => request.method === 'GET')).toBe(true);
  expect(requests.some(request => new URL(request.url).pathname.startsWith('/api/'))).toBe(false);
  expect(requests.some(request => request.url.endsWith('.wasm'))).toBe(true);
  expect(errors).toEqual([]);
});

test('falls back to a local Blob when temporary file storage is unavailable', async ({ page }) => {
  await page.route('**/audio-worker.js', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `Object.defineProperty(navigator, 'storage', { value: undefined });\n${await response.text()}` });
  });
  await page.goto('/');
  await page.locator('#file').setInputFiles({ name: 'silence.wav', mimeType: 'audio/wav', buffer: makeWav(1, 1) });
  await page.getByRole('button', { name: '解析を開始' }).click();
  await expect(page.locator('#export')).toBeEnabled();
  const downloaded = page.waitForEvent('download');
  await page.locator('#export').click();
  const download = await downloaded;
  const output = await readFile((await download.path())!);
  expect(output.length).toBe(56 + 48_000 * 4);
  expect(output.subarray(56).every(value => value === 0)).toBe(true);
  await expect(page.locator('#error')).toBeHidden();
});
