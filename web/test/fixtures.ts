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

// Two movements with an intentional silent gap, followed by repeated applause.
export function makeConcertWav(): Buffer {
  const bytes = makeWav(8);
  bytes.fill(0, 44);
  for (const [start, end, frequency] of [[1, 2, 440], [5, 6, 660]]) {
    for (let frame = start * RATE; frame < end * RATE; frame++) {
      const sample = Math.sin(2 * Math.PI * frequency * frame / RATE) * .15;
      bytes.writeFloatLE(sample, 44 + frame * 8);
      bytes.writeFloatLE(sample * .5, 48 + frame * 8);
    }
  }
  let random = 7;
  for (let base = RATE * 6 + RATE / 3; base < RATE * 8; base += RATE / 3) {
    for (let frame = base; frame < Math.min(base + 1200, RATE * 8); frame++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const sample = ((random >>> 8) / 16777216 - .5) * .8;
      bytes.writeFloatLE(sample, 44 + frame * 8);
      bytes.writeFloatLE(sample * .5, 48 + frame * 8);
    }
  }
  return bytes;
}
