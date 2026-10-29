use audio_core::{
    analyze_feature_chunk, build_analysis_report, AnalysisConfig, Analyzer, FeatureFrame,
};
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

/// Extract a time-aligned chunk of the whole-recording feature timeline.
/// Each 24-byte record is frame:u64 followed by four little-endian f32 values.
#[wasm_bindgen]
pub fn analyze_features(
    samples: &[f32],
    channels: u32,
    source_start: u32,
    keep_start: u32,
    keep_end: u32,
) -> Result<Vec<u8>, JsValue> {
    let features = analyze_feature_chunk(
        samples,
        channels as usize,
        source_start as u64,
        keep_start as u64,
        keep_end as u64,
    )
    .map_err(js_error)?;
    Ok(encode_features(&features))
}

/// Build the whole-song result from ordered compact feature chunks.
#[wasm_bindgen]
pub fn finish_analysis(
    channels: u32,
    total_frames: u32,
    packed_features: &[u8],
) -> Result<String, JsValue> {
    let features = decode_features(packed_features)?;
    let report = build_analysis_report(channels as usize, total_frames as u64, features)
        .map_err(js_error)?;
    serde_json::to_string(&report).map_err(js_error)
}

/// Measure a chunk peak in Rust so the browser can find one shared stereo gain.
#[wasm_bindgen]
pub fn measure_chunk_peak(samples: &[f32]) -> Result<f64, JsValue> {
    samples.iter().enumerate().try_fold(0.0_f64, |peak, (i, sample)| {
        if !sample.is_finite() {
            return Err(JsValue::from_str(&format!("non-finite sample at {i}")));
        }
        Ok(peak.max(sample.abs() as f64))
    })
}

/// Apply the same gain to every interleaved channel without changing balance.
#[wasm_bindgen]
pub fn apply_gain(samples: &[f32], gain: f64) -> Result<Vec<f32>, JsValue> {
    if !gain.is_finite() || gain < 0.0 {
        return Err(JsValue::from_str("invalid gain"));
    }
    samples
        .iter()
        .enumerate()
        .map(|(i, sample)| {
            if !sample.is_finite() {
                return Err(JsValue::from_str(&format!("non-finite sample at {i}")));
            }
            Ok((*sample as f64 * gain) as f32)
        })
        .collect()
}

fn encode_features(features: &[FeatureFrame]) -> Vec<u8> {
    let mut out = Vec::with_capacity(features.len() * 24);
    for f in features {
        out.extend_from_slice(&f.center_frame.to_le_bytes());
        out.extend_from_slice(&f.rms_db.to_le_bytes());
        out.extend_from_slice(&f.peak.to_le_bytes());
        out.extend_from_slice(&f.flatness.to_le_bytes());
        out.extend_from_slice(&f.flux.to_le_bytes());
    }
    out
}

fn decode_features(bytes: &[u8]) -> Result<Vec<FeatureFrame>, JsValue> {
    if !bytes.len().is_multiple_of(24) {
        return Err(JsValue::from_str("packed feature data has an invalid length"));
    }
    Ok(bytes
        .chunks_exact(24)
        .map(|row| FeatureFrame {
            center_frame: u64::from_le_bytes(row[0..8].try_into().unwrap()),
            rms_db: f32::from_le_bytes(row[8..12].try_into().unwrap()),
            peak: f32::from_le_bytes(row[12..16].try_into().unwrap()),
            flatness: f32::from_le_bytes(row[16..20].try_into().unwrap()),
            flux: f32::from_le_bytes(row[20..24].try_into().unwrap()),
        })
        .collect())
}

fn js_error(error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&error.to_string())
}
