// Renders the project timeline into a stereo bus, block by block, from disk.
import * as path from 'node:path';
import type { Fx, FxMeter, Project, Track } from '../shared/types';
import { dbToGain } from '../shared/time';
import { panGains } from './dsp';
import { fadesAt, trackFades } from './crossfade';
import { Ducker, isDucked } from './ducking';
import { WavReader } from './wav';
import { MUTE_RAMP_SECONDS, muteGainAt, regionsOverlap } from './muteRegions';
import { FxChain } from './fx/chain';
import { fillEnvelope, isUnityEnvelope } from './envelope';
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
export const FX_WARMUP_SECONDS = 0.5;
const PRIME_BLOCK = 4096;

interface ChainState {
  chain: FxChain;
  /** Next output position expected; anything else is a jump and re-primes the chain. */
  next: number;
  latency: number;
}

export class Mixer {
  private scratch: Float32Array[] = [];
  private envBuf = new Float32Array(0);
  private pre: Float32Array[] = [new Float32Array(0), new Float32Array(0)];
  private trackChains = new Map<string, ChainState>();
  /** Audio rendered before a jump so filters settle; scrubbing uses less to keep jumps cheap. */
  warmupSeconds = FX_WARMUP_SECONDS;
  /** Measure what each filter does (live playback only; export leaves it off). */
  metering = false;
  /** Peak each track contributed to the bus since the previous takeTrackPeaks() (metering only). */
  private trackPeaks = new Map<string, number>();
  private duckers = new Map<string, Ducker>();
  private duckBuf: Float32Array[] = [new Float32Array(0), new Float32Array(0)];
  private duckAcc: Float32Array[] = [new Float32Array(0), new Float32Array(0)];
  private duckGains = new Float32Array(0);
  private masterChain: ChainState | null = null;

  private _project: Project;

  constructor(project: Project, readonly readers: ReaderCache) {
    this._project = project;
  }

  get project(): Project {
    return this._project;
  }

  /** Swaps in an edited project; filter state of tracks that still exist is kept. */
  set project(p: Project) {
    this._project = p;
    for (const [id, s] of this.trackChains) {
      if (!p.tracks.some((t) => t.id === id && t.fx?.some((f) => f.enabled))) {
        s.chain.dispose();
        this.trackChains.delete(id);
      }
    }
    if (this.masterChain && !p.masterFx?.some((f) => f.enabled)) {
      this.masterChain.chain.dispose();
      this.masterChain = null;
    }
  }

  /** Releases filter resources (VST3 instances). */
  dispose(): void {
    for (const s of this.trackChains.values()) s.chain.dispose();
    this.trackChains.clear();
    this.masterChain?.chain.dispose();
    this.masterChain = null;
  }

  /**
   * Mixes all audible tracks for [position, position + frames) into `out`
   * (two planar channels, overwritten). Returns `out`.
   */
  render(position: number, frames: number, out: Float32Array[], tracks = audibleTracks(this.project)): Float32Array[] {
    const state = this.chainState(this.masterChain, this.project.masterFx);
    if (!state && this.masterChain) this.masterChain.chain.dispose();
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
      state.chain.process(out[0], out[1], frames, this.metering);
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
    const ducked = tracks.filter(isDucked);
    if (!ducked.length) {
      for (const track of tracks) this.renderTrackInto(track, position, frames, out);
      return;
    }
    // the other tracks first: their sum is what the ducked tracks duck under
    for (const track of tracks) if (!isDucked(track)) this.renderTrackInto(track, position, frames, out);
    if (this.duckBuf[0].length < frames) {
      this.duckBuf = [new Float32Array(frames), new Float32Array(frames)];
      this.duckAcc = [new Float32Array(frames), new Float32Array(frames)];
      this.duckGains = new Float32Array(frames);
    }
    const [dl, dr] = this.duckBuf;
    const [al, ar] = this.duckAcc;
    al.fill(0, 0, frames);
    ar.fill(0, 0, frames);
    for (const track of ducked) {
      let d = this.duckers.get(track.id);
      if (!d) {
        d = new Ducker(this.project.sampleRate);
        this.duckers.set(track.id, d);
      }
      if (d.next !== position) d.reset();
      d.process(out, frames, track.duck!.depth, this.duckGains);
      d.next = position + frames;
      dl.fill(0, 0, frames);
      dr.fill(0, 0, frames);
      this.renderTrackInto(track, position, frames, this.duckBuf);
      for (let i = 0; i < frames; i++) {
        const g = this.duckGains[i];
        al[i] += dl[i] * g;
        ar[i] += dr[i] * g;
      }
    }
    // added last, so one ducked track never ducks another
    for (let i = 0; i < frames; i++) {
      out[0][i] += al[i];
      out[1][i] += ar[i];
    }
  }

