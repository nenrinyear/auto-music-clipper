//! Audio feature extraction, performance detection, and linked-channel rendering.

mod detection;
mod features;
mod render;
mod types;

pub use detection::build_analysis_report;
pub use features::{analyze_feature_chunk, Analyzer};
pub use render::{measure_peak, render, PeakMeasurement, RenderPlan};
pub use types::{
    AnalysisConfig, AnalysisReport, AudioError, Candidate, Confidence, FeatureFrame, PossibleBreak,
    Status,
};

pub const SAMPLE_RATE: u32 = 48_000;

#[cfg(test)]
mod tests;
