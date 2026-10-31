use super::*;
use crate::features::{HOP, WINDOW};
use std::f64::consts::PI;

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
