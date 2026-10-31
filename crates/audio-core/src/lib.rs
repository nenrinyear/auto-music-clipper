use rustfft::{num_complex::Complex, Fft, FftPlanner};
use serde::{Deserialize, Serialize};
use std::f64::consts::PI;
use std::sync::Arc;
use thiserror::Error;

pub const SAMPLE_RATE: u32 = 48_000;
const WINDOW: usize = 2048;
const HOP: usize = 480;

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

/// Stateful, chunk-independent feature extractor. It holds one analysis window,
/// not the source recording, in addition to compact feature frames.
pub struct Analyzer {
    channels: usize,
    config: AnalysisConfig,
    window: Vec<[f32; 2]>,
    total_frames: u64,
    features: Vec<FeatureFrame>,
    previous_spectrum: Vec<f64>,
    fft: Arc<dyn Fft<f64>>,
    spectrum: Vec<Complex<f64>>,
    right_spectrum: Vec<Complex<f64>>,
    power: Vec<f64>,
    hann: Vec<f64>,
    fft_scratch: Vec<Complex<f64>>,
    finished: bool,
}

impl Analyzer {
    pub fn new(channels: usize, config: AnalysisConfig) -> Result<Self, AudioError> {
        if !(1..=2).contains(&channels) {
            return Err(AudioError::InvalidChannels);
        }
        let fft = FftPlanner::<f64>::new().plan_fft_forward(WINDOW);
        let hann = (0..WINDOW)
            .map(|i| 0.5 - 0.5 * (2.0 * PI * i as f64 / (WINDOW - 1) as f64).cos())
            .collect();
        let fft_scratch = vec![Complex::new(0.0, 0.0); fft.get_inplace_scratch_len()];
        Ok(Self {
            channels,
            config,
            window: Vec::with_capacity(WINDOW),
            total_frames: 0,
            features: Vec::new(),
            previous_spectrum: Vec::new(),
            fft,
            spectrum: vec![Complex::new(0.0, 0.0); WINDOW],
            right_spectrum: vec![Complex::new(0.0, 0.0); WINDOW],
            power: vec![0.0; WINDOW / 2],
            hann,
            fft_scratch,
            finished: false,
        })
    }

    /// Push interleaved mono or stereo f32 samples. Chunk boundaries do not
    /// affect the emitted analysis windows.
    pub fn push(&mut self, samples: &[f32]) -> Result<(), AudioError> {
        if self.finished {
            return Err(AudioError::AlreadyFinished);
        }
        if !samples.len().is_multiple_of(self.channels) {
            return Err(AudioError::IncompleteFrame);
        }
        for frame in samples.chunks_exact(self.channels) {
            for (channel, sample) in frame.iter().enumerate() {
                if !sample.is_finite() {
                    return Err(AudioError::NonFiniteSample {
                        frame: self.total_frames,
                        channel,
                    });
                }
            }
            self.window.push([
                frame[0],
                if self.channels == 2 {
                    frame[1]
                } else {
                    frame[0]
                },
            ]);
            self.total_frames += 1;
            if self.window.len() == WINDOW {
                self.emit_feature(WINDOW);
                self.window.drain(..HOP);
            }
        }
        Ok(())
    }

    pub fn finish(mut self) -> Result<AnalysisReport, AudioError> {
        if self.finished {
            return Err(AudioError::AlreadyFinished);
        }
        self.finished = true;
        if !self.window.is_empty() {
            let valid = self.window.len();
            self.window.resize(WINDOW, [0.0, 0.0]);
            self.emit_feature(valid);
        }
        Ok(build_report(
            self.channels,
            self.total_frames,
            self.config,
            self.features,
        ))
    }

