// Filter processors. Each works in place on two planar channels and keeps its own state.
import type { Fx, FxType } from '../../shared/types';
import { VstProcessor } from './vst';
import { Biquad } from './biquad';
import { PeakLimiter, UltraschallDynamics } from './ultraschallDynamics';
import { GainMeter } from './meter';
import { NoiseReduction } from './denoise';
import { Reverb } from './reverb';

export interface FxProcessor {
  /** Delay the processor adds, in frames (compensated by the mixer). */
  readonly latency: number;
  setParams(params: Record<string, number>): void;
  process(L: Float32Array, R: Float32Array, n: number): void;
  reset(): void;
  /** Frees external resources (VST3 instances). */
  dispose?(): void;
  /**
   * For meters: the gain change in dB with the largest magnitude since the previous call
   * (negative = reduction), then starts over. Only filters that change gain dynamically have it.
   */
  takeGain?(): number;
  /** For meters: the level (dB) the filter's detector currently sees (Dynamics). */
  detectorLevel?(): number;
}



const dbToLin = (db: number) => Math.pow(10, db / 20);
const linToDb = (v: number) => (v > 1e-12 ? 20 * Math.log10(v) : -240);
/** One-pole smoothing coefficient for a time constant in ms. */
const coef = (ms: number, sr: number) => (ms <= 0 ? 0 : Math.exp(-1 / ((ms / 1000) * sr)));
const paramKey = (p: Record<string, number>) => Object.keys(p).sort().map((k) => `${k}=${p[k]}`).join('&');

class HighPass implements FxProcessor {
  readonly latency = 0;
  private stages: Biquad[] = [];
  private key = '';
  constructor(private sr: number) {}
  setParams(p: Record<string, number>): void {
    const key = paramKey(p);
    if (key === this.key) return;
    this.key = key;
    // Butterworth: one stage (12 dB/oct) or two stages with the 4th-order Qs (24 dB/oct)
    const qs = p.slope >= 24 ? [0.5412, 1.3066] : [Math.SQRT1_2];
    if (this.stages.length !== qs.length) this.stages = qs.map((q) => new Biquad('highpass', p.freq, this.sr, q));
    else this.stages.forEach((s, i) => s.set('highpass', p.freq, this.sr, qs[i]));
  }
  process(L: Float32Array, R: Float32Array, n: number): void {
    for (const s of this.stages) {
      s.process(L, n, 0);
      s.process(R, n, 1);
    }
  }
  reset(): void {
    for (const s of this.stages) s.reset();
  }
}

class Equalizer implements FxProcessor {
  readonly latency = 0;
  private bands: Biquad[] = [];
  private key = '';
  constructor(private sr: number) {}
  setParams(p: Record<string, number>): void {
    const key = paramKey(p);
    if (key === this.key) return;
    this.key = key;
    const next: Array<[Biquad['set'] extends (...a: infer A) => void ? A : never, number]> = [];
    const add = (kind: 'lowshelf' | 'peaking' | 'highshelf', f: number, g: number, q: number) => {
      if (Math.abs(g) >= 0.05) next.push([[kind, f, this.sr, q, g], g]);
    };
    add('lowshelf', p.lsFreq, p.lsGain, Math.SQRT1_2);
    add('peaking', p.p1Freq, p.p1Gain, p.p1Q);
    add('peaking', p.p2Freq, p.p2Gain, p.p2Q);
    add('highshelf', p.hsFreq, p.hsGain, Math.SQRT1_2);
    if (next.length !== this.bands.length) this.bands = next.map(([a]) => new Biquad(...a));
    else next.forEach(([a], i) => this.bands[i].set(...a));
  }
  process(L: Float32Array, R: Float32Array, n: number): void {
    for (const b of this.bands) {
      b.process(L, n, 0);
      b.process(R, n, 1);
    }
  }
  reset(): void {
    for (const b of this.bands) b.reset();
  }
}

