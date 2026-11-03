// EBU R128 / ITU-R BS.1770-4 loudness meter: integrated, momentary, short-term, LRA, true peak.
import type { Clip, LoudnessStats } from '../shared/types';

interface Biquad {
  b0: number; b1: number; b2: number; a1: number; a2: number;
}

/** K-weighting filter coefficients for an arbitrary sample rate (BS.1770 derivation). */
export function kWeighting(sampleRate: number): [Biquad, Biquad] {
  // Stage 1: high-shelf
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / sampleRate);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf: Biquad = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  // Stage 2: high-pass (RLB)
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / sampleRate);
  a0 = 1 + K / Q + K * K;
  const hp: Biquad = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  return [shelf, hp];
}

class BiquadState {
  x1 = 0; x2 = 0; y1 = 0; y2 = 0;
  constructor(private c: Biquad) {}
  process(x: number): number {
    const { b0, b1, b2, a1, a2 } = this.c;
    const y = b0 * x + b1 * this.x1 + b2 * this.x2 - a1 * this.y1 - a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

/**
 * True-peak detector (BS.1770-4 Annex 2): 4x oversampling with a windowed-sinc
 * interpolator, 12 taps per phase. Interpolation only runs where the signal is
 * within 12 dB of the highest peak so far, which keeps long programmes cheap;
 * an inter-sample peak more than 12 dB above both neighbouring samples does
 * not occur in band-limited audio.
 */
const TP_TAPS = 12;
const TP_PHASES = 4;
const TP_COEFFS: Float64Array[] = (() => {
  const half = TP_TAPS / 2;
  const phases: Float64Array[] = [];
  for (let p = 1; p < TP_PHASES; p++) {
    const frac = p / TP_PHASES;
    const c = new Float64Array(TP_TAPS);
    let sum = 0;
    for (let j = 0; j < TP_TAPS; j++) {
      // tap j holds sample n - (TP_TAPS - 1) + j; the point lies between taps half-1 and half
      const d = j - (half - 1) - frac;
      const sinc = d === 0 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d);
      const w = 0.42 + 0.5 * Math.cos((Math.PI * d) / (half + 0.5)) + 0.08 * Math.cos((2 * Math.PI * d) / (half + 0.5));
      c[j] = sinc * w;
      sum += c[j];
    }
    for (let j = 0; j < TP_TAPS; j++) c[j] /= sum;
    phases.push(c);
  }
  return phases;
})();

class TruePeak {
  private hist: Float64Array;
  private pos = 0;
  peak = 0;

  constructor() {
    this.hist = new Float64Array(TP_TAPS * 2);
  }

  push(x: number): void {
    const ax = Math.abs(x);
    if (ax > this.peak) this.peak = ax;
    // doubled ring buffer: the last TP_TAPS samples are always contiguous at [pos, pos + TP_TAPS)
    const h = this.hist;
    h[this.pos] = x;
    h[this.pos + TP_TAPS] = x;
    this.pos = (this.pos + 1) % TP_TAPS;
    const a = Math.abs(h[this.pos + TP_TAPS / 2 - 1]);
    const b = Math.abs(h[this.pos + TP_TAPS / 2]);
    if (Math.max(a, b) < this.peak * 0.25) return;
    for (const c of TP_COEFFS) {
      let y = 0;
      for (let j = 0; j < TP_TAPS; j++) y += c[j] * h[this.pos + j];
      const ay = Math.abs(y);
      if (ay > this.peak) this.peak = ay;
    }
  }
}

/** Short-term loudness history kept for plots: one value per this many seconds at most. */
const HISTORY_POINTS = 1200;

/**
 * Streaming loudness meter. Push planar blocks; read `integrated()` or the
 * full `stats()` at the end.
 *
 * Measures the EBU R128 / Tech 3341 / 3342 quantities: integrated (gated),
 * momentary (400 ms) and short-term (3 s) maximum, loudness range (LRA),
 * true peak (dBTP) and sample peak.
 *
 * Per BS.1770 a mono signal is a single channel with weight 1.0, so it reads
 * 3 LU lower than the same signal on both channels of a stereo file.
 */
export class LoudnessMeter {
  private filters: Array<[BiquadState, BiquadState]>;
  private tp: TruePeak[];
  private hop: number;
  /** Energies of the last 30 sub-blocks of 100 ms (sum over channels, not yet averaged). */
  private ring = new Float64Array(30);
  private subCount = 0;
  private subFill = 0;
  private subAcc = 0;
  private frames = 0;
  /** Mean square of every 400 ms block (momentary), 100 ms apart. */
  private blockEnergies: number[] = [];
  /** Mean square of every 3 s block (short-term), 100 ms apart. */
  private shortEnergies: number[] = [];
  private peak = 0;

