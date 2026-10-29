import { parseWav, RATE } from './audio-processing.js';

const $ = id => document.getElementById(id);
const drop = $('drop'), fileInput = $('file'), workspace = $('workspace');
let sourceFile, wav, objectUrl, analysis, envelope = [], busy = false, audioWorker, pending, sequence = 0, player;

function setBusy(value) {
  busy = value;
  for (const id of ['file', 'replace', 'begin-analysis', 'start', 'end', 'normalize', 'target']) $(id).disabled = value;
  drop.setAttribute('aria-disabled', String(value));
  $('export').disabled = value || !analysis;
}
function getWorker() {
  if (audioWorker) return audioWorker;
  const worker = new Worker(new URL('./audio-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (!pending || pending.id !== data.id) return;
    if (data.progress) {
      const phases = { analyze: '端末内で解析中', measure: 'ピークを測定中', render: 'WAVを書き出し中' };
      $('progress-text').textContent = `${phases[data.progress.phase]}… ${Math.floor(data.progress.fraction * 100)}%`;
      return;
    }
    const current = pending; pending = undefined;
    if (data.error) current.reject(Error(data.error)); else current.resolve(data.result);
  };
  worker.onerror = event => {
    event.preventDefault();
    pending?.reject(Error('音声処理を起動できませんでした。ページを再読み込みしてお試しください。'));
    pending = undefined; worker.terminate(); audioWorker = undefined;
  };
  audioWorker = worker;
  return worker;
}
function processAudio(type, plan) {
  return new Promise((resolve, reject) => {
    try {
      const worker = getWorker(), id = ++sequence;
      pending = { id, resolve, reject };
      worker.postMessage({ id, type, file: sourceFile, plan });
    } catch (error) { pending = undefined; reject(error); }
  });
}

drop.addEventListener('click', () => { if (!busy) fileInput.click(); });
drop.addEventListener('keydown', e => { if (!busy && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); fileInput.click(); } });
drop.addEventListener('dragover', e => { e.preventDefault(); if (!busy) drop.classList.add('drag'); });
drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('drag'); if (!busy && e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });
fileInput.addEventListener('change', () => { const selected = fileInput.files[0]; fileInput.value = ''; if (selected) loadFile(selected); });
$('replace').addEventListener('click', () => fileInput.click());
$('begin-analysis').addEventListener('click', startAnalysis);
$('start').addEventListener('input', updateRange);
$('end').addEventListener('input', updateRange);
$('wave').addEventListener('pointerdown', moveBoundary);
$('wave').addEventListener('pointermove', e => { if (e.buttons & 1) moveBoundary(e); });
$('normalize').addEventListener('change', updateExportInfo);
$('target').addEventListener('change', updateExportInfo);
$('listen-start').addEventListener('click', () => preview(Number($('start').value)));
$('listen-end').addEventListener('click', () => preview(Math.max(0, Number($('end').value) - 8)));
$('export').addEventListener('click', exportWav);

async function loadFile(file) {
  if (busy) return;
  clearError(); setBusy(true); player?.pause();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = undefined; sourceFile = undefined; wav = undefined; analysis = undefined; envelope = [];
  workspace.hidden = true; $('empty-note').hidden = false;
  $('editor').hidden = true; $('progress').hidden = true; $('preflight').hidden = true;
  try {
    if (!file.name.toLowerCase().endsWith('.wav')) throw Error('WAVファイルを選択してください。');
    wav = await parseWav(file); sourceFile = file;
    $('filename').textContent = file.name;
    const seconds = wav.frames / RATE;
    $('fileinfo').textContent = `${wav.channels === 2 ? 'Stereo' : 'Mono'} · 48 kHz · 32-bit float · ${clock(seconds)} · ${formatBytes(file.size)}`;
    $('duration-label').textContent = clock(seconds);
    objectUrl = URL.createObjectURL(file);
    workspace.hidden = false; $('empty-note').hidden = true; $('preflight').hidden = false;
  } catch (error) { showError(error.message || String(error)); }
  finally { setBusy(false); }
}

