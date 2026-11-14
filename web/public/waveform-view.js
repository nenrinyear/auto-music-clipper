// View coordinates are independent of trim bounds and the full-recording seek bar.
export class WaveformView {
  constructor(onChange) {
    this.onChange = onChange;
    this.start = 0; this.end = 0;
  }
  reset(file, wav, overview = []) {
    this.worker?.terminate(); this.worker = undefined;
    this.file = file; this.wav = wav; this.overview = overview;
    this.start = 0; this.end = wav ? wav.frames / wav.sampleRate : 0;
    this.peaks = undefined; this.error = undefined;
  }
  get span() { return this.end - this.start; }
  get duration() { return this.wav ? this.wav.frames / this.wav.sampleRate : 0; }
  set(start, span) {
    if (!this.wav) return;
    const minSpan = Math.min(.1, this.duration);
    span = Math.max(minSpan, Math.min(this.duration, span));
    this.start = Math.max(0, Math.min(this.duration - span, start));
    this.end = this.start + span;
    this.peaks = undefined; this.error = undefined;
    this.worker?.terminate(); this.worker = undefined;
    this.onChange();
    if (span >= this.duration) return;
    const worker = this.worker = new Worker(new URL('./waveform-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (this.worker !== worker) return;
      this.worker = undefined; worker.terminate();
      this.error = data.error;
      this.peaks = data.peaks;
      this.onChange();
    };
    worker.onerror = event => {
      event.preventDefault();
      if (this.worker !== worker) return;
      this.worker = undefined; worker.terminate();
      this.error = '詳細な波形を読み込めませんでした。拡大操作をやり直してください。';
      this.onChange();
    };
    this.error = undefined;
    worker.postMessage({ file: this.file, plan: {
      startFrame: Math.floor(this.start * this.wav.sampleRate),
      endFrame: Math.min(this.wav.frames, Math.ceil(this.end * this.wav.sampleRate)), bins: 1200,
    } });
    this.onChange();
  }
  zoom(factor, focus) {
    const position = focus >= this.start && focus <= this.end ? focus : this.start + this.span / 2;
    const fraction = this.span ? (position - this.start) / this.span : .5;
    const span = Math.max(Math.min(.1, this.duration), Math.min(this.duration, this.span / factor));
    this.set(position - span * fraction, span);
  }
  timeAt(fraction) { return this.start + fraction * this.span; }
  xAt(seconds, width) { return (seconds - this.start) / this.span * width; }
  draw(ctx, width, height) {
    if (!this.span) return;
    const peaks = this.peaks || this.overview;
    const sourceStart = this.peaks ? this.start : 0;
    const sourceSpan = this.peaks ? this.span : this.duration;
    const step = sourceSpan / peaks.length;
    ctx.fillStyle = '#65766a';
    for (let i = 0; i < peaks.length; i++) {
      const x = this.xAt(sourceStart + i * step, width), barWidth = step / this.span * width;
      if (x + barWidth < 0 || x > width) continue;
      const barHeight = Math.max(1, Math.min(height * .45, peaks[i] * height * .45));
      ctx.fillRect(x, height / 2 - barHeight, Math.max(1, barWidth * .8), barHeight * 2);
    }
  }
}
