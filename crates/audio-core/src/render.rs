use serde::{Deserialize, Serialize};
use std::f64::consts::PI;

use crate::{AudioError, SAMPLE_RATE};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RenderPlan {
    pub start_frame: u64,
    pub end_frame: u64,
    pub normalize: bool,
    pub target_peak_dbfs: f64,
    pub max_gain_db: f64,
    pub fade_in_ms: u32,
    pub fade_out_ms: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PeakMeasurement {
    pub input_peak: f64,
    pub gain: f64,
    pub output_peak: f64,
    pub gain_limited: bool,
}

impl RenderPlan {
    /// Fade multiplier at a frame relative to the selected region's start.
    /// Requires valid bounds and `position < end_frame - start_frame`.
    pub fn fade_at(&self, position: u64) -> f64 {
        let length = self.end_frame - self.start_frame;
        let fade_in = self.fade_in_ms as u64 * (SAMPLE_RATE / 1000) as u64;
        let fade_out = self.fade_out_ms as u64 * (SAMPLE_RATE / 1000) as u64;
        let mut fade = 1.0;
        if fade_in > 1 && position < fade_in {
            fade *= ((PI * position as f64 / (2.0 * (fade_in - 1) as f64)).sin()).powi(2);
        }
        if fade_out > 1 && length - position <= fade_out {
            let i = length - position - 1;
            fade *= ((PI * i as f64 / (2.0 * (fade_out - 1) as f64)).sin()).powi(2);
        }
        fade
    }

    /// Calculate linked-channel gain from a finite, nonnegative peak measured
    /// after fades, retaining unity gain for silence or disabled normalization.
    pub fn normalization_for_peak(&self, peak: f64) -> PeakMeasurement {
        let target = 10.0_f64.powf(self.target_peak_dbfs / 20.0);
        let cap = 10.0_f64.powf(self.max_gain_db / 20.0);
        let desired = if peak == 0.0 || !self.normalize {
            1.0
        } else {
            target / peak
        };
        let gain = if self.normalize {
            desired.min(cap)
        } else {
            1.0
        };
        PeakMeasurement {
            input_peak: peak,
            gain,
            output_peak: peak * gain,
            gain_limited: self.normalize && desired > cap,
        }
    }
}

pub fn measure_peak(
    samples: &[f32],
    channels: usize,
    plan: &RenderPlan,
) -> Result<PeakMeasurement, AudioError> {
    if !(1..=2).contains(&channels) || !samples.len().is_multiple_of(channels) {
        return Err(AudioError::InvalidBounds);
    }
    let frames = samples.len() / channels;
    if plan.start_frame >= plan.end_frame || plan.end_frame > frames as u64 {
        return Err(AudioError::InvalidBounds);
    }
    let mut peak = 0.0_f64;
    for frame in plan.start_frame..plan.end_frame {
        let fade = plan.fade_at(frame - plan.start_frame);
        for ch in 0..channels {
            let sample = samples[frame as usize * channels + ch];
            if !sample.is_finite() {
                return Err(AudioError::NonFiniteSample { frame, channel: ch });
            }
            peak = peak.max((sample as f64 * fade).abs());
        }
    }
    Ok(plan.normalization_for_peak(peak))
}

/// Applies a plan to an interleaved buffer. A caller may pass the full source
/// or use the same frame arithmetic on successive chunks.
pub fn render(
    samples: &[f32],
    channels: usize,
    plan: &RenderPlan,
    gain: f64,
) -> Result<Vec<f32>, AudioError> {
    if !(1..=2).contains(&channels) || !samples.len().is_multiple_of(channels) {
        return Err(AudioError::InvalidBounds);
    }
    let frames = samples.len() / channels;
    if plan.start_frame >= plan.end_frame || plan.end_frame > frames as u64 {
        return Err(AudioError::InvalidBounds);
    }
    let n = plan.end_frame - plan.start_frame;
    let fade_in = plan.fade_in_ms as u64 * 48;
    let fade_out = plan.fade_out_ms as u64 * 48;
    if fade_in.saturating_add(fade_out) > n {
        return Err(AudioError::InvalidBounds);
    }
    let mut out = Vec::with_capacity(n as usize * channels);
    for frame in plan.start_frame..plan.end_frame {
        let fade = plan.fade_at(frame - plan.start_frame);
        for ch in 0..channels {
            let sample = samples[frame as usize * channels + ch];
            if !sample.is_finite() {
                return Err(AudioError::NonFiniteSample { frame, channel: ch });
            }
            out.push((sample as f64 * fade * gain) as f32);
        }
    }
    Ok(out)
}
