import { parseWav, RATE } from './audio-processing.js';
import { WaveformView } from './waveform-view.js';
import { detectionMarkers, selectionFrames, frameSeconds, frameTime, drawTrimOverlay } from './trim-view.js';
import { M5_PROFILE } from './m5-profile.js';

const $ = id => document.getElementById(id);
const drop = $('drop'), fileInput = $('file'), workspace = $('workspace');
let sourceFile, wav, objectUrl, analysis, envelope = [], busy = false, audioWorker, pending, sequence = 0, player;
let playbackRequest = 0, activePreview, animationFrame, dragMode;
let previewContext, previewSource, previewGain, measuredPreview;
let preparedPreview, playbackOffset = 0, processedFrames;
const waveView = new WaveformView(updateWaveView);

function setBusy(value) {
  busy = value;
  for (const id of ['file', 'choose-file', 'replace', 'begin-analysis', 'start', 'end', 'normalize', 'target', 'm5-eq', 'listen-start', 'listen-end', 'play', 'seek']) $(id).disabled = value;
  $('export').disabled = value || !analysis;
  $('play').disabled = value || !!activePreview;
}
function getWorker() {
  if (audioWorker) return audioWorker;
  const worker = new Worker(new URL('./audio-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (!pending || pending.id !== data.id) return;
    if (data.progress) {
      const phases = { analyze: '端末内で解析中', measure: 'ピークを測定中', render: 'WAVを書き出し中' };
      if (pending.type === 'preview') phases.render = 'EQを反映した試聴音声を準備中';
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
      pending = { id, type, resolve, reject };
      worker.postMessage({ id, type, file: sourceFile, plan });
    } catch (error) { pending = undefined; reject(error); }
  });
}

$('choose-file').addEventListener('click', () => { if (!busy) fileInput.click(); });
drop.addEventListener('dragover', e => { e.preventDefault(); if (!busy) drop.classList.add('drag'); });
drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('drag'); if (!busy && e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });
fileInput.addEventListener('change', () => { const selected = fileInput.files[0]; fileInput.value = ''; if (selected) loadFile(selected); });
$('replace').addEventListener('click', () => fileInput.click());
$('begin-analysis').addEventListener('click', startAnalysis);
$('start').addEventListener('input', updateRange);
$('end').addEventListener('input', updateRange);
for (const id of ['start', 'end']) $(id).addEventListener('change', () => {
  const frame = selectionFrames($(id).value, $(id).value).startFrame;
  if (Number.isSafeInteger(frame)) $(id).value = frameSeconds(frame);
  updateRange();
});
$('reset-trim').addEventListener('click', () => {
  if (busy || !analysis) return;
  $('start').value = frameSeconds(analysis.start_frame ?? 0);
  $('end').value = frameSeconds(analysis.end_frame ?? wav.frames);
  updateRange();
});
$('wave').addEventListener('pointerdown', beginWaveDrag);
$('wave').addEventListener('pointermove', e => { if (dragMode) moveWavePointer(e); });
$('wave').addEventListener('pointerup', () => { dragMode = undefined; });
$('wave').addEventListener('pointercancel', () => { dragMode = undefined; });
$('wave').addEventListener('lostpointercapture', () => { dragMode = undefined; });
$('normalize').addEventListener('change', previewSettingsChanged);
$('target').addEventListener('change', previewSettingsChanged);
$('m5-eq').addEventListener('change', previewSettingsChanged);
$('listen-start').addEventListener('click', () => preview(Number($('start').value), 'listen-start'));
$('listen-end').addEventListener('click', () => preview(Math.max(0, Number($('end').value) - 8), 'listen-end'));
$('play').addEventListener('click', () => preview(player?.ended ? 0 : playbackTime(), 'play'));
$('stop').addEventListener('click', stopPlayback);
$('seek').addEventListener('input', () => seekPlayback(Number($('seek').value)));
$('export').addEventListener('click', exportWav);
$('zoom-in').addEventListener('click', () => waveView.zoom(2, playbackTime()));
$('zoom-out').addEventListener('click', () => waveView.zoom(.5, playbackTime()));
$('zoom-all').addEventListener('click', () => waveView.set(0, waveView.duration));
$('zoom-selection').addEventListener('click', () => {
  const a = Number($('start').value), b = Number($('end').value);
  if (b > a) waveView.set(a - (b - a) * .05, (b - a) * 1.1);
});
for (const boundary of ['start', 'end']) {
  $(`zoom-${boundary}`).addEventListener('click', () => waveView.set(Number($(boundary).value) - 2.5, 5));
}
$('wave-pan').addEventListener('input', () => waveView.set(Number($('wave-pan').value), waveView.span));
new ResizeObserver(drawWave).observe($('wave'));
drawEqCurve();

