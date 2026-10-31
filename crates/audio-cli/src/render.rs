use anyhow::{bail, Context, Result};
use audio_core::{RenderPlan, SAMPLE_RATE};
use std::{
    fs::{File, OpenOptions},
    io::BufWriter,
    path::{Path, PathBuf},
};

use crate::wav::inspect;

pub(crate) fn render_file(
    input: &Path,
    output: &Path,
    start: u64,
    end: u64,
    normalize: bool,
    target: f64,
    max_gain: f64,
) -> Result<()> {
    if input == output {
        bail!("input and output paths must differ");
    }
    if output.exists() {
        bail!("output already exists: {}", output.display());
    }
    if !target.is_finite()
        || !max_gain.is_finite()
        || !(-12.0..=0.0).contains(&target)
        || !(0.0..=36.0).contains(&max_gain)
    {
        bail!("invalid normalization settings");
    }
    let spec = inspect(input)?;
    let mut reader = hound::WavReader::open(input)?;
    if end > reader.duration() as u64 {
        bail!("end time exceeds WAV duration");
    }
    let plan = RenderPlan {
        start_frame: start,
        end_frame: end,
        normalize,
        target_peak_dbfs: target,
        max_gain_db: max_gain,
        fade_in_ms: 5,
        fade_out_ms: 50,
    };
    if start >= end {
        bail!("invalid trim bounds");
    }
    if (plan.fade_in_ms as u64 + plan.fade_out_ms as u64) * 48 > end - start {
        bail!("selected region is too short for the default fades");
    }
    let channels = spec.channels as usize;
    let peak = scan_peak(&mut reader, channels, &plan)?;
    let measured = plan.normalization_for_peak(peak);
    let gain = measured.gain;
    let out_spec = hound::WavSpec {
        channels: spec.channels,
        sample_rate: SAMPLE_RATE,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let temp = temporary_path(output);
    let write_result = (|| -> Result<()> {
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        let mut writer = hound::WavWriter::new(BufWriter::new(file), out_spec)?;
        let mut reader = hound::WavReader::open(input)?;
        reader.seek(start as u32)?;
        let mut samples = reader.samples::<f32>();
        let mut output_chunk = Vec::with_capacity(16_384);
        let mut frame = start;
        while frame < end {
            output_chunk.clear();
            let batch_end = (frame + 8192).min(end);
            while frame < batch_end {
                let fade = plan.fade_at(frame - start);
                for _ in 0..channels {
                    output_chunk.push(
                        (samples.next().context("truncated WAV data")?? as f64 * fade * gain)
                            as f32,
                    );
                }
                frame += 1;
            }
            for sample in &output_chunk {
                writer.write_sample(*sample)?;
            }
        }
        writer.finalize()?;
        Ok(())
    })();
    if let Err(error) = write_result {
        let _ = std::fs::remove_file(&temp);
        return Err(error);
    }
    if let Err(e) = std::fs::rename(&temp, output) {
        let _ = std::fs::remove_file(&temp);
        return Err(e.into());
    }
    eprintln!(
        "wrote {} frames; common gain {:.2} dB; peak {:.4}",
        end - start,
        20.0 * gain.log10(),
        measured.output_peak
    );
    Ok(())
}

fn scan_peak(
    reader: &mut hound::WavReader<std::io::BufReader<File>>,
    channels: usize,
    plan: &RenderPlan,
) -> Result<f64> {
    reader.seek(plan.start_frame as u32)?;
    let mut samples = reader.samples::<f32>();
    let mut peak = 0.0_f64;
    for frame in 0..plan.end_frame - plan.start_frame {
        let fade = plan.fade_at(frame);
        for channel in 0..channels {
            let sample = samples.next().context("truncated WAV data")??;
            if !sample.is_finite() {
                bail!(
                    "non-finite sample at frame {}, channel {channel}",
                    plan.start_frame + frame
                );
            }
            peak = peak.max((sample as f64 * fade).abs());
        }
    }
    Ok(peak)
}

fn temporary_path(path: &Path) -> PathBuf {
    suffixed_path(path, &format!(".{}.part", std::process::id()))
}

pub(crate) fn suffixed_path(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

#[cfg(test)]
#[path = "render_tests.rs"]
mod tests;
