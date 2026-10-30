import { parseWav, RATE } from './audio-processing.js';

const $ = id => document.getElementById(id);
const drop = $('drop'), fileInput = $('file'), workspace = $('workspace');
let sourceFile, wav, objectUrl, analysis, envelope = [], busy = false, audioWorker, pending, sequence = 0, player;
let playbackRequest = 0, activePreview, animationFrame, dragMode;
let previewContext, previewSource, previewGain, measuredPreview;

function setBusy(value) {
  busy = value;
  for (const id of ['file', 'replace', 'begin-analysis', 'start', 'end', 'normalize', 'target', 'listen-start', 'listen-end', 'play', 'seek']) $(id).disabled = value;
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
$('wave').addEventListener('pointerdown', beginWaveDrag);
$('wave').addEventListener('pointermove', e => { if (dragMode) moveWavePointer(e); });
$('wave').addEventListener('pointerup', () => { dragMode = undefined; });
$('wave').addEventListener('pointercancel', () => { dragMode = undefined; });
$('wave').addEventListener('lostpointercapture', () => { dragMode = undefined; });
$('normalize').addEventListener('change', previewSettingsChanged);
$('target').addEventListener('change', previewSettingsChanged);
$('listen-start').addEventListener('click', () => preview(Number($('start').value), 'listen-start'));
$('listen-end').addEventListener('click', () => preview(Math.max(0, Number($('end').value) - 8), 'listen-end'));
$('play').addEventListener('click', () => preview(player?.ended ? 0 : player?.currentTime || 0, 'play'));
$('stop').addEventListener('click', stopPlayback);
$('seek').addEventListener('input', () => seekPlayback(Number($('seek').value)));
$('export').addEventListener('click', exportWav);

async function loadFile(file) {
  if (busy) return;
  clearError(); setBusy(true); stopPlayback();
  previewSource?.disconnect(); previewGain?.disconnect();
  previewSource = undefined; previewGain = undefined; measuredPreview = undefined;
  if (player) { player.removeAttribute('src'); player.load(); player = undefined; }
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
    setupPlayer();
    workspace.hidden = false; $('empty-note').hidden = true; $('preflight').hidden = false;
  } catch (error) { showError(error.message || String(error)); }
  finally { setBusy(false); }
}