  constructor(readonly sampleRate: number, readonly channels: number) {
    const [shelf, hp] = kWeighting(sampleRate);
    this.filters = Array.from({ length: channels }, () => [new BiquadState(shelf), new BiquadState(hp)]);
    this.tp = Array.from({ length: channels }, () => new TruePeak());
    this.hop = Math.round(sampleRate * 0.1);
  }

  push(planar: Float32Array[], frames = planar[0]?.length ?? 0): void {
    const n = this.channels;
    this.frames += frames;
    for (let i = 0; i < frames; i++) {
      let e = 0;
      for (let c = 0; c < n; c++) {
        const x = planar[c][i];
        const ax = Math.abs(x);
        if (ax > this.peak) this.peak = ax;
        this.tp[c].push(x);
        const [f1, f2] = this.filters[c];
        const y = f2.process(f1.process(x));
        e += y * y; // channel weights are 1.0 for L/R/C
      }
      this.subAcc += e;
      if (++this.subFill === this.hop) this.endSubBlock();
    }
  }

  private endSubBlock(): void {
    const ring = this.ring;
    ring[this.subCount % 30] = this.subAcc;
    this.subCount++;
    this.subAcc = 0;
    this.subFill = 0;
    if (this.subCount >= 4) {
      let sum = 0;
      for (let k = 1; k <= 4; k++) sum += ring[(this.subCount - k) % 30];
      this.blockEnergies.push(sum / (this.hop * 4));
    }
    if (this.subCount >= 30) {
      let sum = 0;
      for (let k = 0; k < 30; k++) sum += ring[k];
      this.shortEnergies.push(sum / (this.hop * 30));
    }
  }

  /** Integrated loudness in LUFS (−Infinity for silence / too short). */
  integrated(): number {
    return gatedLoudness(this.blockEnergies, -10);
  }

  /** Loudness of the last 400 ms in LUFS (−Infinity before the first block). */
  momentary(): number {
    const z = this.blockEnergies[this.blockEnergies.length - 1];
    return z > 0 ? energyToLufs(z) : -Infinity;
  }

  /** Loudness of the last 3 s in LUFS (−Infinity before the first 3 s). */
  shortTerm(): number {
    const z = this.shortEnergies[this.shortEnergies.length - 1];
    return z > 0 ? energyToLufs(z) : -Infinity;
  }

  /** Sample peak in dBFS. */
  peakDb(): number {
    return linToDb(this.peak);
  }

  /** True peak in dBTP. */
  truePeakDb(): number {
    let p = this.peak;
    for (const t of this.tp) if (t.peak > p) p = t.peak;
    return linToDb(p);
  }

  /**
   * Loudness range in LU (EBU Tech 3342): spread between the 10th and 95th
   * percentile of the short-term loudness, gated at −70 LUFS and 20 LU below
   * the programme. 0 for material shorter than 3 s.
   */
  range(): number {
    const abs = this.shortEnergies.filter((z) => z > 0 && energyToLufs(z) > -70);
    if (abs.length === 0) return 0;
    const relGate = energyToLufs(mean(abs)) - 20;
    const values = abs.map(energyToLufs).filter((l) => l > relGate).sort((a, b) => a - b);
    if (values.length === 0) return 0;
    const pct = (p: number) => values[Math.min(values.length - 1, Math.max(0, Math.round(p * (values.length - 1))))];
    return pct(0.95) - pct(0.1);
  }

