// Renders the project timeline into a stereo bus, block by block, from disk.
import * as path from 'node:path';
import type { Clip, Project, Track } from '../shared/types';
import { dbToGain } from '../shared/time';
import { fadeGain, panGains } from './dsp';
import { WavReader } from './wav';
import { MUTE_RAMP_SECONDS, muteGainAt, regionsOverlap } from './muteRegions';
import { audibleTracks, projectLength } from './project';

export class ReaderCache {
  private readers = new Map<string, WavReader>();
  constructor(public baseDir: string) {}

  get(file: string): WavReader | null {
    const abs = path.isAbsolute(file) ? file : path.join(this.baseDir, file);
    let r = this.readers.get(abs);
    if (!r) {
      try {
        r = new WavReader(abs);
      } catch {
        return null;
      }
      this.readers.set(abs, r);
    }
    return r;
  }

  /** Drops a cached reader, e.g. after the file was rewritten. */
  invalidate(file: string): void {
    const abs = path.isAbsolute(file) ? file : path.join(this.baseDir, file);
    const r = this.readers.get(abs);
    if (r) {
      r.close();
      this.readers.delete(abs);
    }
  }

  closeAll(): void {
    for (const r of this.readers.values()) r.close();
    this.readers.clear();
  }
}

export { audibleTracks, projectLength };

export class Mixer {
  private scratch: Float32Array[] = [];

  constructor(public project: Project, readonly readers: ReaderCache) {}

  /**
   * Mixes all audible tracks for [position, position + frames) into `out`
   * (two planar channels, overwritten). Returns `out`.
   */
  render(position: number, frames: number, out: Float32Array[], tracks = audibleTracks(this.project)): Float32Array[] {
    out[0].fill(0, 0, frames);
    out[1].fill(0, 0, frames);
    for (const track of tracks) this.renderTrackInto(track, position, frames, out);
    const master = dbToGain(this.project.masterGain);
    if (master !== 1) {
      for (let i = 0; i < frames; i++) {
        out[0][i] *= master;
        out[1][i] *= master;
      }
    }
    return out;
  }

  /** Adds one track (ignoring mute/solo) into `out`. */
  renderTrackInto(track: Track, position: number, frames: number, out: Float32Array[]): void {
    const trackGain = dbToGain(track.gain);
    // only the mute regions touching this block, so the per-sample lookup stays short
    const muted = regionsOverlap(track, position, position + frames)
      ? track.muteRegions!.filter(([a, b]) => a < position + frames && b > position)
      : null;
    const ramp = Math.round(MUTE_RAMP_SECONDS * this.project.sampleRate);
    const [panL, panR] = panGains(track.pan);
    const end = position + frames;
    for (const clip of track.clips) {
      const cStart = clip.start;
      const cEnd = clip.start + clip.length;
      if (cEnd <= position || cStart >= end) continue;
      const from = Math.max(position, cStart);
      const to = Math.min(end, cEnd);
      const n = to - from;
      const reader = this.readers.get(clip.file);
      if (!reader) continue;
      if (this.scratch.length < reader.info.channels || (this.scratch[0]?.length ?? 0) < n) {
        const size = Math.max(n, this.scratch[0]?.length ?? 0);
        this.scratch = Array.from({ length: Math.max(2, reader.info.channels) }, () => new Float32Array(size));
      }
      const src = reader.read(clip.offset + (from - cStart), n, this.scratch);
      const g = trackGain * dbToGain(clip.gain);
      const outOffset = from - position;
      const stereo = reader.info.channels >= 2;
      // balance for stereo sources
      const balL = stereo ? Math.min(1, 1 - track.pan) : panL;
      const balR = stereo ? Math.min(1, 1 + track.pan) : panR;
      for (let i = 0; i < n; i++) {
        const rel = from - cStart + i;
        let env = g * clipEnvelope(clip, rel);
        if (muted) env *= muteGainAt(muted, from + i, ramp);
        const l = src[0][i];
        const r = stereo ? src[1][i] : l;
        out[0][outOffset + i] += l * env * balL;
        out[1][outOffset + i] += r * env * balR;
      }
    }
  }
}

function clipEnvelope(clip: Clip, rel: number): number {
  if (clip.fadeIn === 0 && clip.fadeOut === 0) return 1;
  return fadeGain(rel, clip.length, clip.fadeIn, clip.fadeOut);
}
