use audio_core::{AnalysisConfig, Analyzer};
use wasm_bindgen::prelude::*;

/// Chunk-oriented WASM API. Call push() repeatedly with interleaved 48 kHz
/// float32 frames, then finish() to receive the report as JSON.
#[wasm_bindgen]
pub struct WasmAnalyzer {
    inner: Option<Analyzer>,
}

#[wasm_bindgen]
impl WasmAnalyzer {
    #[wasm_bindgen(constructor)]
    pub fn new(channels: u32) -> Result<WasmAnalyzer, JsValue> {
        let analyzer =
            Analyzer::new(channels as usize, AnalysisConfig::default()).map_err(js_error)?;
        Ok(Self {
            inner: Some(analyzer),
        })
    }

    pub fn push(&mut self, chunk: &[f32]) -> Result<(), JsValue> {
        self.inner
            .as_mut()
            .ok_or_else(|| JsValue::from_str("analyzer already finished"))?
            .push(chunk)
            .map_err(js_error)
    }

    pub fn finish(&mut self) -> Result<String, JsValue> {
        let analyzer = self
            .inner
            .take()
            .ok_or_else(|| JsValue::from_str("analyzer already finished"))?;
        let report = analyzer.finish().map_err(js_error)?;
        serde_json::to_string(&report).map_err(js_error)
    }
}

fn js_error(error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&error.to_string())
}
