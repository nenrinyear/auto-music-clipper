use crate::features::HOP;
use crate::{
    AnalysisConfig, AnalysisReport, AudioError, Candidate, Confidence, FeatureFrame, PossibleBreak,
    Status, SAMPLE_RATE,
};

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

pub(super) fn build_report(
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