    fn emit_feature(&mut self, valid: usize) {
        let mut sum_sq = 0.0_f64;
        let mut peak = 0.0_f32;
        for i in 0..WINDOW {
            let win = self.hann[i];
            let l = self.window[i][0] as f64;
            let r = self.window[i][1] as f64;
            if i < valid {
                sum_sq += (l * l + r * r) / self.channels as f64;
                peak = peak.max(l.abs() as f32).max(r.abs() as f32);
            }
            self.spectrum[i].re = l * win;
            self.spectrum[i].im = 0.0;
        }
        // Combine channel powers rather than waveforms to avoid anti-phase cancellation.
        self.fft
            .process_with_scratch(&mut self.spectrum, &mut self.fft_scratch);
        for bin in 0..WINDOW / 2 {
            self.power[bin] = self.spectrum[bin].norm_sqr();
        }
        if self.channels == 2 {
            for i in 0..WINDOW {
                let win = self.hann[i];
                self.right_spectrum[i].re = self.window[i][1] as f64 * win;
                self.right_spectrum[i].im = 0.0;
            }
            self.fft
                .process_with_scratch(&mut self.right_spectrum, &mut self.fft_scratch);
            for bin in 0..WINDOW / 2 {
                self.power[bin] = (self.power[bin] + self.right_spectrum[bin].norm_sqr()) * 0.5;
            }
        }
        let arithmetic = self.power.iter().sum::<f64>() / self.power.len() as f64;
        let geometric = (self.power.iter().map(|p| p.max(1e-30).ln()).sum::<f64>()
            / self.power.len() as f64)
            .exp();
        let flatness = (geometric / arithmetic.max(1e-30)).clamp(0.0, 1.0) as f32;
        let total_power = self.power.iter().sum::<f64>().max(1e-30);
        let flux = if self.previous_spectrum.is_empty() {
            0.0
        } else {
            self.power
                .iter()
                .zip(&self.previous_spectrum)
                .map(|(now, old)| (now - old).max(0.0))
                .sum::<f64>()
                / total_power
        } as f32;
        if self.previous_spectrum.is_empty() {
            self.previous_spectrum.clone_from(&self.power);
        } else {
            self.previous_spectrum.copy_from_slice(&self.power);
        }
        let rms = (sum_sq / valid.max(1) as f64).sqrt();
        let rms_db = (20.0 * rms.max(1e-12).log10()) as f32;
        self.features.push(FeatureFrame {
            center_frame: self
                .total_frames
                .saturating_sub(valid as u64)
                .saturating_add((WINDOW / 2) as u64)
                .min(self.total_frames),
            rms_db,
            peak,
            flatness,
            flux,
        });
    }
}

/// Extracts only the feature frames whose windows start in `[keep_start, keep_end)`.
/// `samples` may include a preceding window and look-ahead audio so callers can
/// process large files in independent, overlapping chunks without changing the
/// feature timeline at chunk boundaries.
pub fn analyze_feature_chunk(
    samples: &[f32],
    channels: usize,
    source_start: u64,
    keep_start: u64,
    keep_end: u64,
) -> Result<Vec<FeatureFrame>, AudioError> {
    if !(1..=2).contains(&channels) || !samples.len().is_multiple_of(channels) {
        return Err(AudioError::InvalidBounds);
    }
    let hop = HOP as u64;
    let source_frames = (samples.len() / channels) as u64;
    let source_end = source_start.saturating_add(source_frames);
    if source_start % hop != 0
        || keep_start < source_start
        || keep_start >= keep_end
        || keep_end > source_end
    {
        return Err(AudioError::InvalidBounds);
    }
    let mut analyzer = Analyzer::new(channels, AnalysisConfig::default())?;
    analyzer.push(samples)?;
    let report = analyzer.finish()?;
    Ok(report
        .features
        .into_iter()
        .enumerate()
        .filter_map(|(index, mut feature)| {
            let window_start = source_start.saturating_add((index * HOP) as u64);
            if window_start >= keep_start && window_start < keep_end {
                feature.center_frame = source_start.saturating_add(feature.center_frame);
                Some(feature)
            } else {
                None
            }
        })
        .collect())
}

/// Builds the whole-recording decision after independently extracted feature
/// chunks have been reassembled in timeline order.
pub fn build_analysis_report(
    channels: usize,
    total_frames: u64,
    features: Vec<FeatureFrame>,
) -> Result<AnalysisReport, AudioError> {
    if !(1..=2).contains(&channels) {
        return Err(AudioError::InvalidChannels);
    }
    Ok(build_report(
        channels,
        total_frames,
        AnalysisConfig::default(),
        features,
    ))
}

