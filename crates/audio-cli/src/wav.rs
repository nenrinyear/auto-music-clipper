use anyhow::{bail, Context, Result};
use audio_core::{AnalysisConfig, Analyzer, SAMPLE_RATE};
use std::path::Path;

pub(crate) fn inspect(path: &Path) -> Result<hound::WavSpec> {
    let reader =
        hound::WavReader::open(path).with_context(|| format!("opening {}", path.display()))?;
    let s = reader.spec();
    if s.sample_rate != SAMPLE_RATE
        || s.channels == 0
        || s.channels > 2
        || s.bits_per_sample != 32
        || s.sample_format != hound::SampleFormat::Float
    {
        bail!("unsupported WAV: expected 48 kHz float32 mono/stereo, got {s:?}");
    }
    if reader.duration() as u64 > SAMPLE_RATE as u64 * 7200 {
        bail!("recording exceeds the 120 minute initial limit");
    }
    Ok(s)
}

pub(crate) fn analyze_file(path: &Path) -> Result<audio_core::AnalysisReport> {
    let spec = inspect(path)?;
    let mut reader = hound::WavReader::open(path)?;
    let mut analyzer = Analyzer::new(spec.channels as usize, AnalysisConfig::default())?;
    let mut samples = reader.samples::<f32>();
    let mut chunk = Vec::with_capacity(16_384);
    loop {
        chunk.clear();
        for _ in 0..16_384 {
            match samples.next() {
                Some(sample) => chunk.push(sample?),
                None => break,
            }
        }
        if chunk.is_empty() {
            break;
        }
        analyzer.push(&chunk)?;
    }
    analyzer.finish().map_err(Into::into)
}