class NoiseGate implements FxProcessor {
  /** Pre-open: the detector sees the signal this many frames before it is heard. */
  latency = 0;
  private env = 0;
  private gain = 1;
  private holdLeft = 0;
  private open = false;
  private thresh = 0;
  private closeThresh = 0;
  private floor = 1;
  private envRelease = 0;
  private att = 0;
  private rel = 0;
  private holdFrames = 0;
  private delayL = new Float32Array(0);
  private delayR = new Float32Array(0);
  private pos = 0;
  constructor(private sr: number) {}
  setParams(p: Record<string, number>): void {
    this.thresh = dbToLin(p.threshold);
    // hysteresis against chattering: the gate closes only below threshold minus this
    this.closeThresh = dbToLin(p.threshold - Math.max(0, p.hysteresis ?? 4));
    this.floor = dbToLin(p.range);
    this.att = coef(p.attack, this.sr);
    this.rel = coef(p.release, this.sr);
    this.envRelease = coef(20, this.sr);
    this.holdFrames = Math.round((p.hold / 1000) * this.sr);
    const lookahead = Math.max(0, Math.round(((p.preopen ?? 0) / 1000) * this.sr));
    if (lookahead !== this.latency) {
      this.latency = lookahead;
      this.delayL = new Float32Array(lookahead);
      this.delayR = new Float32Array(lookahead);
      this.pos = 0;
    }
  }
  process(L: Float32Array, R: Float32Array, n: number): void {
    const lat = this.latency;
    for (let i = 0; i < n; i++) {
      const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      this.env = a > this.env ? a : a + this.envRelease * (this.env - a);
      if (this.env >= this.thresh) {
        this.open = true;
        this.holdLeft = this.holdFrames;
      } else if (this.open && this.env < this.closeThresh) {
        if (this.holdLeft > 0) this.holdLeft--;
        else this.open = false;
      }
      const target = this.open ? 1 : this.floor;
      const c = target > this.gain ? this.att : this.rel;
      this.gain = target + c * (this.gain - target);
      let l = L[i];
      let r = R[i];
      if (lat > 0) {
        const dl = this.delayL[this.pos];
        const dr = this.delayR[this.pos];
        this.delayL[this.pos] = l;
        this.delayR[this.pos] = r;
        this.pos = this.pos + 1 === lat ? 0 : this.pos + 1;
        l = dl;
        r = dr;
      }
      L[i] = l * this.gain;
      R[i] = r * this.gain;
    }
    this.meter.note(linToDb(this.gain));
  }
  private meter = new GainMeter();
  takeGain(): number {
    return this.meter.take();
  }
  reset(): void {
    this.env = 0;
    this.gain = this.floor;
    this.open = false;
    this.holdLeft = 0;
    this.delayL.fill(0);
    this.delayR.fill(0);
    this.pos = 0;
  }
}

