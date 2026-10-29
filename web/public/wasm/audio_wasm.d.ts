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
 * Measure a chunk peak in Rust so the browser can find one shared stereo gain.
 */
export function measure_chunk_peak(samples: Float32Array): number;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_wasmanalyzer_free: (a: number, b: number) => void;
    readonly analyze_features: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly apply_gain: (a: number, b: number, c: number) => [number, number, number, number];
    readonly finish_analysis: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly measure_chunk_peak: (a: number, b: number) => [number, number, number];
    readonly wasmanalyzer_finish: (a: number) => [number, number, number, number];
    readonly wasmanalyzer_new: (a: number) => [number, number, number];
    readonly wasmanalyzer_push: (a: number, b: number, c: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
