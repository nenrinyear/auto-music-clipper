import type { Plan, Wav } from './audio-jobs';

export type PreviewButton = 'play' | 'listen-start' | 'listen-end';
type Prepared = { key: string; url: string; startFrame: number; frames: number };
type Measurement = { key: string; gain: number };

export class Playback {
  private player?: HTMLAudioElement;
  private url?: string;
  private wav?: Wav;
  private context?: AudioContext;
  private source?: MediaElementAudioSourceNode;
  private gain?: GainNode;
  private offset = 0;
  private processedFrames?: number;
  private prepared?: Prepared;
  private request = 0;

  constructor(private onActive: (button: PreviewButton | undefined) => void) {}

  load(file: File, wav: Wav) {
    this.wav = wav;
    this.url = URL.createObjectURL(file);
    const audio = this.player = new Audio(this.url);
    audio.preload = 'metadata';
    audio.onended = () => {
      if (this.player === audio) this.stop();
    };
  }

  get time() { return (this.player?.currentTime || 0) + this.offset; }
  get ended() { return this.player?.ended; }

  stop() {
    this.request++;
    this.player?.pause();
    this.onActive(undefined);
  }

  seek(seconds: number) {
    if (!this.player || !this.wav) return;
    const duration = (this.processedFrames ?? this.wav.frames) / this.wav.sampleRate;
    this.player.currentTime = Math.max(0, Math.min(duration, seconds - this.offset));
  }

  restoreOriginal() {
    if (this.processedFrames === undefined || !this.player || !this.url) return;
    const position = this.time;
    this.player.src = this.url;
    this.offset = 0;
    this.processedFrames = undefined;
    this.seek(position);
  }

  async play(seconds: number, button: PreviewButton, plan: Plan, callbacks: {
    prepare: () => Promise<{ blob: Blob; gain: number; frames: number }>;
    measure: () => Promise<{ gain: number }>;
    measurement?: Measurement;
    onMeasured: (value: Measurement) => void;
  }) {
    const audio = this.player, wav = this.wav;
    if (!audio || !wav) return;
    const request = ++this.request;
    const current = () => request === this.request && audio === this.player;
    const key = JSON.stringify(plan);
    this.onActive(button);
    audio.pause();
    this.seek(seconds);
    try {
      const context = this.context ??= new AudioContext();
      if (!this.source) {
        this.gain = context.createGain();
        this.gain.gain.value = 0;
        this.source = context.createMediaElementSource(audio);
        this.source.connect(this.gain).connect(context.destination);
      }
      // Resume within the click gesture, before waiting for the worker.
      await context.resume();
      if (!current()) return;
      let gain = 1;
      if (plan.eq === 'rode-m5') {
        if (this.prepared?.key !== key) {
          const result = await callbacks.prepare();
          if (audio !== this.player) return;
          if (this.prepared) URL.revokeObjectURL(this.prepared.url);
          this.prepared = { key, url: URL.createObjectURL(result.blob), startFrame: plan.startFrame, frames: result.frames };
          callbacks.onMeasured({ key, gain: result.gain });
        }
        if (!current()) return;
        if (audio.src !== this.prepared.url) audio.src = this.prepared.url;
        this.offset = this.prepared.startFrame / wav.sampleRate;
        this.processedFrames = this.prepared.frames;
      } else {
        this.restoreOriginal();
        if (plan.normalize) {
          if (callbacks.measurement?.key === key) gain = callbacks.measurement.gain;
          else {
            ({ gain } = await callbacks.measure());
            if (audio === this.player) callbacks.onMeasured({ key, gain });
          }
        }
      }
      if (!current()) return;
      this.seek(seconds);
      this.gain!.gain.setValueAtTime(gain, context.currentTime);
      await audio.play();
    } catch (error) {
      if (!current()) return;
      this.stop();
      throw error;
    }
  }

  clear() {
    this.stop();
    this.source?.disconnect();
    this.gain?.disconnect();
    this.source = undefined;
    this.gain = undefined;
    if (this.player) {
      this.player.onended = null;
      this.player.removeAttribute('src');
      this.player.load();
    }
    if (this.url) URL.revokeObjectURL(this.url);
    if (this.prepared) URL.revokeObjectURL(this.prepared.url);
    this.player = undefined;
    this.wav = undefined;
    this.url = undefined;
    this.prepared = undefined;
    this.offset = 0;
    this.processedFrames = undefined;
  }

  dispose() {
    this.clear();
    void this.context?.close().catch(() => {});
    this.context = undefined;
  }
}