class Compressor implements FxProcessor {
  readonly latency = 0;
  private grDb = 0;
  private gain = 1;
  private p: Record<string, number> = {};
  private att = 0;
  private rel = 0;
  private makeup = 1;
  constructor(private sr: number) {}
  setParams(p: Record<string, number>): void {
    this.p = p;
    this.att = coef(p.attack, this.sr);
    this.rel = coef(p.release, this.sr);
    this.makeup = dbToLin(p.makeup);
  }
  /** Static gain computer with soft knee: gain reduction in dB (≤ 0) for an input level in dB. */
  static reduction(x: number, threshold: number, ratio: number, knee: number): number {
    const over = x - threshold;
    const slope = 1 / ratio - 1;
    if (knee > 0 && Math.abs(over) <= knee / 2) return (slope * (over + knee / 2) ** 2) / (2 * knee);
    return over > 0 ? slope * over : 0;
  }
  process(L: Float32Array, R: Float32Array, n: number): void {
    const { threshold, ratio, knee } = this.p;
    // the gain computer runs every STEP samples on the peak of that span; gain is interpolated
    const STEP = 8;
    for (let i0 = 0; i0 < n; i0 += STEP) {
      const m = Math.min(STEP, n - i0);
      let peak = 0;
      for (let i = i0; i < i0 + m; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
      const target = Compressor.reduction(linToDb(peak), threshold, ratio, knee);
      const c = Math.pow(target < this.grDb ? this.att : this.rel, m);
      this.grDb = target + c * (this.grDb - target);
      const g1 = dbToLin(this.grDb) * this.makeup;
      const dg = (g1 - this.gain) / m;
      for (let i = i0; i < i0 + m; i++) {
        this.gain += dg;
        L[i] *= this.gain;
        R[i] *= this.gain;
      }
      this.meter.note(this.grDb);
    }
  }
  private meter = new GainMeter();
  /** Gain reduction only (make-up gain is static and not shown). */
  takeGain(): number {
    return this.meter.take();
  }
  reset(): void {
    this.grDb = 0;
    this.gain = this.makeup;
  }
}

/**
 * Split-band de-esser: a high-passed sidechain detects sibilance; when it gets too loud, a high
 * shelf at the same frequency turns down only the highs (updated every 32 samples).
 */
class DeEsser implements FxProcessor {
  readonly latency = 0;
  private detect = new Biquad('highpass', 5500, 48000);
  private shelf = new Biquad('highshelf', 5500, 48000);
  private env = 0;
  private grDb = 0;
  private shelfDb = 0;
  private freq = 5500;
  private thresh = 0;
  private maxRed = 12;
  private envRelease = 0;
  private att = 0;
  private rel = 0;
  private key = '';
  constructor(private sr: number) {}
  setParams(p: Record<string, number>): void {
    const key = paramKey(p);
    if (key === this.key) return;
    this.key = key;
    this.freq = p.freq;
    this.detect.set('highpass', p.freq, this.sr, Math.SQRT1_2);
    this.shelf.set('highshelf', p.freq, this.sr, Math.SQRT1_2, this.shelfDb);
    this.thresh = p.threshold;
    this.maxRed = p.maxReduction;
    this.envRelease = coef(10, this.sr);
    this.att = coef(1, this.sr);
    this.rel = coef(p.release, this.sr);
  }
  process(L: Float32Array, R: Float32Array, n: number): void {
    for (let i0 = 0; i0 < n; i0 += 32) {
      const m = Math.min(32, n - i0);
      for (let i = i0; i < i0 + m; i++) {
        const a = Math.max(Math.abs(this.detect.tick(L[i], 0)), Math.abs(this.detect.tick(R[i], 1)));
        this.env = a > this.env ? a : a + this.envRelease * (this.env - a);
        const target = -Math.min(this.maxRed, Math.max(0, (linToDb(this.env) - this.thresh) * 0.75));
        const c = target < this.grDb ? this.att : this.rel;
        this.grDb = target + c * (this.grDb - target);
      }
      this.meter.note(this.grDb);
      if (Math.abs(this.grDb - this.shelfDb) > 0.05) {
        this.shelfDb = this.grDb;
        this.shelf.set('highshelf', this.freq, this.sr, Math.SQRT1_2, this.shelfDb);
      }
      if (this.shelfDb < -0.05) {
        this.shelf.process(L.subarray(i0, i0 + m), m, 0);
        this.shelf.process(R.subarray(i0, i0 + m), m, 1);
      } else {
        // keep the shelf's state warm while it is flat
        for (let i = i0; i < i0 + m; i++) {
          this.shelf.tick(L[i], 0);
          this.shelf.tick(R[i], 1);
        }
      }
    }
  }
  private meter = new GainMeter();
  /** Reduction of the high band. */
  takeGain(): number {
    return this.meter.take();
  }
  reset(): void {
    this.detect.reset();
    this.shelf.reset();
    this.env = 0;
    this.grDb = 0;
  }
}

class Limiter implements FxProcessor {
  readonly latency = 0;
  private lim: PeakLimiter;
  constructor(sr: number) {
    this.lim = new PeakLimiter(sr);
  }
  setParams(p: Record<string, number>): void {
    this.lim.configure(dbToLin(p.ceiling), 1, p.release / 1000);
  }
  process(L: Float32Array, R: Float32Array, n: number): void {
    let min = 1;
    for (let i = 0; i < n; i++) {
      const g = this.lim.gain(L[i], R[i]);
      if (g < min) min = g;
      L[i] *= g;
      R[i] *= g;
    }
    this.meter.note(linToDb(min));
  }
  private meter = new GainMeter();
  takeGain(): number {
    return this.meter.take();
  }
  reset(): void {
    this.lim.reset();
  }
}

export function createProcessor(type: FxType, sampleRate: number, fx?: Fx): FxProcessor {
  switch (type) {
    case 'vst3':
      return new VstProcessor(fx ?? { id: '', type, enabled: true, params: {} }, sampleRate);
    case 'highpass':
      return new HighPass(sampleRate);
    case 'eq':
      return new Equalizer(sampleRate);
    case 'gate':
      return new NoiseGate(sampleRate);
    case 'compressor':
      return new Compressor(sampleRate);
    case 'deesser':
      return new DeEsser(sampleRate);
    case 'limiter':
      return new Limiter(sampleRate);
    case 'dynamics':
      return new UltraschallDynamics(sampleRate);
    case 'denoise':
      return new NoiseReduction(sampleRate);
    case 'reverb':
      return new Reverb(sampleRate);
  }
}

export { Compressor };
