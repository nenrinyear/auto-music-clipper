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
