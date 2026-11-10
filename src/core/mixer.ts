// Renders the project timeline into a stereo bus, block by block, from disk.
import { readClip } from './clipSound';
import * as path from 'node:path';
import type { Clip, Fx, FxMeter, Project, Track } from '../shared/types';
import { dbToGain } from '../shared/time';
import { panGains } from './dsp';
import { DECLICK_SECONDS, fadesAt, trackFades } from './crossfade';
import { Ducker, isDucked } from './ducking';
import { Automix, AUTOMIX_DEFAULT_DEPTH, isAutomixed } from './automix';
import { WavReader } from './wav';
import { MUTE_RAMP_SECONDS, muteGainAt, regionsOverlap } from './muteRegions';
import { FxChain } from './fx/chain';
import { fillEnvelope, isUnityEnvelope } from './envelope';
import { fillAutomation, volumeAmp } from './automation';
import { audibleTracks, projectLength } from './project';
import { folderGainOf } from './folders';

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
/** How long a clip's filters keep running after the clip ends, so echoes and reverb ring out. */
export const CLIP_FX_TAIL_SECONDS = 3;

interface ChainState {
  chain: FxChain;
  /** Next output position expected; anything else is a jump and re-primes the chain. */
  next: number;
  latency: number;
}

interface ClipChainState extends ChainState {
  /** The track and clip lists the combined list was built from. */
  trackFx?: Fx[];
  clipFx?: Fx[];
  list: Fx[];
}

const hasActiveFx = (list: Fx[] | undefined): boolean => !!list?.some((f) => f.enabled);