fn build_report(
    channels: usize,
    total: u64,
    config: AnalysisConfig,
    features: Vec<FeatureFrame>,
) -> AnalysisReport {
    let mut issues = Vec::new();
    if features.is_empty() || total == 0 {
        return empty_report(channels, total, features, vec!["empty_audio".into()]);
    }
    let mut levels: Vec<f32> = features
        .iter()
        .map(|f| f.rms_db)
        .filter(|v| v.is_finite())
        .collect();
    levels.sort_by(|a, b| a.total_cmp(b));
    let floor = levels.get(levels.len() / 10).copied();
    if floor.is_none() {
        issues.push("noise_floor_uncertain".into());
    }
    let floor = floor.unwrap_or(-90.0);
    let active: Vec<bool> = features
        .iter()
        .map(|f| f.rms_db >= floor + 10.0 || (f.rms_db >= floor + 4.0 && f.flatness < 0.20))
        .collect();
    let components = active_components(&active, (SAMPLE_RATE / HOP as u32) as f32, 0.15);
    let min_frames = (config.min_music_seconds * (SAMPLE_RATE / HOP as u32) as f32).ceil() as usize;
    let plausible: Vec<(usize, usize)> = components
        .into_iter()
        .filter(|(s, e)| e.saturating_sub(*s) >= min_frames.max(1))
        .collect();
    if plausible.is_empty() {
        issues.push("music_not_found".into());
        return AnalysisReport {
            schema_version: 1,
            algorithm_version: "0.2.0-heuristic".into(),
            sample_rate: SAMPLE_RATE,
            channels: channels as u16,
            total_frames: total,
            status: Status::NoMusic,
            estimated_noise_floor_db: Some(floor),
            music_start: None,
            last_music_end: None,
            tail_end: None,
            final_applause_start: None,
            start_frame: None,
            end_frame: None,
            possible_breaks: vec![],
            issues,
            features,
        };
    }
    let first = plausible[0];
    let raw_last = *plausible.last().unwrap();
    // Room/microphone coloration makes real applause much less spectrally flat
    // than white-noise fixtures. Compare it with this recording's active sound.
    let mut active_flatness: Vec<f32> = features.iter()
        .filter(|f| f.rms_db > floor + 8.0)
        .map(|f| f.flatness).collect();
    active_flatness.sort_by(|a, b| a.total_cmp(b));
    let tonal_flatness = active_flatness.get(active_flatness.len() / 2).copied().unwrap_or(0.02);
    let clap_flatness = (tonal_flatness * 8.0).clamp(0.008, 0.20);
    let quiet_floor = levels.get(levels.len() / 100).copied().unwrap_or(floor);
    let clap_like = |idx: usize| {
        features[idx].rms_db > floor + 8.0
            && features[idx].flatness > clap_flatness
            && features[idx].flux > 0.15
    };
    // Several overlapping FFT windows of one cymbal hit are not several claps.
    let repeated_onsets = |start: usize, end: usize| {
        let mut count = 0;
        let mut next = start;
        for i in start..(start + 100).min(end) {
            if i >= next && clap_like(i) {
                count += 1;
                next = i + 8; // At least 80 ms between distinct attacks.
            }
        }
        count >= 3
    };
    // If the final active component contains repeated broadband onsets, treat it
    // as a possible applause region and keep the preceding music component.
    let repeated_clap_start = if plausible.len() > 1 {
        (raw_last.0..raw_last.1).find(|&i| {
            clap_like(i) && repeated_onsets(i, raw_last.1)
        })
    } else {
        None
    };
    let last = if repeated_clap_start.is_some() {
        plausible[plausible.len() - 2]
    } else {
        raw_last
    };
    let start_idx = first.0;
    let last_idx = last.1.saturating_sub(1).min(features.len() - 1);
    let mut possible_breaks = Vec::new();
    for pair in plausible.windows(2) {
        if pair[1].0 >= last.1 { continue; } // Do not label the pre-applause tail as a movement break.
        let a = features[pair[0].1.saturating_sub(1)].center_frame;
        let b = features[pair[1].0].center_frame;
        if b.saturating_sub(a) >= 2 * SAMPLE_RATE as u64 {
            possible_breaks.push(PossibleBreak {
                start_frame: a,
                end_frame: b,
                duration_seconds: (b - a) as f32 / SAMPLE_RATE as f32,
            });
        }
    }
    let music_start_frame = features[start_idx]
        .center_frame
        .saturating_sub(config.pre_roll_ms as u64 * 48);
    let start_frame = music_start_frame;
    let music_end_frame = features[last_idx].center_frame;
    // Require repeated broadband onsets before suggesting applause. A single
    // transient (for example a final cymbal) is not enough evidence.
    let candidate_clap = repeated_clap_start.or_else(|| {
        (last_idx + 1..features.len()).find(|&i| {
            clap_like(i) && repeated_onsets(i, features.len())
        })
    }).map(|anchor| {
        // Once repeated applause is established, include the quieter first
        // attacks preceding its loud portion, without searching back into music.
        let first = anchor.saturating_sub(200).max(last_idx + 1);
        (first..anchor).find(|&i| features[i].flatness > clap_flatness
            && features[i].flux > 0.15 && features[i].rms_db > quiet_floor)
            .unwrap_or(anchor)
    });
    let tail_search_end = candidate_clap.unwrap_or(features.len());
    let mut tail_idx = last_idx;
    let tail_threshold = quiet_floor + 6.0;
    let required_tail_frames = (800.0 / 10.0) as usize;
    let mut quiet_run = 0usize;
    let mut found_tail = false;
    for (idx, feature) in features
        .iter()
        .enumerate()
        .take(tail_search_end)
        .skip(last_idx)
    {
        if feature.rms_db <= tail_threshold {
            quiet_run += 1;
        } else {
            quiet_run = 0;
        }
        if quiet_run >= required_tail_frames {
            tail_idx = idx + 1 - quiet_run;
            found_tail = true;
            break;
        }
    }
    let tail_end = features[tail_idx.min(features.len() - 1)].center_frame;
    let natural_end = if found_tail {
        tail_end
            .saturating_add(config.post_roll_ms as u64 * 48)
            .min(total)
    } else if candidate_clap.is_some() {
        // With no confirmed quiet tail, retain the decay up to the applause
        // guard instead of cutting at the last sustained-music feature.
        total
    } else {
        total
    };
    let mut end_frame = natural_end;
    let applause = candidate_clap.map(|idx| {
        let frame = features[idx].center_frame;
        end_frame = end_frame.min(frame.saturating_sub(config.applause_guard_ms as u64 * 48));
        Candidate {
            frame,
            confidence: Confidence::Low,
            reason: "repeated_colored_broadband_onsets_after_music".into(),
        }
    });
    if applause.is_some() {
        issues.push("applause_candidate_needs_review".into());
    }
    if !found_tail {
        issues.push("tail_uncertain".into());
    }
    let has_quiet_preroll = start_idx >= 50
        && features[start_idx - 50..start_idx]
            .iter()
            .all(|f| f.rms_db <= floor + 6.0);
    let strong_start = features[start_idx].rms_db >= floor + 14.0;
    let start_conf = if has_quiet_preroll && strong_start {
        Confidence::High
    } else if start_idx > 2 {
        Confidence::Medium
    } else {
        Confidence::Low
    };
    let has_quiet_tail = found_tail
        && features.len().saturating_sub(tail_idx) >= 50
        && features[tail_idx..]
            .iter()
            .take(50)
            .all(|f| f.rms_db <= floor + 6.0);
    let end_conf = if !found_tail {
        Confidence::Low
    } else if has_quiet_tail && applause.is_none() {
        Confidence::High
    } else if tail_idx < features.len() - 1 {
        Confidence::Medium
    } else {
        Confidence::Low
    };
    if !has_quiet_preroll {
        issues.push("start_context_uncertain".into());
    }
    let music_start = Candidate {
        frame: features[start_idx].center_frame,
        confidence: start_conf,
        reason: "first_sustained_audio_candidate".into(),
    };
    let last_music_end = Candidate {
        frame: music_end_frame,
        confidence: Confidence::Low,
        reason: "last_sustained_audio_candidate".into(),
    };
    let tail = Candidate {
        frame: tail_end,
        confidence: end_conf,
        reason: if found_tail { "energy_returned_near_estimated_noise_floor" } else { "quiet_tail_not_confirmed_last_music_reference" }.into(),
    };
    if end_frame <= start_frame {
        issues.push("invalid_trim_bounds".into());
        end_frame = total;
    }
    let status =
        if issues.is_empty() && start_conf == Confidence::High && end_conf == Confidence::High {
            Status::Ready
        } else {
            Status::NeedsReview
        };
    AnalysisReport {
        schema_version: 1,
        algorithm_version: "0.2.0-heuristic".into(),
        sample_rate: SAMPLE_RATE,
        channels: channels as u16,
        total_frames: total,
        status,
        estimated_noise_floor_db: Some(floor),
        music_start: Some(music_start),
        last_music_end: Some(last_music_end),
        tail_end: Some(tail),
        final_applause_start: applause,
        start_frame: Some(start_frame),
        end_frame: Some(end_frame),
        possible_breaks,
        issues,
        features,
    }
}

