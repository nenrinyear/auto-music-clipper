import { useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent, RefObject } from 'react';
import type { Analysis, Wav } from './audio-jobs';
import type { Playback, PreviewButton } from './playback';
import { clock } from './format';
import { detectionMarkers, drawTrimOverlay, frameSeconds, frameTime, selectionFrames } from './trim-view.js';
import { WaveformView } from './waveform-view.js';

type Bounds = { start: string; end: string };
type Boundary = keyof Bounds;
type Props = {
  hidden: boolean;
  heading: RefObject<HTMLHeadingElement | null>;
  source: { file: File; wav: Wav };
  analysis: Analysis;
  bounds: Bounds;
  onBounds: (bounds: Bounds) => void;
  valid: boolean;
  busy: boolean;
  defaultStart: number;
  defaultEnd: number;
  playback: Playback;
  active?: PreviewButton;
  onPreview: (seconds: number, button: PreviewButton) => void;
};
const boundaries = [
  ['start', '開始'],
  ['end', '終了'],
] as const;
const confidence: Record<string, string> = { high: '高', medium: '中', low: '低・要確認' };
const preciseClock = (seconds: number) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, '0')}`;

export function TrimPanel({
  hidden, heading, source, analysis, bounds, onBounds, valid, busy,
  defaultStart, defaultEnd, playback, active, onPreview,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const seekRef = useRef<HTMLInputElement>(null);
  const timeRef = useRef<HTMLOutputElement>(null);
  const refreshPosition = useRef<() => void>(() => {});
  const dragMode = useRef<Boundary | 'seek' | undefined>(undefined);
  const [, setRevision] = useState(0);
  const [view] = useState(() => new WaveformView(() => setRevision(revision => revision + 1)));
  const { file, wav } = source;
  const { sampleRate, frames } = wav;
  const duration = frames / sampleRate;
  const selection = selectionFrames(bounds.start, bounds.end, sampleRate);
  const { startFrame, endFrame } = selection;
  const reset = startFrame === defaultStart && endFrame === defaultEnd;
  const gaps = analysis.possible_breaks ?? [];
  const rangeLabel = analysis.start_frame == null || analysis.end_frame == null ? '自動検出なし・手動指定の範囲'
    : reset ? '自動検出の範囲' : '手動調整した範囲';

  useLayoutEffect(() => {
    view.reset(file, wav, analysis.waveform);
    setRevision(revision => revision + 1);
    return () => view.reset(undefined, undefined);
  }, [view, file, wav, analysis]);

  function updatePosition() {
    const seconds = playback.time;
    if (seekRef.current) seekRef.current.value = String(seconds);
    const label = `${clock(seconds)} / ${clock(duration)}`;
    if (timeRef.current && timeRef.current.textContent !== label) timeRef.current.textContent = label;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || hidden) return;
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#28342d';
    ctx.fillRect(0, height / 2, width, 1);
    view.draw(ctx, width, height);
    if (!view.span) return;
    drawTrimOverlay(ctx, view, width, height, analysis, selection, {
      x: width / (canvas.clientWidth || width), y: height / (canvas.clientHeight || height),
    });
    const position = view.xAt(seconds, width);
    if (position >= 0 && position <= width) {
      ctx.fillStyle = '#e5a46e';
      ctx.fillRect(Math.min(width - 2, position), 0, 2, height);
      ctx.beginPath();
      ctx.moveTo(position - 6, 0);
      ctx.lineTo(position + 6, 0);
      ctx.lineTo(position, 9);
      ctx.fill();
    }
  }

  useLayoutEffect(() => {
    refreshPosition.current = updatePosition;
    updatePosition();
  });

  useLayoutEffect(() => {
    if (hidden || !canvasRef.current) return;
    const observer = new ResizeObserver(() => refreshPosition.current());
    observer.observe(canvasRef.current);
    return () => observer.disconnect();
  }, [hidden]);

  // The media clock and playhead update without rendering the panel each frame.
  useLayoutEffect(() => {
    if (hidden || !active) return;
    let frame = requestAnimationFrame(function tick() {
      refreshPosition.current();
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [hidden, active]);

  function updateBoundary(boundary: Boundary, value: string) {
    if (bounds[boundary] !== value) onBounds({ ...bounds, [boundary]: value });
  }

  function formatBoundary(boundary: Boundary) {
    const frame = boundary === 'start' ? startFrame : endFrame;
    if (Number.isSafeInteger(frame)) updateBoundary(boundary, frameSeconds(frame, sampleRate));
  }

  function seek(seconds: number) {
    if (busy) return;
    playback.seek(seconds);
    updatePosition();
  }

  function moveWavePointer(event: PointerEvent<HTMLCanvasElement>) {
    if (busy || !dragMode.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const seconds = view.timeAt(fraction);
    if (dragMode.current === 'seek') seek(seconds);
    else updateBoundary(dragMode.current, frameSeconds(Math.round(seconds * sampleRate), sampleRate));
  }

  function beginWaveDrag(event: PointerEvent<HTMLCanvasElement>) {
    if (busy || event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const distance = (frame: number) => {
      const position = view.xAt(frame / sampleRate, rect.width);
      return position >= 0 && position <= rect.width ? Math.abs(x - position) : Infinity;
    };
    const start = distance(startFrame), end = distance(endFrame);
    dragMode.current = Math.min(start, end) > 12 ? 'seek' : start <= end ? 'start' : 'end';
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    moveWavePointer(event);
  }

  const endWaveDrag = () => { dragMode.current = undefined; };
  function zoomSelection() {
    const start = Number(bounds.start), end = Number(bounds.end);
    if (end > start) view.set(start - (end - start) * .05, (end - start) * 1.1);
  }

  return (
    <section id="panel-trim" className="trim-section" role="tabpanel" aria-labelledby="tab-trim" hidden={hidden}>
      <div>
        <div className="section-head"><h2 id="trim-heading" tabIndex={-1} ref={heading}>クリップ範囲を確認する</h2><span id="status" className="status">{analysis.status === 'ready' ? '自動検出 · 確認してください' : '要確認 · 手動調整してください'}</span></div>
        <p>自動検出は目安です。開始と終了を試聴し、残したい範囲に調整してください。</p>
        <div className="wave-tools" role="group" aria-label="波形の拡大表示">
          <button id="zoom-in" className="secondary" aria-label="波形を拡大" disabled={view.span <= Math.min(.1, duration) + 1e-9} onClick={() => view.zoom(2, playback.time)}>＋</button><button id="zoom-out" className="secondary" aria-label="波形を縮小" disabled={view.span >= duration} onClick={() => view.zoom(.5, playback.time)}>−</button><output id="zoom-level" aria-label="波形の拡大率">{(duration / view.span || 1).toFixed(1)}×</output>
          <button id="zoom-all" className="secondary" onClick={() => view.set(0, duration)}>全体</button><button id="zoom-selection" className="secondary" onClick={zoomSelection}>選択範囲</button>
        </div>
      </div>
      <div className="wave-visual">
        <div className="wave-labels"><span id="wave-start-label">{preciseClock(view.start)}</span><span id="duration-label">{preciseClock(view.end)}</span></div>
        <canvas id="wave" width="1200" height="240" role="img" aria-label="録音の波形と保存範囲" aria-describedby="wave-instructions" ref={canvasRef}
          onPointerDown={beginWaveDrag} onPointerMove={moveWavePointer} onPointerUp={endWaveDrag}
          onPointerCancel={endWaveDrag} onLostPointerCapture={endWaveDrag}>開始・終了は下の数値入力、再生位置はスライダーで変更できます。</canvas>
      </div>
      <div>
        <div className="range-inputs">
          {boundaries.map(([boundary, label]) => (
            <div key={boundary} className="boundary-controls">
              <label>{label}（秒）<input id={boundary} type="number" min="0" step="0.01" disabled={busy}
                value={bounds[boundary]} onChange={event => updateBoundary(boundary, event.currentTarget.value)}
                onBlur={() => formatBoundary(boundary)} /></label>
              <button id={`zoom-${boundary}`} className="secondary" type="button"
                onClick={() => view.set(Number(bounds[boundary]) - 2.5, 5)}>{label}付近</button>
              <button id={`set-${boundary}`} className="secondary" type="button" disabled={busy}
                onClick={() => updateBoundary(boundary, frameSeconds(Math.max(0, Math.min(frames, Math.round(playback.time * sampleRate))), sampleRate))}>再生位置を{label}に</button>
            </div>
          ))}
          <span id="selection-length">{valid ? `${clock((endFrame - startFrame) / sampleRate)}を書き出し` : '範囲が不正です'}</span>
        </div>
        <label className="wave-pan-label">表示位置<input id="wave-pan" type="range" min="0" max={Math.max(0, duration - view.span)} value={view.start} step={Math.max(1 / sampleRate, view.span / 1000)}
          aria-label="波形の表示位置" disabled={view.span >= duration} onChange={event => view.set(Number(event.currentTarget.value), view.span)} /></label>
        <p id="wave-detail" className="wave-help" role="status">{view.worker ? '詳細な波形を読み込み中…' : view.error}</p>
        <div className="playback"><button id="play" className="secondary" aria-pressed={active === 'play'} disabled={busy || !!active} onClick={() => onPreview(playback.ended ? 0 : playback.time, 'play')}>▶ 再生</button><button id="stop" className="secondary" disabled={!active} onClick={() => playback.stop()}>■ 停止</button><output id="playback-time" htmlFor="seek" aria-live="off" ref={timeRef} /></div>
        <input id="seek" className="seek" type="range" min="0" max={duration} step="0.01" defaultValue={0} aria-label="再生位置" disabled={busy} ref={seekRef} onChange={event => seek(Number(event.currentTarget.value))} />
        <p id="wave-instructions" className="wave-help">波形を押すと再生位置が移動します。その位置を開始・終了に設定するか、緑の線をドラッグして範囲を調整できます。キーボードでは再生位置スライダーと開始・終了の数値入力を使えます。</p>
        <div className="trim-summary"><p id="trim-state" className="wave-help" role="status">{valid
          ? `${rangeLabel} · ${frameTime(startFrame, sampleRate)}–${frameTime(endFrame, sampleRate)} · ${(endFrame - startFrame).toLocaleString('ja-JP')}サンプル（終了位置は含みません）`
          : '開始・終了位置を確認してください。'}</p><button id="reset-trim" className="secondary" aria-describedby="reset-help" disabled={busy || reset}
          onClick={() => onBounds({ start: frameSeconds(defaultStart, sampleRate), end: frameSeconds(defaultEnd, sampleRate) })}>自動検出の範囲に戻す</button><p id="reset-help" className="wave-help">範囲を手動で変更すると、自動検出の範囲に戻せます。</p></div>
        <div className="controls"><button id="listen-start" className="secondary" aria-pressed={active === 'listen-start'} disabled={busy} onClick={() => onPreview(Number(bounds.start), 'listen-start')}>▶ 冒頭を試聴</button><button id="listen-end" className="secondary" aria-pressed={active === 'listen-end'} disabled={busy} onClick={() => onPreview(Math.max(0, Number(bounds.end) - 8), 'listen-end')}>▶ 終わりを試聴</button></div>
        <details className="wave-details">
          <summary>波形の凡例と検出候補</summary>
          <div className="wave-legend" aria-label="波形の凡例"><span className="legend-keep">明るい区間：保存</span><span className="legend-cut">暗い区間：カット</span><span className="legend-detected">点線：検出候補・自動境界</span><span className="legend-selected">緑の実線：保存境界</span></div>
          <div id="detection-markers" className="detection-markers" role="group" aria-label="自動検出の候補">
            {detectionMarkers.map(({ key, label, color }) => {
              const candidate = analysis[key];
              return (
                <button type="button" className="marker-item" key={key} data-marker={key}
                  style={{ '--marker-color': color } as CSSProperties} disabled={!candidate}
                  onClick={candidate ? () => view.set(candidate.frame / sampleRate - 2.5, 5) : undefined}>
                  {candidate ? `${label} ${frameTime(candidate.frame, sampleRate)} · 確度 ${confidence[candidate.confidence] || '要確認'}` : `${label}：未検出`}
                </button>
              );
            })}
          </div>
          <p id="break-info" className="wave-help">{gaps.length
            ? `楽章間候補 ${gaps.length}か所（切り出し範囲内は保持）: ${gaps.map(gap => `${frameTime(gap.start_frame, sampleRate)}–${frameTime(gap.end_frame, sampleRate)}`).join(' / ')}`
            : '範囲内の音声・無音は連続して保持します。'}</p>
        </details>
      </div>
    </section>
  );
}
