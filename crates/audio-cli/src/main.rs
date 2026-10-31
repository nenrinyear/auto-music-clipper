mod render;
mod wav;

use anyhow::{bail, Context, Result};
use audio_core::{Status, SAMPLE_RATE};
use clap::{Parser, Subcommand};
use std::path::PathBuf;

use render::{render_file, suffixed_path};
use wav::analyze_file;

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
