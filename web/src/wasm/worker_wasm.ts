import * as bindings from "./audio_wasm_bg.js";
import wasmModule from "./audio_wasm_bg.wasm";
const wasmExports = new WebAssembly.Instance(wasmModule, { "./audio_wasm_bg.js": bindings }).exports;

bindings.__wbg_set_wasm(wasmExports);
(wasmExports as { __wbindgen_start: () => void }).__wbindgen_start();

export {
	WasmAnalyzer,
	analyze_features,
	apply_gain,
	finish_analysis,
	measure_chunk_peak,
} from "./audio_wasm_bg.js";
