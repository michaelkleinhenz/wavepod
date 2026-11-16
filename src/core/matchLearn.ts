// Learning a voice match (match EQ) curve from clips on the timeline (runs in the export worker).
import * as path from 'node:path';
import type { Clip, Project } from '../shared/types';
import { readClip } from './clipSound';
import { WavReader } from './wav';
import { MATCH_FRAME, SpectrumCollector, matchGains } from './fx/matchEq';

/** Reads the speech spectrum of clips as they sit on the timeline, before any filter. */
export function clipsSpectrum(projectDir: string, clips: Clip[], sampleRate: number): { bands: number[]; seconds: number } {
  const col = new SpectrumCollector(sampleRate);
  const BLOCK = 65536;
  const mono = new Float32Array(BLOCK);
  for (const clip of clips) {
    const file = path.isAbsolute(clip.file) ? clip.file : path.join(projectDir, clip.file);
    const reader = new WavReader(file);
    try {
      const buf = Array.from({ length: Math.max(2, reader.info.channels) }, () => new Float32Array(BLOCK));
      const stereo = reader.info.channels >= 2;
      for (let done = 0; done < clip.length; done += BLOCK) {
        const n = Math.min(BLOCK, clip.length - done);
        const src = readClip(reader, clip, done, n, buf);
        for (let i = 0; i < n; i++) mono[i] = stereo ? 0.5 * (src[0][i] + src[1][i]) : src[0][i];
        col.push(mono, n);
      }
    } finally {
      reader.close();
    }
  }
  return { bands: col.result(), seconds: (col.speechFrames * MATCH_FRAME) / 2 / sampleRate };
}

/** What Learn measured: the curve plus how much speech each side had. */
export interface MatchLearnResult {
  gains: number[];
  sourceSeconds: number;
  referenceSeconds: number;
}

/** Learns the curve that makes the source clips sound like the reference clips. */
export function learnMatch(project: Project, projectDir: string, sourceClipIds: string[], referenceClipIds: string[]): MatchLearnResult {
  const all = project.tracks.flatMap((t) => t.clips);
  const pick = (ids: string[]) => all.filter((c) => ids.includes(c.id) && !c.sound);
  const src = clipsSpectrum(projectDir, pick(sourceClipIds), project.sampleRate);
  const ref = clipsSpectrum(projectDir, pick(referenceClipIds), project.sampleRate);
  if (src.seconds < 2) throw new Error('There is too little speech in this track or clip to learn from (at least a few seconds are needed).');
  if (ref.seconds < 2) throw new Error('There is too little speech in the reference to learn from (at least a few seconds are needed).');
  return { gains: matchGains(ref.bands, src.bands), sourceSeconds: src.seconds, referenceSeconds: ref.seconds };
}