export class Mixer {
  private scratch: Float32Array[] = [];
  private envBuf = new Float32Array(0);
  /** Per-sample track volume (linear) and pan of the block, when the track is automated. */
  private autoVol = new Float32Array(0);
  private autoPan = new Float32Array(0);
  private pre: Float32Array[] = [new Float32Array(0), new Float32Array(0)];
  private trackChains = new Map<string, ChainState>();
  /** Chains of clips with their own filters (track filters, then clip filters), by clip id. */
  private clipChains = new Map<string, ClipChainState>();
  private clipBuf: Float32Array[] = [new Float32Array(0), new Float32Array(0)];
  /** Audio rendered before a jump so filters settle; scrubbing uses less to keep jumps cheap. */
  warmupSeconds = FX_WARMUP_SECONDS;
  /** Measure what each filter does (live playback only; export leaves it off). */
  metering = false;
  /**
   * Clip edges left without the automatic declick (clip ids), for rendering clips whose fade is
   * taken out and applied later instead (Fuse keeps the outer fades editable).
   */
  noDeclickIn: ReadonlySet<string> = new Set();
  noDeclickOut: ReadonlySet<string> = new Set();
  /** Peak each track contributed to the bus since the previous takeTrackPeaks() (metering only). */
  private trackPeaks = new Map<string, number>();
  private duckers = new Map<string, Ducker>();
  private duckBuf: Float32Array[] = [new Float32Array(0), new Float32Array(0)];
  private duckAcc: Float32Array[] = [new Float32Array(0), new Float32Array(0)];
  private duckGains = new Float32Array(0);
  private masterChain: ChainState | null = null;
  private automix: Automix | null = null;
  private amBufs: Float32Array[][] = [];
  private amGains: Float32Array[] = [];

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
    const fxClips = new Set(p.tracks.flatMap((t) => t.clips.filter((c) => hasActiveFx(c.fx)).map((c) => c.id)));
    for (const [id, s] of this.clipChains) {
      if (!fxClips.has(id)) {
        s.chain.dispose();
        this.clipChains.delete(id);
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
    for (const s of this.clipChains.values()) s.chain.dispose();
    this.clipChains.clear();
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
    this.renderRouted(position, frames, [out], tracks, () => 0);
  }

  /**
   * Mixes the audible tracks split into `outs` (each overwritten): every track goes into
   * `outs[route(track)]`, so the buffers add up to what render() puts on the bus before the
   * master filters. Ducking and the automix still follow the whole bus, as in the mix; a buffer
   * the caller ignores leaves tracks out. The master gain applies to every buffer. Used for
   * dialogue / music / effects stems.
   */
  renderSplit(position: number, frames: number, outs: Float32Array[][], route: (track: Track) => number): Float32Array[][] {
    this.renderRouted(position, frames, outs, audibleTracks(this.project), route);
    const master = dbToGain(this.project.masterGain);
    if (master !== 1) {
      for (const o of outs) {
        for (let i = 0; i < frames; i++) {
          o[0][i] *= master;
          o[1][i] *= master;
        }
      }
    }
    return outs;
  }

  private renderRouted(position: number, frames: number, outs: Float32Array[][], tracks: Track[], route: (track: Track) => number): void {
    for (const o of outs) {
      o[0].fill(0, 0, frames);
      o[1].fill(0, 0, frames);
    }
    const ducked = tracks.filter(isDucked);
    // the other tracks first: their sum is what the ducked tracks duck under
    this.renderAutomixed(tracks.filter((t) => !isDucked(t)), position, frames, (t) => outs[route(t)]);
    if (!ducked.length) return;
    if (this.duckBuf[0].length < frames) {
      this.duckBuf = [new Float32Array(frames), new Float32Array(frames)];
      this.duckAcc = [new Float32Array(frames), new Float32Array(frames)];
      this.duckGains = new Float32Array(frames);
    }
    const [dl, dr] = this.duckBuf;
    // the sidechain: everything that is not ducked, taken before any ducked track is added,
    // so one ducked track never ducks another
    const side = this.duckAcc;
    side[0].set(outs[0][0].subarray(0, frames));
    side[1].set(outs[0][1].subarray(0, frames));
    for (let k = 1; k < outs.length; k++) {
      for (let i = 0; i < frames; i++) {
        side[0][i] += outs[k][0][i];
        side[1][i] += outs[k][1][i];
      }
    }
    for (const track of ducked) {
      let d = this.duckers.get(track.id);
      if (!d) {
        d = new Ducker(this.project.sampleRate);
        this.duckers.set(track.id, d);
      }
      if (d.next !== position) d.reset();
      d.process(side, frames, track.duck!.depth, this.duckGains);
      d.next = position + frames;
      dl.fill(0, 0, frames);
      dr.fill(0, 0, frames);
      this.renderTrackInto(track, position, frames, this.duckBuf);
      const [ol, or] = outs[route(track)];
      for (let i = 0; i < frames; i++) {
        const g = this.duckGains[i];
        ol[i] += dl[i] * g;
        or[i] += dr[i] * g;
      }
    }
  }

  /**
   * Renders only `stems` (overwriting `out`), as they sound in the mix: automixed tracks
   * still follow the other audible automixed tracks. Used for stem and single-track export.
   */
  renderStems(stems: Track[], position: number, frames: number, out: Float32Array[]): Float32Array[] {
    out[0].fill(0, 0, frames);
    out[1].fill(0, 0, frames);
    const ids = new Set(stems.map((t) => t.id));
    const audible = audibleTracks(this.project).filter((t) => !isDucked(t));
    const automixed = audible.filter((t) => isAutomixed(t) && ids.has(t.id));
    if (!automixed.length) {
      for (const t of stems) this.renderTrackInto(t, position, frames, out);
      return out;
    }
    const others = stems.filter((t) => !automixed.includes(t));
    for (const t of others) this.renderTrackInto(t, position, frames, out);
    this.renderAutomixed(audible.filter(isAutomixed), position, frames, (t) => (ids.has(t.id) ? out : null));
    return out;
  }

  /**
   * Adds each of `tracks` into the buffer `sink` gives it (null: not wanted); the automixed ones
   * among them first share their gain (crosstalk removal).
   */
  private renderAutomixed(tracks: Track[], position: number, frames: number, sink: (track: Track) => Float32Array[] | null): void {
    const mixed = tracks.filter(isAutomixed);
    for (const track of tracks) {
      if (mixed.length >= 2 && isAutomixed(track)) continue;
      const out = sink(track);
      if (out) this.renderTrackInto(track, position, frames, out);
    }
    if (mixed.length < 2) {
      this.automix = null;
      return;
    }
    if (!this.automix) this.automix = new Automix(this.project.sampleRate);
    const am = this.automix;
    if (am.next !== position) am.reset();
    while (this.amBufs.length < mixed.length) this.amBufs.push([new Float32Array(0), new Float32Array(0)]);
    while (this.amGains.length < mixed.length) this.amGains.push(new Float32Array(0));
    const bufs = this.amBufs.slice(0, mixed.length);
    const prevPeaks = mixed.map((t) => this.trackPeaks.get(t.id) ?? 0);
    mixed.forEach((track, t) => {
      if (bufs[t][0].length < frames) {
        bufs[t] = this.amBufs[t] = [new Float32Array(frames), new Float32Array(frames)];
        this.amGains[t] = new Float32Array(frames);
      }
      bufs[t][0].fill(0, 0, frames);
      bufs[t][1].fill(0, 0, frames);
      this.renderTrackInto(track, position, frames, bufs[t]);
    });
    const depths = mixed.map((t) => t.automix?.depth ?? AUTOMIX_DEFAULT_DEPTH);
    am.process(mixed.map((t) => t.id), bufs, depths, frames, this.amGains);
    am.next = position + frames;
    mixed.forEach((track, t) => {
      const [bl, br] = bufs[t];
      const g = this.amGains[t];
      const out = sink(track);
      if (!out) return;
      let peak = 0;
      for (let i = 0; i < frames; i++) {
        const l = bl[i] * g[i];
        const r = br[i] * g[i];
        out[0][i] += l;
        out[1][i] += r;
        if (this.metering) peak = Math.max(peak, Math.abs(l), Math.abs(r));
      }
      // the meter shows what's left after the automix, not what the track brought in
      if (this.metering) this.trackPeaks.set(track.id, Math.max(prevPeaks[t], peak));
    });
  }

  /** What every metered filter did since the previous call, by filter id. */
  takeFxMeters(): Record<string, FxMeter> {
    const out: Record<string, FxMeter> = {};
    for (const s of this.trackChains.values()) s.chain.takeMeters(out);
    for (const s of this.clipChains.values()) s.chain.takeMeters(out);
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

  /**
   * Runs `state`'s chain over [position, position + frames) of what `raw` renders into `buf`, delaying the
   * input by the chain's latency and re-priming the chain after a jump. Returns true if `raw` was stereo.
   */
  private runChain(state: ChainState, position: number, frames: number, buf: Float32Array[], raw: (pos: number, n: number, b: Float32Array[]) => boolean): boolean {
    if (state.next !== position || state.latency !== state.chain.latency) {
      state.chain.reset();
      state.latency = state.chain.latency;
      this.prime(position, (p, n, b) => {
        raw(p + state.latency, n, b);
        state.chain.process(b[0], b[1], n);
      });
    }
    const stereo = raw(position + state.latency, frames, buf);
    state.chain.process(buf[0], buf[1], frames, this.metering);
    state.next = position + frames;
    return stereo;
  }

  /** The chain of a clip with its own filters: the track's filters first, then the clip's. */
  private clipChainState(track: Track, clip: Clip): ClipChainState {
    let s = this.clipChains.get(clip.id);
    if (!s) {
      s = { chain: new FxChain(this.project.sampleRate), next: NaN, latency: 0, list: [] };
      this.clipChains.set(clip.id, s);
    }
    if (s.trackFx !== track.fx || s.clipFx !== clip.fx) {
      s.trackFx = track.fx;
      s.clipFx = clip.fx;
      s.list = [...(track.fx ?? []), ...(clip.fx ?? [])];
    }
    s.chain.sync(s.list);
    return s;
  }

  /** Adds one track (ignoring mute/solo) into `out`: clips, mute regions, volume line, filter stacks, gain and pan (automated or fixed). */
  renderTrackInto(track: Track, position: number, frames: number, out: Float32Array[]): void {
    const state = this.chainState(this.trackChains.get(track.id), track.fx);
    if (state) this.trackChains.set(track.id, state);
    else if (this.trackChains.has(track.id)) {
      this.trackChains.get(track.id)!.chain.dispose();
      this.trackChains.delete(track.id);
    }
    if (this.pre[0].length < frames) this.pre = [new Float32Array(frames), new Float32Array(frames)];
    const [pl, pr] = this.pre;
    // clips with their own filters run through a chain of their own: track filters, then clip filters
    const fxClips = track.clips.filter((c) => hasActiveFx(c.fx));
    const plain = fxClips.length ? (c: Clip) => !hasActiveFx(c.fx) : undefined;
    let stereo: boolean;
    if (!state) stereo = this.renderRaw(track, position, frames, this.pre, plain);
    else stereo = this.runChain(state, position, frames, this.pre, (p, n, b) => this.renderRaw(track, p, n, b, plain));
    if (fxClips.length) {
      const tail = Math.round(CLIP_FX_TAIL_SECONDS * this.project.sampleRate);
      const end = position + frames;
      if (this.clipBuf[0].length < frames) this.clipBuf = [new Float32Array(frames), new Float32Array(frames)];
      const [cl, cr] = this.clipBuf;
      for (const clip of fxClips) {
        // a clip that is not playing keeps its chain idle; it is primed again when it comes back
        if (clip.start >= end || clip.start + clip.length + tail <= position) continue;
        const only = (c: Clip) => c === clip;
        const cs = this.clipChainState(track, clip);
        if (this.runChain(cs, position, frames, this.clipBuf, (p, n, b) => this.renderRaw(track, p, n, b, only))) stereo = true;
        for (let i = 0; i < frames; i++) {
          pl[i] += cl[i];
          pr[i] += cr[i];
        }
      }
    }
    // the folder's group volume adds to the track gain
    const g = dbToGain(track.gain + folderGainOf(this.project, track));
    const volPts = track.automation?.volume;
    const panPts = track.automation?.pan;
    const [ol, or] = out;
    let peak = 0;
    if (volPts?.length || panPts?.length) {
      // automated: gain and pan follow the lanes sample by sample
      if (this.autoVol.length < frames) {
        this.autoVol = new Float32Array(frames);
        this.autoPan = new Float32Array(frames);
      }
      const vol = this.autoVol;
      const pan = this.autoPan;
      if (volPts?.length) fillAutomation(volPts, position, frames, vol, volumeAmp);
      else vol.fill(1, 0, frames);
      if (panPts?.length) fillAutomation(panPts, position, frames, pan);
      else pan.fill(track.pan, 0, frames);
      let lastPan = NaN;
      let pg: [number, number] = [1, 1];
      for (let i = 0; i < frames; i++) {
        const p = pan[i];
        if (p !== lastPan) {
          lastPan = p;
          pg = stereo ? [Math.min(1, 1 - p), Math.min(1, 1 + p)] : panGains(p);
        }
        const gi = g * vol[i];
        const l = pl[i] * gi * pg[0];
        const r = (stereo ? pr[i] : pl[i]) * gi * pg[1];
        ol[i] += l;
        or[i] += r;
        if (this.metering) peak = Math.max(peak, Math.abs(l), Math.abs(r));
      }
    } else {
      const [panL, panR] = panGains(track.pan);
      // balance for stereo sources, pan law for mono ones
      const gl = g * (stereo ? Math.min(1, 1 - track.pan) : panL);
      const gr = g * (stereo ? Math.min(1, 1 + track.pan) : panR);
      for (let i = 0; i < frames; i++) {
        const l = pl[i] * gl;
        const r = (stereo ? pr[i] : pl[i]) * gr;
        ol[i] += l;
        or[i] += r;
        if (this.metering) peak = Math.max(peak, Math.abs(l), Math.abs(r));
      }
    }
    if (this.metering) this.trackPeaks.set(track.id, Math.max(peak, this.trackPeaks.get(track.id) ?? 0));
  }

  /**
   * Renders a track's clips (clip gain, fades, mute regions, volume line) for [position, position + frames)
   * into `buf` (overwritten; mono material is duplicated into both channels).
   * Returns true if any clip is stereo.
   */
  private renderRaw(track: Track, position: number, frames: number, buf: Float32Array[], include?: (c: Clip) => boolean): boolean {
    buf[0].fill(0, 0, frames);
    buf[1].fill(0, 0, frames);
    let stereoTrack = false;
    const end = position + frames;
    const ramp = Math.round(MUTE_RAMP_SECONDS * this.project.sampleRate);
    // only the mute regions touching this block, so the per-sample lookup stays short
    const muted = regionsOverlap(track, position, end) ? track.muteRegions!.filter(([a, b]) => a < end && b > position) : null;
    // declick every hard clip edge; a clip may play a few ms past its end to crossfade into the next one
    const declick = Math.round(DECLICK_SECONDS * this.project.sampleRate);
    const fades = trackFades(track, declick, (c) => this.readers.get(c.file)?.info.frames ?? 0);
    for (const id of this.noDeclickIn) if (fades.has(id)) fades.get(id)!.declickIn = 0;
    for (const id of this.noDeclickOut) if (fades.has(id)) Object.assign(fades.get(id)!, { declickOut: 0, tail: 0 });
    for (const clip of track.clips) {
      const reader = this.readers.get(clip.file);
      if (!reader) continue;
      const stereo = reader.info.channels >= 2;
      if (stereo) stereoTrack = true;
      if (include && !include(clip)) continue;
      const fade = fades.get(clip.id)!;
      const cStart = clip.start;
      const cEnd = clip.start + clip.length + fade.tail;
      if (cEnd <= position || cStart >= end) continue;
      const from = Math.max(position, cStart);
      const to = Math.min(end, cEnd);
      const n = to - from;
      if (this.scratch.length < reader.info.channels || (this.scratch[0]?.length ?? 0) < n) {
        const size = Math.max(n, this.scratch[0]?.length ?? 0);
        this.scratch = Array.from({ length: Math.max(2, reader.info.channels) }, () => new Float32Array(size));
      }
      const src = readClip(reader, clip, from - cStart, n, this.scratch);
      const g = dbToGain(clip.gain);
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

