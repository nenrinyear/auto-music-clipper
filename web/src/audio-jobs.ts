import { parseWav } from './audio-processing.js';
import { selectionFrames } from './trim-view.js';

export type Wav = Awaited<ReturnType<typeof parseWav>>;
export type Plan = ReturnType<typeof selectionFrames> & {
  targetDb: number;
  normalize: boolean;
  eq: 'rode-m5' | 'none';
};
type Marker = { frame: number; confidence: string };
export type Analysis = {
  waveform: number[];
  status: string;
  start_frame?: number | null;
  end_frame?: number | null;
  music_start?: Marker | null;
  tail_end?: Marker | null;
  final_applause_start?: Marker | null;
  possible_breaks?: { start_frame: number; end_frame: number }[];
};
type Results = {
  analyze: Analysis;
  measure: { gain: number };
  preview: { gain: number; blob: Blob; frames: number };
  render: { blob: Blob };
};
type Job = keyof Results;
type Progress = { phase: 'analyze' | 'measure' | 'render'; fraction: number };
type Reply = { id: number; progress?: Progress; error?: string; result?: Results[Job] };

const phases = { analyze: '端末内で解析中', measure: 'ピークを測定中', render: 'WAVを書き出し中' };

export class AudioJobs {
  private worker?: Worker;
  private id = 0;
  private cancel?: () => void;

  run<T extends Job>(type: T, file: File, onProgress: (message: string) => void, plan?: Plan) {
    return new Promise<Results[T]>((resolve, reject) => {
      if (this.cancel) {
        reject(Error('処理が完了するまでお待ちください。'));
        return;
      }
      const worker = this.worker ??= new Worker(new URL('./audio-worker.js', import.meta.url), { type: 'module' });
      const id = ++this.id;
      this.cancel = () => reject(new DOMException('処理を中止しました。', 'AbortError'));
      worker.onmessage = ({ data }: MessageEvent<Reply>) => {
        if (data.id !== id) return;
        if (data.progress) {
          const label = type === 'preview' && data.progress.phase === 'render'
            ? 'EQを反映した試聴音声を準備中' : phases[data.progress.phase];
          onProgress(`${label}… ${Math.floor(data.progress.fraction * 100)}%`);
          return;
        }
        this.cancel = undefined;
        if (data.error) reject(Error(data.error));
        else resolve(data.result as Results[T]);
      };
      worker.onerror = event => {
        event.preventDefault();
        this.cancel = undefined;
        this.dispose();
        reject(Error('音声処理を起動できませんでした。ページを再読み込みしてお試しください。'));
      };
      try {
        worker.postMessage({ id, type, file, plan });
      } catch (error) {
        this.cancel = undefined;
        reject(error);
      }
    });
  }

  dispose() {
    this.worker?.terminate();
    this.worker = undefined;
    this.cancel?.();
    this.cancel = undefined;
  }
}
