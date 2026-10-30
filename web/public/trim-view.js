import { RATE } from './audio-processing.js';

export const detectionMarkers = [
  { key: 'music_start', label: '演奏開始候補', color: '#80c9ec' },
  { key: 'tail_end', label: '余韻終了候補', color: '#c5a2ee' },
  { key: 'final_applause_start', label: '拍手開始候補', color: '#ff9a86' },
];

export function selectionFrames(start, end) {
  const frame = value => String(value).trim() === '' ? NaN : Math.round(Number(value) * RATE);
  return { startFrame: frame(start), endFrame: frame(end) };
}

// Eight decimal places retain every integer frame at 48 kHz on round-trip.
export const frameSeconds = frame => (frame / RATE).toFixed(8).replace(/\.?0+$/, '');
export function frameTime(frame) {
  const seconds = Math.floor(frame / RATE), fraction = Math.round((frame % RATE) * 1_000_000 / RATE);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}.${String(fraction).padStart(6, '0')}`;
}

export function drawTrimOverlay(ctx, view, width, height, report, selection) {
  const { startFrame, endFrame } = selection;
  if (!Number.isSafeInteger(startFrame) || !Number.isSafeInteger(endFrame) || endFrame <= startFrame) return;
  const xAt = frame => view.xAt(frame / RATE, width);
  const a = xAt(startFrame), b = xAt(endFrame);
  const left = Math.max(0, Math.min(width, a)), right = Math.max(0, Math.min(width, b));
  ctx.save();
  ctx.fillStyle = 'rgba(212,239,131,.07)'; ctx.fillRect(left, 0, Math.max(0, right - left), height);
  ctx.fillStyle = 'rgba(12,17,14,.7)'; ctx.fillRect(0, 0, left, height); ctx.fillRect(right, 0, width - right, height);
  for (const gap of report?.possible_breaks || []) {
    const x = Math.max(left, xAt(gap.start_frame)), end = Math.min(right, xAt(gap.end_frame));
    if (end <= x) continue;
    ctx.fillStyle = 'rgba(128,201,236,.10)'; ctx.fillRect(x, 0, end - x, height);
    if (end - x > 150) { ctx.fillStyle = '#a7bcbf'; ctx.font = '13px sans-serif'; ctx.fillText('楽章間候補（保持）', x + 5, height - 28); }
  }
  const line = (frame, color, dash, text, y) => {
    if (!Number.isSafeInteger(frame)) return;
    const x = xAt(frame);
    if (x < 0 || x > width) return;
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash(dash);
    ctx.beginPath(); ctx.moveTo(Math.min(width - 1, x), 0); ctx.lineTo(Math.min(width - 1, x), height); ctx.stroke();
    if (text) {
      ctx.font = '13px sans-serif';
      const labelX = Math.max(3, Math.min(width - ctx.measureText(text).width - 3, x + 5));
      ctx.fillStyle = '#111714'; ctx.fillRect(labelX - 2, y - 12, ctx.measureText(text).width + 4, 16);
      ctx.fillStyle = color; ctx.fillText(text, labelX, y);
    }
  };
  line(report?.start_frame, '#a4afa6', [3, 5]);
  line(report?.end_frame, '#a4afa6', [3, 5]);
  detectionMarkers.forEach(({ key, label, color }, i) => line(report?.[key]?.frame, color, [7, 4], label, 15 + i * 19));
  line(startFrame, '#d4ef83', [], startFrame === report?.start_frame ? '保存開始' : '保存開始（手動）', height - 7);
  line(endFrame, '#d4ef83', [], endFrame === report?.end_frame ? '保存終了' : '保存終了（手動）', height - 7);
  ctx.restore();
}
