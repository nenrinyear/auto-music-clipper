/* @ts-self-types="./audio_wasm.d.ts" */
import * as wasm from "./audio_wasm_bg.wasm";
import { __wbg_set_wasm } from "./audio_wasm_bg.js";

__wbg_set_wasm(wasm);
wasm.__wbindgen_start();
export {
    WasmAnalyzer, analyze_features, apply_gain, finish_analysis, measure_chunk_peak
} from "./audio_wasm_bg.js";
