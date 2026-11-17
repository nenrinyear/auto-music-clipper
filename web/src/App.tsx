import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { parseWav } from './audio-processing.js';
import { AudioJobs } from './audio-jobs';
import type { Analysis, Plan, Wav } from './audio-jobs';
import { Playback } from './playback';
import type { PreviewButton } from './playback';
import { clock, formatBytes } from './format';
import { selectionFrames, frameSeconds } from './trim-view.js';
import { EqCurve } from './EqCurve';
import { TrimPanel } from './TrimPanel';

const stages = [
  ['upload', '読み込み'],
  ['trim', '範囲調整'],
  ['audio', '音量・補正'],
  ['export', '書き出し'],
] as const;
type Stage = typeof stages[number][0];
type Operation = 'load' | 'analyze' | 'preview' | 'export';
type Activity = { operation?: Operation; progress?: string; error?: string };
type ActivityEvent =
  | { type: 'start'; operation: Operation; progress?: string }
  | { type: 'progress'; message: string }
  | { type: 'finish' }
  | { type: 'error'; message?: string };

function activityReducer(state: Activity, event: ActivityEvent): Activity {
  switch (event.type) {
    case 'start': return { operation: event.operation, progress: event.progress };
    case 'progress': return { ...state, progress: event.message };
    case 'finish': return { error: state.error };
    case 'error': return { ...state, error: event.message };
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function App() {
  const [{ operation, progress, error }, dispatch] = useReducer(activityReducer, {});
  const [stage, setStage] = useState<Stage>('upload');
  const [source, setSource] = useState<{ file: File; wav: Wav }>();
  const [analysis, setAnalysis] = useState<Analysis>();
  const [dragging, setDragging] = useState(false);
  const [bounds, setBounds] = useState({ start: '', end: '' });
  const [normalize, setNormalize] = useState(true);
  const [target, setTarget] = useState('-0.5');
  const [eq, setEq] = useState(true);
  const [measurement, setMeasurement] = useState<{ key: string; gain: number }>();
  const [active, setActive] = useState<PreviewButton>();
  const [exportStatus, setExportStatus] = useState('');
  const [playback] = useState(() => new Playback(setActive));
  const [jobs] = useState(() => new AudioJobs());
  const inFlight = useRef<Operation | undefined>(undefined);
  const fileInput = useRef<HTMLInputElement>(null);
  const analyzeButton = useRef<HTMLButtonElement>(null);
  const trimHeading = useRef<HTMLHeadingElement>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const focus = useRef<'analyze' | 'trim' | undefined>(undefined);

  const busy = operation !== undefined;
  const wav = source?.wav;
  const sampleRate = wav?.sampleRate;
  const plan: Plan = { ...selectionFrames(bounds.start, bounds.end, sampleRate), targetDb: Number(target), normalize, eq: eq ? 'rode-m5' : 'none' };
  const { startFrame, endFrame } = plan;
  const valid = !!wav && Number.isSafeInteger(startFrame) && Number.isSafeInteger(endFrame)
    && startFrame >= 0 && endFrame <= wav.frames && endFrame > startFrame;
  const defaultStart = analysis?.start_frame ?? 0;
  const defaultEnd = analysis?.end_frame ?? wav?.frames ?? 0;
  const gainDb = measurement?.key === JSON.stringify(plan) ? 20 * Math.log10(measurement.gain) : undefined;
  const normalizationInfo = !normalize ? (eq ? 'ノーマライズなし（M5補正のみ）' : 'ノーマライズなし（原音の音量）')
    : gainDb !== undefined ? `選択範囲で再計算済み · ${gainDb >= 0 ? '+' : ''}${gainDb.toFixed(1)} dB（左右共通）`
      : '選択範囲のピークで再計算します（試聴・書き出し時）';

  useEffect(() => () => {
    playback.dispose();
    jobs.dispose();
  }, [playback, jobs]);

  useLayoutEffect(() => {
    if (busy || !focus.current) return;
    (focus.current === 'trim' ? trimHeading : analyzeButton).current?.focus();
    focus.current = undefined;
  }, [busy, source, analysis]);

  async function run<T>(name: Operation, action: () => Promise<T>, progress?: string): Promise<T> {
    if (inFlight.current) throw Error('処理が完了するまでお待ちください。');
    inFlight.current = name;
    dispatch({ type: 'start', operation: name, progress });
    try {
      return await action();
    } finally {
      inFlight.current = undefined;
      dispatch({ type: 'finish' });
    }
  }

  const reportProgress = (message: string) => dispatch({ type: 'progress', message });
  const reportError = (error: unknown) => dispatch({ type: 'error', message: errorMessage(error) });

  async function loadFile(file: File) {
    if (inFlight.current) return;
    playback.clear();
    setExportStatus('');
    setMeasurement(undefined);
    setSource(undefined);
    setAnalysis(undefined);
    setStage('upload');
    try {
      await run('load', async () => {
        if (!file.name.toLowerCase().endsWith('.wav')) throw Error('WAVファイルを選択してください。');
        const wav = await parseWav(file);
        playback.load(file, wav);
        setSource({ file, wav });
        focus.current = 'analyze';
      });
    } catch (error) { reportError(error); }
  }

  async function analyze() {
    if (inFlight.current || !source) return;
    playback.stop();
    try {
      await run('analyze', async () => {
        try {
          const result = await jobs.run('analyze', source.file, reportProgress);
          setBounds({
            start: frameSeconds(result.start_frame ?? 0, source.wav.sampleRate),
            end: frameSeconds(result.end_frame ?? source.wav.frames, source.wav.sampleRate),
          });
          setAnalysis(result);
          setStage('trim');
          focus.current = 'trim';
        } catch (error) {
          focus.current = 'analyze';
          throw error;
        }
      }, '端末内で解析を準備しています…');
    } catch (error) { reportError(error); }
  }

  function changeBounds(next: typeof bounds) {
    playback.stop();
    playback.restoreOriginal();
    setBounds(next);
  }

  function changePreviewSetting(update: () => void) {
    playback.stop();
    playback.restoreOriginal();
    update();
  }

  function selectStage(next: Stage) {
    if (next === stage) return;
    playback.stop();
    setStage(next);
  }

  function navigateTabs(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const length = analysis ? stages.length : 1;
    const next = ({
      ArrowLeft: (index + length - 1) % length,
      ArrowRight: (index + 1) % length,
      Home: 0,
      End: length - 1,
    } as Record<string, number>)[event.key];
    if (next === undefined) return;
    event.preventDefault();
    tabs.current[next]?.focus();
    selectStage(stages[next][0]);
  }

  async function preview(seconds: number, button: PreviewButton) {
    if (inFlight.current || !source) return;
    dispatch({ type: 'error' });
    try {
      await playback.play(seconds, button, plan, {
        prepare: () => run('preview', () => jobs.run('preview', source.file, reportProgress, plan),
          'EQを反映した試聴音声を準備しています…'),
        measure: () => run('preview', () => jobs.run('measure', source.file, reportProgress, plan),
          '試聴用のピークを測定しています…'),
        measurement,
        onMeasured: setMeasurement,
      });
    } catch (error) { reportError(error instanceof Error ? error : 'このブラウザではWAVを試聴できません。'); }
  }

  async function exportWav() {
    if (inFlight.current || !source || !analysis || !valid) return;
    playback.stop();
    setExportStatus('');
    try {
      await run('export', async () => {
        const { blob } = await jobs.run('render', source.file, reportProgress, plan);
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = source.file.name.replace(/\.wav$/i, '') + (eq ? '_clip_m5.wav' : '_clip.wav');
        document.body.append(link);
        link.click();
        link.remove();
        setExportStatus(`${link.download} のダウンロードを開始しました。保存先はブラウザの設定に従います。`);
        // Let large downloads finish opening the backing file.
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        playback.restoreOriginal();
      }, '端末内でWAVを書き出しています…');
    } catch (error) { reportError(error); }
  }

  const fileInfo = source && `${source.wav.channels === 2 ? 'Stereo' : 'Mono'} · ${source.wav.sampleRate / 1000} kHz · ${source.wav.bits}-bit ${source.wav.format === 1 ? 'PCM' : 'float'} · ${clock(source.wav.frames / source.wav.sampleRate)} · ${formatBytes(source.file.size)}`;
  return (
    <>
      <a className="skip-link" href="#main">本文へ移動</a>
      <header className="topbar">
        <a className="brand" href="/" aria-label="トリミングツール ホーム">トリミングツール</a>
        <span className="privacy">録音はこの端末内で処理します</span>
      </header>
      <main id="main" tabIndex={-1}>
        <section className="intro" aria-labelledby="page-title">
          <h1 id="page-title">録音をトリミング</h1>
        </section>
        <div className="stage-tabs" role="tablist" aria-label="編集工程">
          {stages.map(([name, label], index) => (
            <button key={name} id={`tab-${name}`} ref={element => { tabs.current[index] = element; }}
              type="button" role="tab" aria-selected={stage === name} aria-controls={`panel-${name}`}
              tabIndex={stage === name ? 0 : -1} disabled={name !== 'upload' && !analysis}
              onClick={() => selectStage(name)} onKeyDown={event => navigateTabs(event, index)}>{label}</button>
          ))}
        </div>
        <section id="panel-upload" className="upload-section" role="tabpanel" aria-labelledby="tab-upload" hidden={stage !== 'upload'}>
          <div className="section-head"><h2 id="upload-heading">録音を読み込む</h2></div>
          <p>録音から演奏の開始と終わりを自動で見つけます。範囲を調整し、WAVで保存できます。</p>
          <div id="drop" className={dragging ? 'dropzone drag' : 'dropzone'}
            onDragOver={event => { event.preventDefault(); if (!busy) setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={event => {
              event.preventDefault();
              setDragging(false);
              const file = event.dataTransfer.files[0];
              if (file) void loadFile(file);
            }}>
            <p>ここに録音ファイルをドロップ<br />または、ボタンから選択してください。</p>
            <button id="choose-file" className="primary" type="button" aria-describedby="file-requirements" disabled={busy} onClick={() => fileInput.current?.click()}>WAVファイルを選択</button>
            <input id="file" type="file" accept=".wav,audio/wav" aria-label="録音ファイル" hidden ref={fileInput} disabled={busy}
              onChange={event => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = '';
                if (file) void loadFile(file);
              }} />
          </div>
          <p id="file-requirements" className="file-requirements">モノラルまたはステレオのWAV（整数PCM・浮動小数点）に対応。長さは120分まで。録音はアップロードされません。</p>
          <div id="file-row" className="file-row" hidden={!source}>
            <div className="file-icon" aria-hidden="true">WAV</div>
            <div className="file-meta"><strong id="filename">{source?.file.name}</strong><span id="fileinfo">{fileInfo}</span></div>
            <button id="replace" className="text-button" type="button" disabled={busy} onClick={() => fileInput.current?.click()}>ファイルを変更</button>
          </div>
          <div id="preflight" className="preflight" hidden={!source || !!analysis || operation === 'analyze'}>
            <div><strong>録音をこの端末内で解析</strong><span>音声は送信されません。書き出し時に端末内の一時保存領域を使う場合があります。</span></div>
            <button id="begin-analysis" className="primary" type="button" ref={analyzeButton} disabled={busy} onClick={analyze}>解析を開始 <span aria-hidden="true">→</span></button>
          </div>
        </section>
        <div id="error" className="error" role="alert" aria-atomic="true" hidden={!error}>{error}</div>
        <section id="workspace" aria-label="録音の編集" hidden={!source}>
          <div id="progress" className="progress" role="status" aria-live="polite" aria-atomic="true" hidden={!progress}><span className="spinner" aria-hidden="true"></span><span id="progress-text">{progress}</span></div>
          <div id="editor" hidden={!analysis}>
            {source && analysis && <TrimPanel hidden={stage !== 'trim'} heading={trimHeading}
              source={source} analysis={analysis} bounds={bounds} onBounds={changeBounds}
              valid={valid} busy={busy} defaultStart={defaultStart} defaultEnd={defaultEnd}
              playback={playback} active={active} onPreview={preview} />}
            <section id="panel-audio" className="editor-section" role="tabpanel" aria-labelledby="tab-audio" hidden={stage !== 'audio'}>
              <div className="section-head"><h2 id="audio-heading">音量・補正を設定する</h2></div>
              <label className="gain-control"><input id="normalize" type="checkbox" checked={normalize} disabled={busy} aria-describedby="normalize-help" onChange={event => { const checked = event.currentTarget.checked; changePreviewSetting(() => setNormalize(checked)); }} />ピークを揃える（ノーマライズ）</label>
              <div className="gain-row"><span id="normalize-help">選択範囲で左右のうち大きいピークが指定値に達するよう、両チャンネルに同じゲインを適用します。</span><label className="gain-label">目標ピーク<select id="target" value={target} disabled={busy} onChange={event => { const value = event.currentTarget.value; changePreviewSetting(() => setTarget(value)); }}><option value="-1">−1 dBFS</option><option value="-0.5">−0.5 dBFS</option><option value="0">0 dBFS</option></select></label></div>
              <div className="eq-panel">
                <label><input id="m5-eq" type="checkbox" checked={eq} disabled={busy} aria-describedby="eq-help" onChange={event => { const checked = event.currentTarget.checked; changePreviewSetting(() => setEq(checked)); }} />RØDE M5で録音した音声を補正する</label>
                <p id="eq-help">左右に同じ補正を適用します。ノーマライズ有効時は選択範囲のEQ後のピークを使い、試聴にも反映します。</p>
                <details><summary>公称周波数特性と補正EQ</summary>
                  <EqCurve sampleRate={sampleRate} />
                  <div className="eq-legend"><span className="eq-response">M5公称特性（1 kHz基準）</span><span className="eq-correction">適用する補正EQ</span></div>
                  <p>公称特性の落ち込みをそのまま持ち上げると、低域の振動や高域のノイズまで増幅することがあります。そのため、20〜80 Hzと16〜20 kHzでは帯域の端に向かって補正を弱めています。</p>
                  <a href="https://edge.rode.com/pdf/products/48/M5_Matched_pair_DS_V02.pdf" target="_blank" rel="noopener">RØDE公式 M5データシート（V02・2ページ、新しいタブで開きます）</a>
                </details>
              </div>
              <p id="normalization-info" className="wave-help" role="status">{normalizationInfo}</p>
            </section>
            <section id="panel-export" className="editor-section" role="tabpanel" aria-labelledby="tab-export" hidden={stage !== 'export'}>
              <div className="section-head"><h2 id="export-heading">WAVを書き出す</h2></div>
              <div className="export-row"><div><span className="export-title">仕上がり</span><span id="export-info">{`${clock(Math.max(0, Number(bounds.end) - Number(bounds.start)))} · ${normalize ? '自動ノーマライズ' : 'ゲイン変更なし'}${eq ? ' · M5補正' : ''}`}</span></div><button id="export" className="primary" disabled={busy || !analysis || !valid} onClick={exportWav}>{operation === 'export' ? '書き出し中…' : <>WAVを書き出す <span aria-hidden="true">↓</span></>}</button></div>
              <p id="export-status" className="wave-help" role="status" aria-atomic="true">{exportStatus}</p>
            </section>
          </div>
        </section>
        <aside id="empty-note" className="note" hidden={!!source} aria-label="解析について"><p><strong>解析結果は目安です。</strong>残響や拍手の入り方に合わせて、開始・終了を調整してから書き出してください。</p></aside>
      </main>
    </>
  );
}