  /** What every metered filter did since the previous call, by filter id. */
  takeFxMeters(): Record<string, FxMeter> {
    const out: Record<string, FxMeter> = {};
    for (const s of this.trackChains.values()) s.chain.takeMeters(out);
    this.masterChain?.chain.takeMeters(out);
    return out;
  }

  /** Peak level (linear, after gain and pan) each played track reached since the previous call, by track id. */
  takeTrackPeaks(): Record<string, number> {
    const out = Object.fromEntries(this.trackPeaks);
    this.trackPeaks.clear();
    return out;
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
    const warm = Math.round(this.warmupSeconds * this.project.sampleRate);
    const buf = [new Float32Array(PRIME_BLOCK), new Float32Array(PRIME_BLOCK)];
    for (let p = position - warm; p < position; p += PRIME_BLOCK) {
      const n = Math.min(PRIME_BLOCK, position - p);
      buf[0].fill(0);
      buf[1].fill(0);
      step(p, n, buf);
    }
  }

  /** Adds one track (ignoring mute/solo) into `out`: clips, mute regions, volume line, filter stack, gain and pan. */
  renderTrackInto(track: Track, position: number, frames: number, out: Float32Array[]): void {
    const state = this.chainState(this.trackChains.get(track.id), track.fx);
    if (state) this.trackChains.set(track.id, state);
    else if (this.trackChains.has(track.id)) {
      this.trackChains.get(track.id)!.chain.dispose();
      this.trackChains.delete(track.id);
    }
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
      state.chain.process(pl, pr, frames, this.metering);
      state.next = position + frames;
    }
    const g = dbToGain(track.gain);
    const [panL, panR] = panGains(track.pan);
    // balance for stereo sources, pan law for mono ones
    const gl = g * (stereo ? Math.min(1, 1 - track.pan) : panL);
    const gr = g * (stereo ? Math.min(1, 1 + track.pan) : panR);
    const [ol, or] = out;
    let peak = 0;
    for (let i = 0; i < frames; i++) {
      const l = pl[i] * gl;
      const r = (stereo ? pr[i] : pl[i]) * gr;
      ol[i] += l;
      or[i] += r;
      if (this.metering) peak = Math.max(peak, Math.abs(l), Math.abs(r));
    }
    if (this.metering) this.trackPeaks.set(track.id, Math.max(peak, this.trackPeaks.get(track.id) ?? 0));
  }

  /**
   * Renders a track's clips (clip gain, fades, mute regions, volume line) for [position, position + frames)
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
    const fades = trackFades(track);
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
      const fade = fades.get(clip.id)!;
      const outOffset = from - position;
      // the clip's volume line, evaluated once per block in source frames
      let env: Float32Array | null = null;
      if (!isUnityEnvelope(clip.envelope)) {
        if (this.envBuf.length < n) this.envBuf = new Float32Array(n);
        env = this.envBuf;
        fillEnvelope(clip.envelope!, clip.offset + (from - cStart), n, env);
      }
      for (let i = 0; i < n; i++) {
        let gain = g * fadesAt(fade, clip.length, from - cStart + i);
        if (muted) gain *= muteGainAt(muted, from + i, ramp);
        if (env) gain *= env[i];
        const l = src[0][i];
        buf[0][outOffset + i] += l * gain;
        buf[1][outOffset + i] += (stereo ? src[1][i] : l) * gain;
      }
    }
    return stereoTrack;
  }
}