async function loadFile(file) {
  if (busy) return;
  clearError(); $('export-status').textContent = ''; setBusy(true); stopPlayback();
  if (preparedPreview) URL.revokeObjectURL(preparedPreview.url);
  preparedPreview = undefined; playbackOffset = 0; processedFrames = undefined;
  previewSource?.disconnect(); previewGain?.disconnect();
  previewSource = undefined; previewGain = undefined; measuredPreview = undefined;
  if (player) { player.removeAttribute('src'); player.load(); player = undefined; }
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = undefined; sourceFile = undefined; wav = undefined; analysis = undefined; envelope = [];
  waveView.reset();
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
  finally { setBusy(false); if (sourceFile) $('begin-analysis').focus(); }
}

async function startAnalysis() {
  if (busy || !sourceFile || !wav) return;
  stopPlayback();
  setBusy(true); clearError(); $('preflight').hidden = true; $('progress').hidden = false;
  $('progress-text').textContent = '端末内で解析を準備しています…';
  try {
    analysis = await processAudio('analyze');
    envelope = analysis.waveform;
    waveView.reset(sourceFile, wav, envelope);
    updateWaveView();
    $('start').value = frameSeconds(analysis.start_frame ?? 0);
    $('end').value = frameSeconds(analysis.end_frame ?? wav.frames);
    showDetectionMarkers();
    $('status').textContent = analysis.status === 'ready' ? '自動検出 · 確認してください' : '要確認 · 手動調整してください';
    $('editor').hidden = false;
  } catch (error) { $('preflight').hidden = false; showError(error.message || String(error)); }
  finally {
    $('progress').hidden = true; setBusy(false);
    if (analysis) { updateRange(); $('trim-heading').focus(); }
    else $('begin-analysis').focus();
  }
}

