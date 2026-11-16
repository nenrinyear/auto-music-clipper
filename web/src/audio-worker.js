import init, * as wasm from './wasm/audio_wasm.js';
import { parseWav, analyzeAudio, renderAudio, measureNormalization } from './audio-processing.js';

let ready;
let busy = false;
const directoryName = 'yoin-exports';
let cleaned = false;
async function exportDirectory() {
  if (!navigator.storage?.getDirectory) return undefined;
  return (await navigator.storage.getDirectory()).getDirectoryHandle(directoryName, { create: true });
}

self.onmessage = async ({ data }) => {
  const { id, type, file, plan } = data;
  if (busy) { self.postMessage({ id, error: '処理が完了するまでお待ちください。' }); return; }
  busy = true;
  let directory, name, writable;
  try {
    ready ??= init().catch(error => { ready = undefined; throw error; });
    await ready;
    if (!cleaned) {
      cleaned = true;
      try { await cleanupExports(await exportDirectory()); } catch { /* Local storage is optional. */ }
    }
    const wav = await parseWav(file);
    const progress = value => self.postMessage({ id, progress: value });
    if (type === 'analyze') {
      self.postMessage({ id, result: await analyzeAudio(file, wav, wasm, progress) });
    } else if (type === 'measure') {
      self.postMessage({ id, result: await measureNormalization(file, wav, plan, wasm, progress) });
    } else if (type === 'render' || type === 'preview') {
      try {
        directory = await exportDirectory();
        if (directory) {
          await cleanupExports(directory);
          name = `${Date.now()}-${crypto.randomUUID()}.wav`;
          writable = await (await directory.getFileHandle(name, { create: true })).createWritable();
        }
      } catch {
        if (name) await directory?.removeEntry(name).catch(() => {});
        directory = undefined; name = undefined; writable = undefined;
      }
      const result = await renderAudio(file, wav, plan, wasm, progress, writable);
      if (writable) {
        await writable.close(); writable = undefined;
        result.blob = await (await directory.getFileHandle(name)).getFile();
      }
      self.postMessage({ id, result });
    } else throw Error('不明な処理です。');
  } catch (error) {
    await writable?.abort().catch(() => {});
    if (name) await directory?.removeEntry(name).catch(() => {});
    self.postMessage({ id, error: error.name === 'QuotaExceededError' ? '端末内の一時保存領域が不足しています。空き容量を確保するか、短い範囲で書き出してください。' : error.message || String(error) });
  } finally { busy = false; }
};

async function cleanupExports(directory) {
  if (!directory) return;
  // Keep the backing file alive for large/slow downloads. Expire it on a later visit/export.
  for await (const [name] of directory.entries()) {
    if (/^\d+-[0-9a-f-]+\.wav$/.test(name) && Date.now() - Number(name.split('-')[0]) > 86_400_000) {
      await directory.removeEntry(name).catch(() => {});
    }
  }
}