fn active_components(
    active: &[bool],
    frames_per_second: f32,
    bridge_seconds: f32,
) -> Vec<(usize, usize)> {
    let max_gap = (frames_per_second * bridge_seconds) as usize;
    let mut raw = Vec::new();
    let mut start = None;
    for (i, &on) in active.iter().enumerate() {
        if on && start.is_none() {
            start = Some(i);
        }
        if !on {
            if let Some(s) = start {
                if i.saturating_sub(s) > max_gap {
                    raw.push((s, i));
                    start = None;
                }
            }
        }
    }
    if let Some(s) = start {
        raw.push((s, active.len()));
    }
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for part in raw {
        if let Some(last) = merged.last_mut() {
            if part.0.saturating_sub(last.1) <= max_gap {
                last.1 = part.1;
                continue;
            }
        }
        merged.push(part);
    }
    merged
}

fn empty_report(
    channels: usize,
    total: u64,
    features: Vec<FeatureFrame>,
    issues: Vec<String>,
) -> AnalysisReport {
    AnalysisReport {
        schema_version: 1,
        algorithm_version: "0.2.0-heuristic".into(),
        sample_rate: SAMPLE_RATE,
        channels: channels as u16,
        total_frames: total,
        status: Status::NoMusic,
        estimated_noise_floor_db: None,
        music_start: None,
        last_music_end: None,
        tail_end: None,
        final_applause_start: None,
        start_frame: None,
        end_frame: None,
        possible_breaks: vec![],
        issues,
        features,
    }
}

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
    let fade_in = plan.fade_in_ms as u64 * 48;
    let fade_out = plan.fade_out_ms as u64 * 48;
    let length = plan.end_frame - plan.start_frame;
    let mut peak = 0.0_f64;
    for frame in plan.start_frame..plan.end_frame {
        let pos = frame - plan.start_frame;
        let mut fade = 1.0;
        if fade_in > 1 && pos < fade_in {
            fade *= ((PI * pos as f64 / (2.0 * (fade_in - 1) as f64)).sin()).powi(2);
        }
        if fade_out > 1 && length - pos <= fade_out {
            let i = length - pos - 1;
            fade *= ((PI * i as f64 / (2.0 * (fade_out - 1) as f64)).sin()).powi(2);
        }
        for ch in 0..channels {
            let sample = samples[frame as usize * channels + ch];
            if !sample.is_finite() {
                return Err(AudioError::NonFiniteSample { frame, channel: ch });
            }
            peak = peak.max((sample as f64 * fade).abs());
        }
    }
    let target = 10.0_f64.powf(plan.target_peak_dbfs / 20.0);
    let cap = 10.0_f64.powf(plan.max_gain_db / 20.0);
    let desired = if peak == 0.0 || !plan.normalize {
        1.0
    } else {
        target / peak
    };
    let gain = if plan.normalize {
        desired.min(cap)
    } else {
        1.0
    };
    Ok(PeakMeasurement {
        input_peak: peak,
        gain,
        output_peak: peak * gain,
        gain_limited: plan.normalize && desired > cap,
    })
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
        let pos = frame - plan.start_frame;
        let mut fade = 1.0;
        if fade_in > 1 && pos < fade_in {
            fade *= ((PI * pos as f64 / (2.0 * (fade_in - 1) as f64)).sin()).powi(2);
        }
        if fade_out > 1 && n - pos <= fade_out {
            let i = n - pos - 1;
            fade *= ((PI * i as f64 / (2.0 * (fade_out - 1) as f64)).sin()).powi(2);
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(channels: usize) -> Vec<f32> {
        let mut out = vec![0.0; SAMPLE_RATE as usize * channels];
        for frame in 12_000..36_000 {
            let value = (2.0 * PI * 440.0 * frame as f64 / SAMPLE_RATE as f64).sin() as f32 * 0.2;
            for ch in 0..channels {
                out[frame * channels + ch] = if channels == 2 && ch == 1 {
                    -value
                } else {
                    value
                };
            }
        }
        out
    }

    #[test]
    fn analysis_is_independent_of_chunk_sizes_and_handles_antiphase_stereo() {
        let audio = fixture(2);
        let mut a = Analyzer::new(2, AnalysisConfig::default()).unwrap();
        a.push(&audio).unwrap();
        let one = a.finish().unwrap();
        let mut b = Analyzer::new(2, AnalysisConfig::default()).unwrap();
        for chunk in audio.chunks(734) {
            b.push(chunk).unwrap();
        }
        let many = b.finish().unwrap();
        assert_eq!(one.features, many.features);
        assert!(matches!(one.status, Status::NeedsReview));
        assert!(one.music_start.is_some());
    }

    #[test]
    fn fades_affect_peak_measurement_and_output_identically() {
        let plan = RenderPlan {
            start_frame: 2,
            end_frame: 194,
            normalize: true,
            target_peak_dbfs: -1.0,
            max_gain_db: 18.0,
            fade_in_ms: 1,
            fade_out_ms: 2,
        };
        let mut samples = vec![10.0; 196];
        samples[2..194].fill(0.25);
        // Large boundary samples are silenced by the fades and must not set gain.
        samples[2] = 4.0;
        samples[193] = -4.0;
        let measured = measure_peak(&samples, 1, &plan).unwrap();
        assert_eq!(measured.input_peak, 0.25);
        let output = render(&samples, 1, &plan, measured.gain).unwrap();
        let target = 10.0_f64.powf(-1.0 / 20.0);
        assert_eq!(output.len(), 192);
        for (position, sample) in output.iter().enumerate() {
            let expected = match position {
                0 | 191 => 0.0,
                1..=46 => target * (PI * position as f64 / 94.0).sin().powi(2),
                97..=190 => target * (PI * (191 - position) as f64 / 190.0).sin().powi(2),
                _ => target,
            };
            assert!((*sample as f64 - expected).abs() < 1e-7);
        }
    }

    #[test]
    fn normalization_caps_amplification_and_can_be_disabled() {
        let mut plan = RenderPlan {
            start_frame: 0,
            end_frame: 2,
            normalize: true,
            target_peak_dbfs: -1.0,
            max_gain_db: 18.0,
            fade_in_ms: 0,
            fade_out_ms: 0,
        };
        let samples = [0.001, -0.002];
        let measured = measure_peak(&samples, 1, &plan).unwrap();
        assert_eq!(measured.gain, 10.0_f64.powf(18.0 / 20.0));
        assert!(measured.gain_limited);
        assert_eq!(measured.output_peak, measured.input_peak * measured.gain);
        plan.normalize = false;
        let measured = measure_peak(&samples, 1, &plan).unwrap();
        assert_eq!(measured.gain, 1.0);
        assert!(!measured.gain_limited);
        assert_eq!(render(&samples, 1, &plan, measured.gain).unwrap(), samples);
    }

    #[test]
    fn silence_is_not_normalized_to_infinity() {
        let plan = RenderPlan {
            start_frame: 0,
            end_frame: 8,
            normalize: true,
            target_peak_dbfs: -1.0,
            max_gain_db: 18.0,
            fade_in_ms: 0,
            fade_out_ms: 0,
        };
        let measured = measure_peak(&[0.0; 8], 1, &plan).unwrap();
        assert_eq!(measured.gain, 1.0);
        assert_eq!(measured.output_peak, 0.0);
    }

    #[test]
    fn overlapped_feature_chunks_match_the_uninterrupted_feature_timeline() {
        let channels = 2;
        let frames = SAMPLE_RATE as usize * 4;
        let mut samples = vec![0.0; frames * channels];
        for frame in 24_000..168_000 {
            let sample = (2.0 * PI * 440.0 * frame as f64 / SAMPLE_RATE as f64).sin() as f32 * 0.2;
            samples[frame * channels] = sample;
            samples[frame * channels + 1] = sample * 0.7;
        }

        let mut whole = Analyzer::new(channels, AnalysisConfig::default()).unwrap();
        whole.push(&samples).unwrap();
        let whole_report = whole.finish().unwrap();

        let span = SAMPLE_RATE as u64;
        let mut chunked = Vec::new();
        for keep_start in (0..frames as u64).step_by(span as usize) {
            let keep_end = (keep_start + span).min(frames as u64);
            let source_start = keep_start.saturating_sub(HOP as u64);
            let source_end = (keep_end + WINDOW as u64 + HOP as u64).min(frames as u64);
            let from = source_start as usize * channels;
            let to = source_end as usize * channels;
            chunked.extend(
                analyze_feature_chunk(
                    &samples[from..to],
                    channels,
                    source_start,
                    keep_start,
                    keep_end,
                )
                .unwrap(),
            );
        }

        assert_eq!(chunked, whole_report.features);
        let chunked_report = build_analysis_report(channels, frames as u64, chunked).unwrap();
        assert_eq!(chunked_report.start_frame, whole_report.start_frame);
        assert_eq!(chunked_report.end_frame, whole_report.end_frame);
        assert_eq!(chunked_report.final_applause_start.map(|c| c.frame), whole_report.final_applause_start.map(|c| c.frame));
    }

    #[test]
    fn render_uses_one_gain_for_both_channels_and_keeps_bounds_half_open() {
        let samples = [0.1_f32, 0.2, 0.4, 0.8, -0.2, -0.1];
        let plan = RenderPlan {
            start_frame: 1,
            end_frame: 3,
            normalize: true,
            target_peak_dbfs: -1.0,
            max_gain_db: 18.0,
            fade_in_ms: 0,
            fade_out_ms: 0,
        };
        let measured = measure_peak(&samples, 2, &plan).unwrap();
        let output = render(&samples, 2, &plan, measured.gain).unwrap();
        assert_eq!(output.len(), 4);
        assert!((output[0] / output[1] - 0.5).abs() < 1e-6);
        assert!((measured.output_peak - 10.0_f64.powf(-1.0 / 20.0)).abs() < 1e-6);
    }

    #[test]
    fn rejects_non_finite_input_and_partial_frames() {
        let mut a = Analyzer::new(2, AnalysisConfig::default()).unwrap();
        assert!(matches!(a.push(&[0.0]), Err(AudioError::IncompleteFrame)));
        assert!(matches!(
            a.push(&[f32::NAN, 0.0]),
            Err(AudioError::NonFiniteSample {
                frame: 0,
                channel: 0
            })
        ));
    }

    #[test]
    fn preserves_later_movement_and_marks_repeated_applause() {
        let channels = 2;
        let total = SAMPLE_RATE as usize * 8;
        let mut audio = vec![0.0_f32; total * channels];
        for frame in SAMPLE_RATE as usize..SAMPLE_RATE as usize * 2 {
            let x = (2.0 * PI * 440.0 * frame as f64 / SAMPLE_RATE as f64).sin() as f32 * 0.15;
            audio[frame * channels] = x;
            audio[frame * channels + 1] = x;
        }
        for frame in SAMPLE_RATE as usize * 5..SAMPLE_RATE as usize * 6 {
            let x = (2.0 * PI * 660.0 * frame as f64 / SAMPLE_RATE as f64).sin() as f32 * 0.15;
            audio[frame * channels] = x;
            audio[frame * channels + 1] = x;
        }
        // Repeated short broadband bursts after the last movement.
        let mut random = 7_u32;
        let clap_start = SAMPLE_RATE as usize * 6 + SAMPLE_RATE as usize / 3;
        for base in (clap_start..total).step_by(SAMPLE_RATE as usize / 3) {
            for frame in base..(base + 1_200).min(total) {
                random = random.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let x = ((random >> 8) as f32 / 16_777_216.0 - 0.5) * 0.8;
                audio[frame * channels] = x;
                audio[frame * channels + 1] = x;
            }
        }
        let mut analyzer = Analyzer::new(channels, AnalysisConfig::default()).unwrap();
        for chunk in audio.chunks(4096) {
            analyzer.push(chunk).unwrap();
        }
        let report = analyzer.finish().unwrap();
        assert_eq!(report.possible_breaks.len(), 1);
        let music_end = report.last_music_end.unwrap().frame;
        let applause = report.final_applause_start.unwrap().frame;
        assert!(
            music_end >= SAMPLE_RATE as u64 * 59 / 10 && music_end <= SAMPLE_RATE as u64 * 61 / 10,
            "music_end={music_end}"
        );
        assert!(
            applause >= SAMPLE_RATE as u64 * 62 / 10 && applause <= SAMPLE_RATE as u64 * 65 / 10,
            "applause={applause}"
        );
        assert!(report.end_frame.unwrap() < applause);
        assert!(matches!(report.status, Status::NeedsReview));
    }

    #[test]
    fn detects_colored_applause_from_its_quieter_first_attack_but_not_one_transient() {
        for repeated in [true, false] {
            let total = SAMPLE_RATE as usize * 8;
            let mut audio = vec![0.0_f32; total * 2];
            for frame in SAMPLE_RATE as usize..SAMPLE_RATE as usize * 6 {
                let x = (2.0 * PI * 440.0 * frame as f64 / SAMPLE_RATE as f64).sin() as f32 * 0.1;
                audio[frame * 2] = x;
                audio[frame * 2 + 1] = x * 0.5;
            }
            let first_clap = SAMPLE_RATE as usize * 6 + SAMPLE_RATE as usize / 3;
            let mut random = 7_u32;
            let mut filtered = 0.0_f32;
            let mut position = first_clap;
            let mut event = 0;
            while position < total {
                let gain = if event == 0 { 0.02 } else { 0.5 };
                for frame in position..(position + 1200).min(total) {
                    random = random.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                    let noise = (random >> 8) as f32 / 16_777_216.0 - 0.5;
                    filtered += 0.12 * (noise - filtered);
                    audio[frame * 2] = filtered * gain;
                    audio[frame * 2 + 1] = filtered * gain * 0.5;
                }
                if !repeated { break; }
                event += 1; position += SAMPLE_RATE as usize / 3;
            }
            let mut analyzer = Analyzer::new(2, AnalysisConfig::default()).unwrap();
            analyzer.push(&audio).unwrap();
            let report = analyzer.finish().unwrap();
            if repeated {
                let onset = report.final_applause_start.unwrap().frame as usize;
                assert!(onset.abs_diff(first_clap) < SAMPLE_RATE as usize / 10, "onset={onset}");
                assert!(report.end_frame.unwrap() < first_clap as u64);
                assert!(report.end_frame.unwrap() > SAMPLE_RATE as u64 * 6);
            } else {
                assert!(report.final_applause_start.is_none(), "one transient must not be classified as repeated applause");
            }
        }
    }
}
