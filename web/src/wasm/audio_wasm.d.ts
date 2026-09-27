/* tslint:disable */
/* eslint-disable */

/**
 * Chunk-oriented WASM API. Call push() repeatedly with interleaved 48 kHz
 * float32 frames, then finish() to receive the report as JSON.
 */
export class WasmAnalyzer {
    free(): void;
    [Symbol.dispose](): void;
    finish(): string;
    constructor(channels: number);
    push(chunk: Float32Array): void;
}

/**
 * Extract a time-aligned chunk of the whole-recording feature timeline.
 * Each 24-byte record is frame:u64 followed by four little-endian f32 values.
 */
export function analyze_features(samples: Float32Array, channels: number, source_start: number, keep_start: number, keep_end: number): Uint8Array;

/**
 * Apply the same gain to every interleaved channel without changing balance.
 */
export function apply_gain(samples: Float32Array, gain: number): Float32Array;

/**
 * Build the whole-song result from ordered compact feature chunks.
 */
export function finish_analysis(channels: number, total_frames: number, packed_features: Uint8Array): string;

/**
 * Measure a chunk peak in Rust so the Worker can find one shared stereo gain.
 */
export function measure_chunk_peak(samples: Float32Array): number;