function drawWave() {
  const canvas = $('wave'), ctx = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h); ctx.fillStyle = '#28342d'; ctx.fillRect(0, h / 2, w, 1);
  waveView.draw(ctx, w, h);
  if (!wav || !waveView.span) return;
  drawTrimOverlay(ctx, waveView, w, h, analysis, selectionFrames($('start').value, $('end').value), { x: w / (canvas.clientWidth || w), y: h / (canvas.clientHeight || h) });
  const position = waveView.xAt(playbackTime(), w);
  if (position >= 0 && position <= w) {
    ctx.fillStyle = '#e5a46e'; ctx.fillRect(Math.min(w - 2, position), 0, 2, h);
    ctx.beginPath(); ctx.moveTo(position - 6, 0); ctx.lineTo(position + 6, 0); ctx.lineTo(position, 9); ctx.fill();
  }
}
function showDetectionMarkers() {
  const list = $('detection-markers'); list.replaceChildren();
  const confidenceLabels = { high: '高', medium: '中', low: '低・要確認' };
  for (const { key, label, color } of detectionMarkers) {
    const candidate = analysis[key], item = document.createElement('button');
    item.type = 'button'; item.className = 'marker-item'; item.dataset.marker = key;
    item.style.setProperty('--marker-color', color);
    item.disabled = candidate == null;
    item.textContent = candidate ? `${label} ${frameTime(candidate.frame)} · 確度 ${confidenceLabels[candidate.confidence] || '要確認'}` : `${label}：未検出`;
    if (candidate) item.addEventListener('click', () => waveView.set(candidate.frame / RATE - 2.5, 5));
    list.append(item);
  }
  const gaps = analysis.possible_breaks || [];
  $('break-info').textContent = gaps.length ? `楽章間候補 ${gaps.length}か所（切り出し範囲内は保持）: ${gaps.map(gap => `${frameTime(gap.start_frame)}–${frameTime(gap.end_frame)}`).join(' / ')}` : '範囲内の音声・無音は連続して保持します。';
}
function updateWaveView() {
  const preciseClock = seconds => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, '0')}`;
  $('wave-start-label').textContent = preciseClock(waveView.start);
  $('duration-label').textContent = preciseClock(waveView.end);
  $('zoom-level').textContent = `${(waveView.duration / waveView.span || 1).toFixed(1)}×`;
  $('zoom-in').disabled = waveView.span <= Math.min(.1, waveView.duration) + 1e-9;
  $('zoom-out').disabled = waveView.span >= waveView.duration;
  $('wave-pan').disabled = waveView.span >= waveView.duration;
  $('wave-pan').max = String(Math.max(0, waveView.duration - waveView.span));
  $('wave-pan').step = String(Math.max(1 / RATE, waveView.span / 1000));
  $('wave-pan').value = String(waveView.start);
  $('wave-detail').textContent = waveView.worker ? '詳細な波形を読み込み中…' : waveView.error || '';
  drawWave();
}
function beginWaveDrag(event) {
  if (busy || !wav || $('editor').hidden || event.button !== 0) return;
  const bounds = $('wave').getBoundingClientRect();
  const x = event.clientX - bounds.left;
  const distance = boundary => {
    const frame = selectionFrames($(boundary).value, $(boundary).value).startFrame;
    const position = waveView.xAt(frame / RATE, bounds.width);
    return position >= 0 && position <= bounds.width ? Math.abs(x - position) : Infinity;
  };
  const a = distance('start'), b = distance('end');
  dragMode = Math.min(a, b) <= 12 ? (a <= b ? 'start' : 'end') : 'seek';
  $('wave').setPointerCapture(event.pointerId); event.preventDefault();
  moveWavePointer(event);
}
function moveWavePointer(event) {
  if (busy || !wav || $('editor').hidden) return;
  const bounds = $('wave').getBoundingClientRect(), fraction = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
  const seconds = waveView.timeAt(fraction);
  if (dragMode === 'seek') seekPlayback(seconds);
  else if (dragMode) { $(dragMode).value = frameSeconds(Math.round(seconds * RATE)); updateRange(); }
}
function updateRange() {
  if (!wav) return;
  stopPlayback();
  restoreOriginalPreview();
  const { startFrame, endFrame } = currentPlan();
  const valid = Number.isSafeInteger(startFrame) && Number.isSafeInteger(endFrame) && startFrame >= 0 && endFrame <= wav.frames && endFrame > startFrame;
  $('export').disabled = busy || !analysis || !valid;
  $('selection-length').textContent = valid ? `${clock((endFrame - startFrame) / RATE)}を書き出し` : '範囲が不正です';
  const rangeLabel = analysis?.start_frame == null || analysis?.end_frame == null ? '自動検出なし・手動指定の範囲'
    : startFrame === analysis.start_frame && endFrame === analysis.end_frame ? '自動検出の範囲' : '手動調整した範囲';
  $('trim-state').textContent = !valid ? '開始・終了位置を確認してください。' : `${rangeLabel} · ${frameTime(startFrame)}–${frameTime(endFrame)} · ${(endFrame - startFrame).toLocaleString('ja-JP')}サンプル（終了位置は含みません）`;
  $('reset-trim').disabled = busy || !analysis || (startFrame === (analysis.start_frame ?? 0) && endFrame === (analysis.end_frame ?? wav.frames));
  drawWave(); updateExportInfo();
}
function updateExportInfo() {
  if (!wav) return;
  const a = Number($('start').value), b = Number($('end').value), gain = $('normalize').checked ? '自動ノーマライズ' : 'ゲイン変更なし';
  $('export-info').textContent = `${clock(Math.max(0, b - a))} · ${gain}${$('m5-eq').checked ? ' · M5補正' : ''}`;
  const measured = measuredPreview?.key === JSON.stringify(currentPlan());
  $('normalization-info').textContent = !$('normalize').checked ? ($('m5-eq').checked ? 'ノーマライズなし（M5補正のみ）' : 'ノーマライズなし（原音の音量）')
    : measured ? `選択範囲で再計算済み · ${20 * Math.log10(measuredPreview.gain) >= 0 ? '+' : ''}${(20 * Math.log10(measuredPreview.gain)).toFixed(1)} dB（左右共通）`
    : '選択範囲のピークで再計算します（試聴・書き出し時）';
}
function previewSettingsChanged() {
  stopPlayback(); restoreOriginalPreview(); updateExportInfo();
}
function currentPlan() {
  return { ...selectionFrames($('start').value, $('end').value), targetDb: Number($('target').value), normalize: $('normalize').checked, eq: $('m5-eq').checked ? 'rode-m5' : 'none' };
}
function playbackTime() { return (player?.currentTime || 0) + playbackOffset; }
function restoreOriginalPreview() {
  if (processedFrames === undefined || !player || !objectUrl) return;
  const position = playbackTime();
  player.src = objectUrl; playbackOffset = 0; processedFrames = undefined;
  player.currentTime = position;
}
async function prepareEqPreview(plan) {
  const key = JSON.stringify(plan);
  if (preparedPreview?.key === key) return preparedPreview;
  setBusy(true); $('progress').hidden = false;
  $('progress-text').textContent = 'EQを反映した試聴音声を準備しています…';
  try {
    const result = await processAudio('preview', plan);
    if (preparedPreview) URL.revokeObjectURL(preparedPreview.url);
    preparedPreview = { key, url: URL.createObjectURL(result.blob), startFrame: plan.startFrame, frames: result.frames };
    measuredPreview = { key, gain: result.gain };
    updateExportInfo();
    return preparedPreview;
  } finally { $('progress').hidden = true; setBusy(false); }
}
function drawEqCurve() {
  const svg = $('eq-curve'), ns = 'http://www.w3.org/2000/svg';
  const line = document.createElementNS(ns, 'polyline');
  line.setAttribute('points', M5_PROFILE.design.curve.map(([frequency, , db]) => `${10 + Math.log10(frequency / 20) / 3 * 500},${45 - db * 10}`).join(' '));
  line.setAttribute('fill', 'none'); line.setAttribute('stroke', '#d4ef83'); line.setAttribute('stroke-width', '2');
  svg.append(line);
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
    updateExportInfo();
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
  const seconds = playbackTime();
  $('seek').value = String(seconds);
  $('playback-time').textContent = `${clock(seconds)} / ${clock(wav ? wav.frames / RATE : 0)}`;
  const labels = { 'listen-start': '▶ 冒頭を試聴', 'listen-end': '▶ 終わりを試聴', play: '▶ 再生' };
  for (const [id, label] of Object.entries(labels)) {
    const active = activePreview === id;
    $(id).textContent = label;
    $(id).setAttribute('aria-pressed', String(active));
  }
  $('stop').disabled = !activePreview && (!player || player.paused);
  $('play').disabled = busy || !!activePreview;
  drawWave();
  if (player && !player.paused && !player.ended) animationFrame = requestAnimationFrame(updatePlayback);
}
function stopPlayback() {
  playbackRequest++; activePreview = undefined;
  player?.pause(); updatePlayback();
}
function seekPlayback(seconds) {
  if (!player || !wav || busy) return;
  const duration = processedFrames === undefined ? wav.frames / RATE : processedFrames / RATE;
  player.currentTime = Math.max(0, Math.min(duration, seconds - playbackOffset));
  updatePlayback();
}
async function preview(seconds, button) {
  if (!player || busy) return;
  const audio = player, request = ++playbackRequest;
  activePreview = button;
  audio.pause(); seekPlayback(seconds); updatePlayback(); clearError();
  try {
    const plan = currentPlan();
    await connectPreview();
    if (request !== playbackRequest || player !== audio) return;
    let gain;
    if (plan.eq === 'rode-m5') {
      const prepared = await prepareEqPreview(plan);
      if (request !== playbackRequest || player !== audio) return;
      if (audio.src !== prepared.url) audio.src = prepared.url;
      playbackOffset = prepared.startFrame / RATE; processedFrames = prepared.frames;
      gain = 1; // EQ and normalization are baked using the export pipeline.
    } else {
      restoreOriginalPreview(); gain = await previewNormalization(plan);
    }
    if (request !== playbackRequest || player !== audio) return;
    seekPlayback(seconds);
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
  setBusy(true); clearError(); $('export-status').textContent = ''; $('export').textContent = '書き出し中…'; $('progress').hidden = false;
  $('progress-text').textContent = '端末内でWAVを書き出しています…';
  try {
    const result = await processAudio('render', plan);
    const url = URL.createObjectURL(result.blob);
    const link = document.createElement('a'); link.href = url;
    link.download = sourceFile.name.replace(/\.wav$/i, '') + (plan.eq === 'rode-m5' ? '_clip_m5.wav' : '_clip.wav');
    document.body.append(link); link.click(); link.remove();
    $('export-status').textContent = `${link.download} のダウンロードを開始しました。保存先はブラウザの設定に従います。`;
    // Revoking the URL releases our reference without deleting a file a download may still be reading.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) { showError(error.message || String(error)); }
  finally { $('progress').hidden = true; $('export').innerHTML = 'WAVを書き出す <span>↓</span>'; setBusy(false); updateRange(); }
}
function clock(s) { if (!Number.isFinite(s)) return '0:00'; return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; }
function formatBytes(n) { return n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`; }
function showError(message) { $('error').textContent = message; $('error').hidden = false; }
function clearError() { $('error').hidden = true; }
