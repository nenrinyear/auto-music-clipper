import { M5_PROFILE } from './m5-profile.js';
export { M5_PROFILE };

// A separate delay state for every channel, with identical coefficients.
// Float64 arithmetic and retained state make chunk boundaries inaudible.
export class M5Equalizer {
  constructor(channels, sampleRate = M5_PROFILE.design.sampleRate) {
    if (![1, 2].includes(channels)) throw Error('EQのチャンネル数が不正です。');
    this.channels = channels;
    this.bands = M5_PROFILE.design.bands.filter(({ frequency }) => frequency < sampleRate / 2).map(band => {
      if (sampleRate === M5_PROFILE.design.sampleRate) return band.coefficients;
      const angle = 2 * Math.PI * band.frequency / sampleRate;
      const alpha = Math.sin(angle) / (2 * band.q), amplitude = 10 ** (band.gainDb / 40);
      const middle = -2 * Math.cos(angle);
      return [1 + alpha * amplitude, middle, 1 - alpha * amplitude, middle, 1 - alpha / amplitude]
        .map(value => value / (1 + alpha / amplitude));
    });
    this.state = this.bands.map(() => new Float64Array(channels * 2));
  }
  process(samples) {
    if (samples.length % this.channels) throw Error('EQのサンプル数が不正です。');
    const output = new Float64Array(samples);
    if (!output.every(Number.isFinite)) throw Error('EQの入力に不正なサンプルが含まれています。');
    this.bands.forEach(([b0, b1, b2, a1, a2], band) => {
      const state = this.state[band];
      for (let i = 0; i < output.length; i++) {
        const channel = i % this.channels, s = channel * 2, input = output[i];
        const value = b0 * input + state[s];
        state[s] = b1 * input - a1 * value + state[s + 1];
        state[s + 1] = b2 * input - a2 * value;
        output[i] = value;
      }
    });
    return new Float32Array(output);
  }
}
