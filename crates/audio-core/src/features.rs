use rustfft::{num_complex::Complex, Fft, FftPlanner};
use std::{f64::consts::PI, sync::Arc};

use crate::{AnalysisConfig, AnalysisReport, AudioError, FeatureFrame};
use crate::detection::build_report;

pub(crate) const WINDOW: usize = 2048;
pub(crate) const HOP: usize = 480;

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
