use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AudioError {
    #[error("channel count must be 1 or 2")]
    InvalidChannels,
    #[error("audio chunk has an incomplete frame")]
    IncompleteFrame,
    #[error("audio contains a non-finite sample at frame {frame}, channel {channel}")]
    NonFiniteSample { frame: u64, channel: usize },
    #[error("analyzer has already been finished")]
    AlreadyFinished,
    #[error("invalid output bounds")]
    InvalidBounds,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct AnalysisConfig {
    pub pre_roll_ms: u32,
    pub post_roll_ms: u32,
    pub applause_guard_ms: u32,
    pub min_music_seconds: f32,
}

impl Default for AnalysisConfig {
    fn default() -> Self {
        Self {
            pre_roll_ms: 1000,
            post_roll_ms: 200,
            applause_guard_ms: 50,
            min_music_seconds: 0.2,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct FeatureFrame {
    pub center_frame: u64,
    pub rms_db: f32,
    pub peak: f32,
    pub flatness: f32,
    pub flux: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Candidate {
    pub frame: u64,
    pub confidence: Confidence,
    pub reason: String,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    High,
    Medium,
    Low,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Ready,
    NeedsReview,
    NoMusic,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PossibleBreak {
    pub start_frame: u64,
    pub end_frame: u64,
    pub duration_seconds: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AnalysisReport {
    pub schema_version: u32,
    pub algorithm_version: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub total_frames: u64,
    pub status: Status,
    pub estimated_noise_floor_db: Option<f32>,
    pub music_start: Option<Candidate>,
    pub last_music_end: Option<Candidate>,
    pub tail_end: Option<Candidate>,
    pub final_applause_start: Option<Candidate>,
    pub start_frame: Option<u64>,
    pub end_frame: Option<u64>,
    pub possible_breaks: Vec<PossibleBreak>,
    pub issues: Vec<String>,
    #[serde(skip)]
    pub features: Vec<FeatureFrame>,
}