async function startAnalysis() {
  if (busy || !sourceFile || !wav) return;
  setBusy(true); clearError(); $('preflight').hidden = true; $('progress').hidden = false;
  $('progress-text').textContent = '端末内で解析を準備しています…';
  try {
    analysis = await processAudio('analyze');
    envelope = analysis.waveform;
    $('start').value = (analysis.start_frame == null ? 0 : analysis.start_frame / RATE).toFixed(5);
    $('end').value = (analysis.end_frame == null ? wav.frames / RATE : analysis.end_frame / RATE).toFixed(5);
    $('status').textContent = analysis.status === 'ready' ? '自動検出 · 確認してください' : '要確認 · 手動調整してください';
    $('editor').hidden = false;
  } catch (error) { $('preflight').hidden = false; showError(error.message || String(error)); }
  finally { $('progress').hidden = true; setBusy(false); if (analysis) updateRange(); }
}

function drawWave() {
  const canvas = $('wave'), ctx = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h); ctx.fillStyle = '#28342d'; ctx.fillRect(0, h / 2, w, 1);
  const step = w / envelope.length;
  envelope.forEach((peak, i) => { const height = Math.max(1, Math.min(h * .45, peak * h * .45)); ctx.fillStyle = '#65766a'; ctx.fillRect(i * step, h / 2 - height, Math.max(1, step * .72), height * 2); });
  if (!wav) return;
  const a = Math.max(0, Math.min(1, Number($('start').value || 0) / (wav.frames / RATE))) * w;
  const b = Math.max(0, Math.min(1, Number($('end').value || 0) / (wav.frames / RATE))) * w;
  ctx.fillStyle = 'rgba(12,17,14,.61)'; ctx.fillRect(0, 0, a, h); ctx.fillRect(b, 0, w - b, h);
  ctx.fillStyle = '#d4ef83'; ctx.fillRect(a, 0, 2, h); ctx.fillRect(b - 2, 0, 2, h);
}
function moveBoundary(event) {
  if (busy || !wav || $('editor').hidden) return;
  const bounds = $('wave').getBoundingClientRect(), fraction = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
  const seconds = fraction * (wav.frames / RATE), start = Number($('start').value), end = Number($('end').value);
  const input = Math.abs(seconds - start) <= Math.abs(seconds - end) ? $('start') : $('end');
  input.value = seconds.toFixed(5); updateRange();
}
function updateRange() {
  if (!wav) return;
  const a = Number($('start').value), b = Number($('end').value), duration = wav.frames / RATE;
  const valid = Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b > a && Math.round(b * RATE) <= wav.frames && Math.round(b * RATE) > Math.round(a * RATE);
  $('export').disabled = busy || !analysis || !valid;
  $('selection-length').textContent = valid ? `${clock(Math.min(duration, b) - a)}を書き出し` : '範囲が不正です';
  drawWave(); updateExportInfo();
}
function updateExportInfo() {
  if (!wav) return;
  const a = Number($('start').value), b = Number($('end').value), gain = $('normalize').checked ? '自動ノーマライズ' : 'ゲイン変更なし';
  $('export-info').textContent = `${clock(Math.max(0, b - a))} · ${gain}`;
}
function preview(seconds) {
  if (!objectUrl) return;
  player?.pause(); player = new Audio(objectUrl);
  player.addEventListener('error', () => showError('このブラウザではWAVを試聴できません。'), { once: true });
  player.addEventListener('loadedmetadata', () => { player.currentTime = seconds; player.play().catch(() => showError('このブラウザではWAVを試聴できません。')); }, { once: true });
}
async function exportWav() {
  if (busy || !sourceFile || !wav || !analysis) return;
  const plan = { startFrame: Math.round(Number($('start').value) * RATE), endFrame: Math.round(Number($('end').value) * RATE), targetDb: Number($('target').value), normalize: $('normalize').checked };
  setBusy(true); clearError(); $('export').textContent = '書き出し中…'; $('progress').hidden = false;
  $('progress-text').textContent = '端末内でWAVを書き出しています…';
  try {
    const result = await processAudio('render', plan);
    const url = URL.createObjectURL(result.blob);
    const link = document.createElement('a'); link.href = url;
    link.download = sourceFile.name.replace(/\.wav$/i, '') + '_clip.wav';
    document.body.append(link); link.click(); link.remove();
    // Revoking the URL releases our reference without deleting a file a download may still be reading.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) { showError(error.message || String(error)); }
  finally { $('progress').hidden = true; $('export').innerHTML = 'WAVを書き出す <span>↓</span>'; setBusy(false); updateRange(); }
}
function clock(s) { if (!Number.isFinite(s)) return '0:00'; return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; }
function formatBytes(n) { return n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`; }
function showError(message) { $('error').textContent = message; $('error').hidden = false; }
function clearError() { $('error').hidden = true; }
