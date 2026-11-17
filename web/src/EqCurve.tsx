import { useMemo } from 'react';
import { M5Equalizer, M5_PROFILE } from './m5-eq.js';

const x = (frequency: number) => 40 + Math.log10(frequency / 20) / 3 * 454;
const y = (db: number) => 65 - db * 12;
const frequencyLabels = [[20, '20 Hz'], [100, '100'], [1000, '1 kHz'], [10000, '10 kHz'], [20000, '20 kHz']] as const;
const response = M5_PROFILE.source.response;

const points = (data: number[][]) => data.map(([frequency, db]) => `${x(frequency)},${y(db)}`).join(' ');

export function EqCurve({ sampleRate = M5_PROFILE.design.sampleRate }: { sampleRate?: number }) {
  const correction = useMemo(() => {
    const bands = new M5Equalizer(1, sampleRate).bands;
    const highest = Math.min(20000, sampleRate / 2);
    const frequencies = response.filter(([frequency]) => frequency < highest).map(([frequency]) => frequency);
    if (highest >= 20) frequencies.push(highest);
    return points(frequencies.map(frequency => {
      const angle = 2 * Math.PI * frequency / sampleRate;
      const cos = Math.cos(angle), sin = Math.sin(angle);
      const cos2 = Math.cos(2 * angle), sin2 = Math.sin(2 * angle);
      const db = bands.reduce((total: number, [b0, b1, b2, a1, a2]: number[]) => total + 20 * Math.log10(
        Math.hypot(b0 + b1 * cos + b2 * cos2, b1 * sin + b2 * sin2)
        / Math.hypot(1 + a1 * cos + a2 * cos2, a1 * sin + a2 * sin2)), 0);
      return [frequency, db];
    }));
  }, [sampleRate]);

  return (
    <svg id="eq-curve" viewBox="0 0 520 150" role="img" aria-label="M5の公称周波数特性と補正EQ。横軸は20 Hzから20 kHzの対数目盛、縦軸は−4 dBから＋4 dB。">
      {[-4, -2, 0, 2, 4].map(db => (
        <g key={db}>
          <line x1={x(20)} x2={x(20000)} y1={y(db)} y2={y(db)} stroke={db === 0 ? '#8b9d92' : '#43534b'} />
          <text x={34} y={y(db) + 4} textAnchor="end" fill="#eef2eb" fontSize={12}>{db > 0 ? '+' : ''}{db}</text>
        </g>
      ))}
      {frequencyLabels.map(([frequency, label]) => (
        <g key={frequency}>
          <line x1={x(frequency)} x2={x(frequency)} y1={y(4)} y2={y(-4)} stroke="#43534b" />
          <text x={x(frequency)} y={137} textAnchor="middle" fill="#eef2eb" fontSize={12}>{label}</text>
        </g>
      ))}
      <polyline points={points(response)} fill="none" stroke="#ff8984" strokeWidth={2} />
      <polyline points={correction} fill="none" stroke="#d4ef83" strokeWidth={2} strokeDasharray="6 3" />
    </svg>
  );
}
