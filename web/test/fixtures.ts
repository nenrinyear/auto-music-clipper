export const RATE = 48_000;

// Independent 44-byte float WAV fixture (the exporter writes a fact chunk too).
export function makeWav(seconds = 31, channels: 1 | 2 = 2): Buffer {
  const frames = Math.round(seconds * RATE);
  const bytes = Buffer.alloc(44 + frames * channels * 4);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(3, 20); bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(RATE, 24); bytes.writeUInt32LE(RATE * channels * 4, 28);
  bytes.writeUInt16LE(channels * 4, 32); bytes.writeUInt16LE(32, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  for (let i = 0; i < frames; i++) {
    const sample = i < RATE * 3 || i >= frames - RATE * 3 ? 0 : Math.sin(2 * Math.PI * 440 * i / RATE) * 0.25;
    bytes.writeFloatLE(sample, 44 + i * channels * 4);
    if (channels === 2) bytes.writeFloatLE(sample * 0.5, 48 + i * channels * 4);
  }
  return bytes;
}
