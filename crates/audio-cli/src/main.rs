use anyhow::{bail, Context, Result};
use audio_core::{AnalysisConfig, Analyzer, RenderPlan, Status, SAMPLE_RATE};
use clap::{Parser, Subcommand};
use std::{
    f64::consts::PI,
    fs::{File, OpenOptions},
    io::BufWriter,
    path::{Path, PathBuf},
};

#[derive(Parser)]
#[command(
    name = "amc",
    about = "Analyze and trim 48 kHz float WAV performance recordings"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Analyze {
        input: PathBuf,
        #[arg(long)]
        report: Option<PathBuf>,
    },
    Auto {
        input: PathBuf,
        #[arg(long)]
        out: PathBuf,
    },
    Trim {
        input: PathBuf,
        #[arg(long)]
        out: PathBuf,
        #[arg(long)]
        start: f64,
        #[arg(long)]
        end: f64,
        #[arg(long, default_value_t = true, action = clap::ArgAction::Set)]
        normalize: bool,
        #[arg(long, default_value_t=-1.0)]
        target_peak_dbfs: f64,
        #[arg(long, default_value_t = 18.0)]
        max_gain_db: f64,
    },
}

fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Analyze { input, report } => {
            let result = analyze_file(&input)?;
            let json = serde_json::to_string_pretty(&result)?;
            if let Some(path) = report {
                std::fs::write(path, &json)?;
            }
            println!("{json}");
        }
        Command::Auto { input, out } => {
            let report = analyze_file(&input)?;
            let report_path = suffixed_path(&out, ".analysis.json");
            std::fs::write(&report_path, serde_json::to_vec_pretty(&report)?)?;
            if !matches!(report.status, Status::Ready) {
                bail!(
                    "automatic trim needs review; report saved to {}: {:?}",
                    report_path.display(),
                    report.issues
                );
            }
            let start = report.start_frame.context("missing start")?;
            let end = report.end_frame.context("missing end")?;
            render_file(&input, &out, start, end, true, -1.0, 18.0)?;
        }
        Command::Trim {
            input,
            out,
            start,
            end,
            normalize,
            target_peak_dbfs,
            max_gain_db,
        } => {
            if !start.is_finite() || !end.is_finite() || start < 0.0 || end <= start {
                bail!("invalid trim times");
            }
            render_file(
                &input,
                &out,
                (start * SAMPLE_RATE as f64).round() as u64,
                (end * SAMPLE_RATE as f64).round() as u64,
                normalize,
                target_peak_dbfs,
                max_gain_db,
            )?;
        }
    }
    Ok(())
}

fn inspect(path: &Path) -> Result<hound::WavSpec> {
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

fn analyze_file(path: &Path) -> Result<audio_core::AnalysisReport> {
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

fn render_file(
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
    let target_peak = 10.0_f64.powf(target / 20.0);
    let max_gain = 10.0_f64.powf(max_gain / 20.0);
    let desired = if peak == 0.0 || !normalize {
        1.0
    } else {
        target_peak / peak
    };
    let gain = if normalize {
        desired.min(max_gain)
    } else {
        1.0
    };
    let output_peak = peak * gain;
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
                let fade = fade_at(frame - start, end - start, &plan);
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
        output_peak
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
        let fade = fade_at(frame, plan.end_frame - plan.start_frame, plan);
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

fn fade_at(position: u64, length: u64, plan: &RenderPlan) -> f64 {
    let mut fade = 1.0;
    let fade_in = plan.fade_in_ms as u64 * 48;
    let fade_out = plan.fade_out_ms as u64 * 48;
    if fade_in > 1 && position < fade_in {
        fade *= ((PI * position as f64 / (2.0 * (fade_in - 1) as f64)).sin()).powi(2);
    }
    if fade_out > 1 && length - position <= fade_out {
        let i = length - position - 1;
        fade *= ((PI * i as f64 / (2.0 * (fade_out - 1) as f64)).sin()).powi(2);
    }
    fade
}

fn temporary_path(path: &Path) -> PathBuf {
    suffixed_path(path, &format!(".{}.part", std::process::id()))
}

fn suffixed_path(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDirectory(PathBuf);

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn streamed_wav_matches_core_render_with_fades_and_linked_gain() -> Result<()> {
        let directory = TestDirectory(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../target")
                .join(format!(
                    "amc-render-test-{}-{}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)?
                        .as_nanos()
                )),
        );
        std::fs::create_dir(&directory.0)?;
        for channels in [1, 2] {
            let input = directory.0.join(format!("input-{channels}.wav"));
            let spec = hound::WavSpec {
                channels,
                sample_rate: SAMPLE_RATE,
                bits_per_sample: 32,
                sample_format: hound::SampleFormat::Float,
            };
            let samples: Vec<f32> = (0..20_000)
                .flat_map(|frame| {
                    (0..channels).map(move |channel| {
                        let value = (frame as f64 * 0.13).sin() as f32 * 0.25;
                        if channel == 0 {
                            value
                        } else {
                            -value * 0.5
                        }
                    })
                })
                .collect();
            let mut writer = hound::WavWriter::create(&input, spec)?;
            for sample in &samples {
                writer.write_sample(*sample)?;
            }
            writer.finalize()?;
            for normalize in [false, true] {
                let output = directory.0.join(format!("output-{channels}-{normalize}.wav"));
                let plan = RenderPlan {
                    start_frame: 123,
                    end_frame: 19_000,
                    normalize,
                    target_peak_dbfs: -1.0,
                    max_gain_db: 18.0,
                    fade_in_ms: 5,
                    fade_out_ms: 50,
                };
                let measured = audio_core::measure_peak(&samples, channels as usize, &plan)?;
                let expected = audio_core::render(&samples, channels as usize, &plan, measured.gain)?;
                render_file(&input, &output, 123, 19_000, normalize, -1.0, 18.0)?;
                let mut reader = hound::WavReader::open(output)?;
                assert_eq!(reader.spec(), spec);
                let actual = reader.samples::<f32>().collect::<Result<Vec<_>, _>>()?;
                assert_eq!(actual, expected);
            }
        }
        Ok(())
    }
}