  stats(): LoudnessStats {
    const maxOf = (zs: number[]) => {
      let m = 0;
      for (const z of zs) if (z > m) m = z;
      return m > 0 ? energyToLufs(m) : -Infinity;
    };
    // the short-term curve for plots, thinned to at most HISTORY_POINTS values (max per bucket)
    const st = this.shortEnergies;
    const stride = Math.max(1, Math.ceil(st.length / HISTORY_POINTS));
    const history: number[] = [];
    for (let i = 0; i < st.length; i += stride) history.push(maxOf(st.slice(i, i + stride)));
    return {
      integrated: this.integrated(),
      range: this.range(),
      shortTermMax: maxOf(st),
      momentaryMax: maxOf(this.blockEnergies),
      truePeak: this.truePeakDb(),
      samplePeak: this.peakDb(),
      duration: this.frames / this.sampleRate,
      history,
      // the first value covers the first 3 s, the next ones are 100 ms (times the stride) apart
      historyStep: stride * 0.1,
    };
  }
}

/** Loudness of gated blocks (absolute gate −70 LUFS, relative gate `relative` LU). */
function gatedLoudness(energies: number[], relative: number): number {
  const abs = energies.filter((z) => z > 0 && energyToLufs(z) > -70);
  if (abs.length === 0) return -Infinity;
  const relGate = energyToLufs(mean(abs)) + relative;
  const rel = abs.filter((z) => energyToLufs(z) > relGate);
  if (rel.length === 0) return -Infinity;
  return energyToLufs(mean(rel));
}

function linToDb(v: number): number {
  return v > 0 ? 20 * Math.log10(v) : -Infinity;
}

/** Shifts measured loudness figures by a gain change (LRA is unaffected). */
export function shiftStats(s: LoudnessStats, gainDb: number): LoudnessStats {
  if (gainDb === 0) return s;
  return {
    ...s,
    integrated: s.integrated + gainDb,
    shortTermMax: s.shortTermMax + gainDb,
    momentaryMax: s.momentaryMax + gainDb,
    truePeak: s.truePeak + gainDb,
    samplePeak: s.samplePeak + gainDb,
    history: s.history.map((v) => v + gainDb),
  };
}

function energyToLufs(z: number): number {
  return -0.691 + 10 * Math.log10(z);
}

function mean(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/**
 * Gain (dB) to reach `target` LUFS without the peak exceeding `ceiling`
 * (pass a sample peak in dBFS or a true peak in dBTP).
 */
export function normalizationGain(measured: number, peakDb: number, target: number, ceiling: number): number {
  if (!Number.isFinite(measured)) return 0;
  let gain = target - measured;
  if (Number.isFinite(peakDb) && peakDb + gain > ceiling) gain = ceiling - peakDb;
  return gain;
}

export interface LoudnessTarget {
  /** Integrated loudness to reach, LUFS. */
  lufs: number;
  /** Highest allowed true peak, dBTP. */
  ceiling: number;
}

/**
 * New clip gain (dB, in 0.1 dB steps) that brings a clip measured with its
 * current gain to the target, or null when the clip is silent.
 */
export function normalizedClipGain(clip: Clip, stats: LoudnessStats, target: LoudnessTarget): number | null {
  if (!Number.isFinite(stats.integrated)) return null;
  const delta = normalizationGain(stats.integrated, stats.truePeak, target.lufs, target.ceiling);
  // rounded down so the peak stays under the ceiling
  return Math.floor((clip.gain + delta) * 10 + 1e-6) / 10;
}
