// Loudness analysis of the mix, tracks and single clips (runs in the export worker).
import * as path from 'node:path';
import type { Clip, LoudnessReport, LoudnessStats, Project } from '../shared/types';
import { fadeGain } from './dsp';
import { measureLoudness } from './exporter';
import { LoudnessMeter, shiftStats } from './loudness';
import { findClip } from './project';
import { WavReader } from './wav';

const BLOCK = 65536;

/**
 * Measures one clip as it sounds on the timeline before the track's filters,
 * volume line, gain and pan: its slice of the source file with its fades and
 * clip gain. Mono material is measured on both channels, the way the mixer
 * puts it on a centred track, so −16 LUFS here reads −16 LUFS in the mix.
 */
export function measureClip(projectDir: string, clip: Clip): LoudnessStats {
  const file = path.isAbsolute(clip.file) ? clip.file : path.join(projectDir, clip.file);
  const reader = new WavReader(file);
  try {
    const meter = new LoudnessMeter(reader.info.sampleRate, 2);
    const stereo = reader.info.channels >= 2;
    const fades = clip.fadeIn > 0 || clip.fadeOut > 0;
    const buf = Array.from({ length: Math.max(2, reader.info.channels) }, () => new Float32Array(BLOCK));
    const l = new Float32Array(BLOCK);
    const r = new Float32Array(BLOCK);
    for (let done = 0; done < clip.length; done += BLOCK) {
      const n = Math.min(BLOCK, clip.length - done);
      const src = reader.read(clip.offset + done, n, buf);
      for (let i = 0; i < n; i++) {
        const g = fades ? fadeGain(done + i, clip.length, clip.fadeIn, clip.fadeOut) : 1;
        l[i] = src[0][i] * g;
        r[i] = (stereo ? src[1][i] : src[0][i]) * g;
      }
      meter.push([l, r], n);
    }
    return shiftStats(meter.stats(), clip.gain);
  } finally {
    reader.close();
  }
}

/** Loudness of the mix and (unless `mixOnly`) of every track with clips. */
export function analyseProject(project: Project, projectDir: string, mixOnly = false): LoudnessReport[] {
  const reports: LoudnessReport[] = [{ kind: 'mix', id: 'mix', name: 'Mix', stats: measureLoudness(project, projectDir) }];
  if (mixOnly) return reports;
  for (const t of project.tracks) {
    if (!t.clips.length) continue;
    reports.push({ kind: 'track', id: t.id, name: t.name, stats: measureLoudness(project, projectDir, [t]) });
  }
  return reports;
}

/** Loudness of the given clips (clips that no longer exist are skipped). */
export function analyseClips(project: Project, projectDir: string, clipIds: string[]): LoudnessReport[] {
  const reports: LoudnessReport[] = [];
  for (const id of clipIds) {
    const found = findClip(project, id);
    if (!found) continue;
    const name = `${found.track.name} · ${path.basename(found.clip.file).replace(/\.wav$/i, '')}`;
    reports.push({ kind: 'clip', id, name, stats: measureClip(projectDir, found.clip) });
  }
  return reports;
}