async function startAnalysis() {
  if (busy || !sourceFile || !wav) return;
  stopPlayback();
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
  const position = Math.max(0, Math.min(1, (player?.currentTime || 0) / (wav.frames / RATE))) * w;
  ctx.fillStyle = '#e5a46e'; ctx.fillRect(Math.min(w - 2, position), 0, 2, h);
  ctx.beginPath(); ctx.moveTo(position - 6, 0); ctx.lineTo(position + 6, 0); ctx.lineTo(position, 9); ctx.fill();
}
function beginWaveDrag(event) {
  if (busy || !wav || $('editor').hidden || event.button !== 0) return;
  const bounds = $('wave').getBoundingClientRect(), duration = wav.frames / RATE;
  const x = event.clientX - bounds.left;
  const a = Number($('start').value) / duration * bounds.width;
  const b = Number($('end').value) / duration * bounds.width;
  dragMode = Math.min(Math.abs(x - a), Math.abs(x - b)) <= 12
    ? (Math.abs(x - a) <= Math.abs(x - b) ? 'start' : 'end') : 'seek';
  $('wave').setPointerCapture(event.pointerId); event.preventDefault();
  moveWavePointer(event);
}
function moveWavePointer(event) {
  if (busy || !wav || $('editor').hidden) return;
  const bounds = $('wave').getBoundingClientRect(), fraction = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
  const seconds = fraction * (wav.frames / RATE);
  if (dragMode === 'seek') seekPlayback(seconds);
  else if (dragMode) { $(dragMode).value = seconds.toFixed(5); updateRange(); }
}
function updateRange() {
  if (!wav) return;
  stopPlayback();
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
function previewSettingsChanged() {
  stopPlayback(); updateExportInfo();
}
function currentPlan() {
  return { startFrame: Math.round(Number($('start').value) * RATE), endFrame: Math.round(Number($('end').value) * RATE), targetDb: Number($('target').value), normalize: $('normalize').checked };
}
function connectPreview() {
  previewContext ??= new AudioContext({ sampleRate: RATE });
  if (!previewSource) {
    previewGain = previewContext.createGain();
    previewGain.gain.value = 0;
    previewSource = previewContext.createMediaElementSource(player);
    previewSource.connect(previewGain).connect(previewContext.destination);
  }
  // Resume during the click gesture, before waiting for peak measurement.
  return previewContext.resume();
}
async function previewNormalization(plan) {
  const key = JSON.stringify(plan);
  if (measuredPreview?.key === key) return measuredPreview.gain;
  if (!plan.normalize) return 1;
  setBusy(true); $('progress').hidden = false;
  $('progress-text').textContent = '試聴用のピークを測定しています…';
  try {
    const { gain } = await processAudio('measure', plan);
    measuredPreview = { key, gain };
    return gain;
  } finally {
    $('progress').hidden = true; setBusy(false);
  }
}
function setupPlayer() {
  const audio = player = new Audio(objectUrl);
  audio.preload = 'metadata';
  $('seek').max = String(wav.frames / RATE);
  for (const event of ['loadedmetadata', 'timeupdate', 'seeked', 'play', 'pause', 'ended']) {
    audio.addEventListener(event, () => {
      if (player !== audio) return;
      if (event === 'ended') { activePreview = undefined; playbackRequest++; }
      updatePlayback();
    });
  }
  audio.addEventListener('error', () => {
    if (player !== audio) return;
    stopPlayback(); showError('このブラウザではWAVを試聴できません。');
  });
  updatePlayback();
}
function updatePlayback() {
  cancelAnimationFrame(animationFrame);
  const seconds = player?.currentTime || 0;
  $('seek').value = String(seconds);
  $('playback-time').textContent = `${clock(seconds)} / ${clock(wav ? wav.frames / RATE : 0)}`;
  const labels = { 'listen-start': '▶ 冒頭を試聴', 'listen-end': '▶ 終わりを試聴', play: '▶ 再生' };
  for (const [id, label] of Object.entries(labels)) {
    const active = activePreview === id;
    $(id).textContent = active ? '■ 停止' : label;
    $(id).setAttribute('aria-pressed', String(active));
  }
  $('stop').disabled = !activePreview && (!player || player.paused);
  drawWave();
  if (player && !player.paused && !player.ended) animationFrame = requestAnimationFrame(updatePlayback);
}
function stopPlayback() {
  playbackRequest++; activePreview = undefined;
  player?.pause(); updatePlayback();
}
function seekPlayback(seconds) {
  if (!player || !wav || busy) return;
  player.currentTime = Math.max(0, Math.min(wav.frames / RATE, seconds));
  updatePlayback();
}
async function preview(seconds, button) {
  if (!player || busy) return;
  if (activePreview === button) { stopPlayback(); return; }
  const audio = player, request = ++playbackRequest;
  activePreview = button;
  audio.pause(); seekPlayback(seconds); updatePlayback(); clearError();
  try {
    const plan = currentPlan();
    await connectPreview();
    if (request !== playbackRequest || player !== audio) return;
    const gain = await previewNormalization(plan);
    if (request !== playbackRequest || player !== audio) return;
    previewGain.gain.setValueAtTime(gain, previewContext.currentTime);
    await audio.play();
  }
  catch (error) {
    if (request !== playbackRequest || player !== audio) return;
    stopPlayback(); showError(error.message || 'このブラウザではWAVを試聴できません。');
  }
}
async function exportWav() {
  if (busy || !sourceFile || !wav || !analysis) return;
  stopPlayback();
  const plan = currentPlan();
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
