import { M5_PROFILE } from './m5-profile.js';
export { M5_PROFILE };

// A separate delay state for every channel, with identical fixed coefficients.
// Float64 arithmetic and retained state make chunk boundaries inaudible.
export class M5Equalizer {
  constructor(channels) {
    if (![1, 2].includes(channels)) throw Error('EQのチャンネル数が不正です。');
    this.channels = channels;
    this.state = M5_PROFILE.design.bands.map(() => new Float64Array(channels * 2));
  }
  process(samples) {
    if (samples.length % this.channels) throw Error('EQのサンプル数が不正です。');
    const output = new Float64Array(samples);
    if (!output.every(Number.isFinite)) throw Error('EQの入力に不正なサンプルが含まれています。');
    M5_PROFILE.design.bands.forEach(({ coefficients: [b0, b1, b2, a1, a2] }, band) => {
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
