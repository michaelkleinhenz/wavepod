// Renders the project timeline into a stereo bus, block by block, from disk.
import * as path from 'node:path';
import type { Clip, Fx, Project, Track } from '../shared/types';
import { dbToGain } from '../shared/time';
import { fadeGain, panGains } from './dsp';
import { WavReader } from './wav';
import { MUTE_RAMP_SECONDS, muteGainAt, regionsOverlap } from './muteRegions';
import { FxChain } from './fx/chain';
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

/** Audio rendered before a jump in position so filters (envelopes, RMS windows) settle. */
const FX_WARMUP_SECONDS = 0.5;
const PRIME_BLOCK = 4096;

interface ChainState {
  chain: FxChain;
  /** Next output position expected; anything else is a jump and re-primes the chain. */
  next: number;
  latency: number;
}

export class Mixer {
  private scratch: Float32Array[] = [];
  private pre: Float32Array[] = [new Float32Array(0), new Float32Array(0)];
  private trackChains = new Map<string, ChainState>();
  private masterChain: ChainState | null = null;

  constructor(public project: Project, readonly readers: ReaderCache) {}

  /**
   * Mixes all audible tracks for [position, position + frames) into `out`
   * (two planar channels, overwritten). Returns `out`.
   */
  render(position: number, frames: number, out: Float32Array[], tracks = audibleTracks(this.project)): Float32Array[] {
    const state = this.chainState(this.masterChain, this.project.masterFx);
    this.masterChain = state;
    if (!state) {
      this.renderBus(position, frames, out, tracks);
    } else {
      // the master chain gets the bus `latency` frames early, so its output lines up with the timeline
      if (state.next !== position || state.latency !== state.chain.latency) {
        state.chain.reset();
        state.latency = state.chain.latency;
        this.prime(position, (p, n, buf) => {
          this.renderBus(p + state.latency, n, buf, tracks);
          state.chain.process(buf[0], buf[1], n);
        });
      }
      this.renderBus(position + state.latency, frames, out, tracks);
      state.chain.process(out[0], out[1], frames);
      state.next = position + frames;
    }
    const master = dbToGain(this.project.masterGain);
    if (master !== 1) {
      for (let i = 0; i < frames; i++) {
        out[0][i] *= master;
        out[1][i] *= master;
      }
    }
    return out;
  }

  private renderBus(position: number, frames: number, out: Float32Array[], tracks: Track[]): void {
    out[0].fill(0, 0, frames);
    out[1].fill(0, 0, frames);
    for (const track of tracks) this.renderTrackInto(track, position, frames, out);
  }

  /** Returns the chain state for a filter list (null when nothing is active). */
  private chainState(state: ChainState | null | undefined, list: Fx[] | undefined): ChainState | null {
    if (!list?.some((f) => f.enabled)) return null;
    const s = state ?? { chain: new FxChain(this.project.sampleRate), next: NaN, latency: 0 };
    s.chain.sync(list);
    return s;
  }

  /** Runs `step` over the warm-up span before `position`, in blocks, discarding the output. */
  private prime(position: number, step: (pos: number, n: number, buf: Float32Array[]) => void): void {
    const warm = Math.round(FX_WARMUP_SECONDS * this.project.sampleRate);
    const buf = [new Float32Array(PRIME_BLOCK), new Float32Array(PRIME_BLOCK)];
    for (let p = position - warm; p < position; p += PRIME_BLOCK) {
      const n = Math.min(PRIME_BLOCK, position - p);
      buf[0].fill(0);
      buf[1].fill(0);
      step(p, n, buf);
    }
  }

  /** Adds one track (ignoring mute/solo) into `out`: clips, mute regions, filter stack, gain and pan. */
  renderTrackInto(track: Track, position: number, frames: number, out: Float32Array[]): void {
    const state = this.chainState(this.trackChains.get(track.id), track.fx);
    if (state) this.trackChains.set(track.id, state);
    else this.trackChains.delete(track.id);
    if (this.pre[0].length < frames) this.pre = [new Float32Array(frames), new Float32Array(frames)];
    const [pl, pr] = this.pre;
    let stereo: boolean;
    if (!state) {
      stereo = this.renderRaw(track, position, frames, this.pre);
    } else {
      if (state.next !== position || state.latency !== state.chain.latency) {
        state.chain.reset();
        state.latency = state.chain.latency;
        this.prime(position, (p, n, buf) => {
          this.renderRaw(track, p + state.latency, n, buf);
          state.chain.process(buf[0], buf[1], n);
        });
      }
      stereo = this.renderRaw(track, position + state.latency, frames, this.pre);
      state.chain.process(pl, pr, frames);
      state.next = position + frames;
    }
    const g = dbToGain(track.gain);
    const [panL, panR] = panGains(track.pan);
    // balance for stereo sources, pan law for mono ones
    const gl = g * (stereo ? Math.min(1, 1 - track.pan) : panL);
    const gr = g * (stereo ? Math.min(1, 1 + track.pan) : panR);
    const [ol, or] = out;
    for (let i = 0; i < frames; i++) {
      ol[i] += pl[i] * gl;
      or[i] += (stereo ? pr[i] : pl[i]) * gr;
    }
  }

  /**
   * Renders a track's clips (clip gain, fades, mute regions) for [position, position + frames)
   * into `buf` (overwritten; mono material is duplicated into both channels).
   * Returns true if any clip is stereo.
   */
  private renderRaw(track: Track, position: number, frames: number, buf: Float32Array[]): boolean {
    buf[0].fill(0, 0, frames);
    buf[1].fill(0, 0, frames);
    let stereoTrack = false;
    const end = position + frames;
    const ramp = Math.round(MUTE_RAMP_SECONDS * this.project.sampleRate);
    // only the mute regions touching this block, so the per-sample lookup stays short
    const muted = regionsOverlap(track, position, end) ? track.muteRegions!.filter(([a, b]) => a < end && b > position) : null;
    for (const clip of track.clips) {
      const reader = this.readers.get(clip.file);
      if (!reader) continue;
      const stereo = reader.info.channels >= 2;
      if (stereo) stereoTrack = true;
      const cStart = clip.start;
      const cEnd = clip.start + clip.length;
      if (cEnd <= position || cStart >= end) continue;
      const from = Math.max(position, cStart);
      const to = Math.min(end, cEnd);
      const n = to - from;
      if (this.scratch.length < reader.info.channels || (this.scratch[0]?.length ?? 0) < n) {
        const size = Math.max(n, this.scratch[0]?.length ?? 0);
        this.scratch = Array.from({ length: Math.max(2, reader.info.channels) }, () => new Float32Array(size));
      }
      const src = reader.read(clip.offset + (from - cStart), n, this.scratch);
      const g = dbToGain(clip.gain);
      const outOffset = from - position;
      for (let i = 0; i < n; i++) {
        let env = g * clipEnvelope(clip, from - cStart + i);
        if (muted) env *= muteGainAt(muted, from + i, ramp);
        const l = src[0][i];
        buf[0][outOffset + i] += l * env;
        buf[1][outOffset + i] += (stereo ? src[1][i] : l) * env;
      }
    }
    return stereoTrack;
  }
}

function clipEnvelope(clip: Clip, rel: number): number {
  if (clip.fadeIn === 0 && clip.fadeOut === 0) return 1;
  return fadeGain(rel, clip.length, clip.fadeIn, clip.fadeOut);
}
