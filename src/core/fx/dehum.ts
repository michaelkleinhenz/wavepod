// De-hum: removes mains hum and buzz (50 or 60 Hz and its harmonics). It measures the exact hum
// frequency itself (mains drifts a little around 50/60 Hz) and follows it, then cancels each
// harmonic with an adaptive sine model: the filter learns the hum's steady level and phase over
// about half a second and subtracts exactly that, so the voice, which never holds one exact
// frequency for long, passes through.
import type { FxProcessor } from './processors';
import { Biquad } from './biquad';
import { GainMeter } from './meter';

export const MAX_HARMONICS = 24;

/** Mains setting: 0 = find it, 1 = 50 Hz, 2 = 60 Hz. */
export type MainsMode = 0 | 1 | 2;

/**
 * Finds the hum fundamental in a decimated mono signal: the frequency near 50 or 60 Hz whose
 * harmonics together carry the most energy, if it clearly stands out. Returns null for no hum.
 */
export function findHum(x: Float32Array, fs: number, mode: MainsMode, harmonics: number): number | null {
  const bases = mode === 1 ? [50] : mode === 2 ? [60] : [50, 60];
  // 50 and 60 Hz share overtones (300 Hz, 600 Hz…), so the family with the most hum energy wins
  let best: { f: number; power: number } | null = null;
  const K = Math.max(1, Math.min(8, harmonics));
  const power = (f: number) => {
    let sum = 0;
    for (let k = 1; k <= K; k++) {
      const fk = k * f;
      if (fk > fs * 0.4) break;
      const w = (2 * Math.PI * fk) / fs;
      // Goertzel
      const c = 2 * Math.cos(w);
      let s1 = 0;
      let s2 = 0;
      for (let n = 0; n < x.length; n++) {
        const s0 = x[n] + c * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      sum += s1 * s1 + s2 * s2 - c * s1 * s2;
    }
    return sum;
  };
  for (const base of bases) {
    const grid: number[] = [];
    const ps: number[] = [];
    for (let f = base - 1; f <= base + 1 + 1e-9; f += 0.05) {
      grid.push(f);
      ps.push(power(f));
    }
    let bi = 0;
    for (let i = 1; i < ps.length; i++) if (ps[i] > ps[bi]) bi = i;
    // refine around the best grid point
    let bf = grid[bi];
    let bp = ps[bi];
    for (let f = grid[bi] - 0.05; f <= grid[bi] + 0.05 + 1e-9; f += 0.01) {
      const p = power(f);
      if (p > bp) {
        bp = p;
        bf = f;
      }
    }
    // compare with the same harmonics a little off the hum (between mains frequencies)
    const off = (power(base * 0.9) + power(base * 1.1)) / 2;
    const score = bp / (off + 1e-20);
    if (score > 8 && (!best || bp > best.power)) best = { f: bf, power: bp };
  }
  return best ? best.f : null;
}

export class DeHum implements FxProcessor {
  readonly latency = 0;
  private readonly decim: number;
  private readonly fsDec: number;
  private readonly lp1: Biquad;
  private readonly lp2: Biquad;
  private readonly ring: Float32Array;
  private ringPos = 0;
  private ringFill = 0;
  private decCount = 0;
  private sinceEstimate = 0;
  private readonly estimateEvery: number;
  /** The hum frequency being cancelled (kept across a jump in the timeline), or null. */
  freq: number | null = null;
  private mode: MainsMode = 0;
  private harmonics = 8;
  private humOnly = false;
  private mu = 0;
  private muFast = 0;
  private fastLeft = 0;
  // oscillators: cos/sin of each harmonic, advanced by rotation
  private readonly c = new Float64Array(MAX_HARMONICS);
  private readonly s = new Float64Array(MAX_HARMONICS);
  private readonly dc = new Float64Array(MAX_HARMONICS);
  private readonly ds = new Float64Array(MAX_HARMONICS);
  private readonly aL = new Float64Array(MAX_HARMONICS);
  private readonly bL = new Float64Array(MAX_HARMONICS);
  private readonly aR = new Float64Array(MAX_HARMONICS);
  private readonly bR = new Float64Array(MAX_HARMONICS);
  private active = 0;
  /** Frequency-locked loop between estimates (see track()). */
  private fllValid = false;
  private fllCount = 0;
  private meter = new GainMeter();
  private humE = 0;
  private sigE = 0;

  constructor(private sr: number) {
    this.decim = Math.max(1, Math.round(sr / 2000));
    this.fsDec = sr / this.decim;
    const cut = Math.min(700, this.fsDec * 0.4);
    this.lp1 = new Biquad('lowpass', cut, sr, 0.5412);
    this.lp2 = new Biquad('lowpass', cut, sr, 1.3066);
    this.ring = new Float32Array(Math.round(this.fsDec * 1.5));
    this.estimateEvery = Math.round(sr * 0.5);
    // the model's weights settle in about a second (narrow, so speech hardly disturbs them);
    // much quicker right after a jump or when the hum is first found
    this.mu = 2 / (1 * sr);
    this.muFast = 2 / (0.08 * sr);
    this.fastLeft = Math.round(0.15 * sr);
  }

  setParams(p: Record<string, number>): void {
    const mode = Math.round(p.mains ?? 0) as MainsMode;
    if (mode !== this.mode) {
      this.mode = mode;
      // measured again within the first half second, so it is not cancelled at a wrong frequency
      this.freq = null;
      this.setFreq(null);
    }
    this.harmonics = Math.max(1, Math.min(MAX_HARMONICS, Math.round(p.harmonics ?? 8)));
    this.humOnly = (p.output ?? 0) >= 1;
    this.setFreq(this.freq);
  }

  private setFreq(f: number | null): void {
    if (f === null) {
      this.active = 0;
      return;
    }
    let n = 0;
    for (let k = 1; k <= this.harmonics; k++) {
      if (k * f > this.sr * 0.45) break;
      const w = (2 * Math.PI * k * f) / this.sr;
      this.dc[k - 1] = Math.cos(w);
      this.ds[k - 1] = Math.sin(w);
      if (this.active < k) {
        // a newly switched-on harmonic starts in phase with the fundamental
        this.c[k - 1] = 1;
        this.s[k - 1] = 0;
        this.aL[k - 1] = this.bL[k - 1] = this.aR[k - 1] = this.bR[k - 1] = 0;
      }
      n = k;
    }
    this.active = n;
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    const { c, s, dc, ds, aL, bL, aR, bR } = this;
    for (let i = 0; i < n; i++) {
      const l = L[i];
      const r = R[i];
      // decimated copy for finding the hum
      const m = this.lp2.tick(this.lp1.tick(0.5 * (l + r), 0), 0);
      if (++this.decCount >= this.decim) {
        this.decCount = 0;
        this.ring[this.ringPos] = m;
        this.ringPos = (this.ringPos + 1) % this.ring.length;
        if (this.ringFill < this.ring.length) this.ringFill++;
      }
      // first guess after half a second, then every half second on the last 1.5 s
      if (++this.sinceEstimate >= this.estimateEvery && this.ringFill >= this.ring.length / 3) {
        this.sinceEstimate = 0;
        this.estimate();
      }
      const K = this.active;
      if (K === 0) continue;
      const mu = this.fastLeft > 0 ? this.muFast : this.mu;
      if (this.fastLeft > 0) this.fastLeft--;
      let hl = 0;
      let hr = 0;
      for (let k = 0; k < K; k++) {
        hl += aL[k] * c[k] + bL[k] * s[k];
        hr += aR[k] * c[k] + bR[k] * s[k];
      }
      const el = l - hl;
      const er = r - hr;
      for (let k = 0; k < K; k++) {
        aL[k] += mu * el * c[k];
        bL[k] += mu * el * s[k];
        aR[k] += mu * er * c[k];
        bR[k] += mu * er * s[k];
        // advance the oscillator
        const cn = c[k] * dc[k] - s[k] * ds[k];
        const sn = s[k] * dc[k] + c[k] * ds[k];
        c[k] = cn;
        s[k] = sn;
      }
      L[i] = this.humOnly ? hl : el;
      R[i] = this.humOnly ? hr : er;
      this.humE += hl * hl;
      this.sigE += l * l;
      if (++this.fllCount >= this.fllEvery) {
        this.fllCount = 0;
        this.track();
      }
    }
    // keep the oscillators on the unit circle
    for (let k = 0; k < this.active; k++) {
      const g = 1 / Math.hypot(c[k], s[k]);
      c[k] *= g;
      s[k] *= g;
    }
    if (this.sigE > 0) this.meter.note(Math.max(-60, 10 * Math.log10(Math.max(1e-6, 1 - Math.min(0.999999, this.humE / this.sigE)))));
    this.humE = 0;
    this.sigE = 0;
  }

  private readonly fllEvery = 12000;
  private readonly fllPrev = new Float64Array(MAX_HARMONICS * 2);

  /**
   * Fine tracking between estimates: if the hum runs slightly faster or slower than our
   * oscillators, the learned phase of each harmonic turns; that turning is the frequency error.
   * All harmonics vote, weighted by their strength.
   */
  private track(): void {
    if (this.active === 0 || this.freq === null) return;
    const prev = this.fllPrev;
    let num = 0;
    let den = 0;
    for (let j = 0; j < this.active; j++) {
      const a = this.aL[j] + this.aR[j];
      const b = this.bL[j] + this.bR[j];
      const pa = prev[2 * j];
      const pb = prev[2 * j + 1];
      prev[2 * j] = a;
      prev[2 * j + 1] = b;
      if (!this.fllValid) continue;
      // angle between the previous and the current weight vector, and how sure we are of it
      const w = Math.hypot(a, b) * Math.hypot(pa, pb);
      if (w < 1e-12) continue;
      const d = Math.atan2(pa * b - pb * a, pa * a + pb * b);
      // the model is A·cos(phase + error) = a·cos − b·sin, so the angle turns backwards
      num += w * (-d / (j + 1));
      den += w;
    }
    if (this.fllValid && den > 0) {
      const df = num / den / (2 * Math.PI * (this.fllEvery / this.sr));
      const base = this.mode === 2 || (this.mode === 0 && this.freq > 55) ? 60 : 50;
      const f = Math.min(base + 1.5, Math.max(base - 1.5, this.freq + 0.3 * df));
      this.freq = f;
      this.setFreq(f);
    }
    this.fllValid = true;
  }

  private estimate(): void {
    const n = this.ring.length;
    const x = new Float32Array(this.ringFill);
    for (let i = 0; i < this.ringFill; i++) x[i] = this.ring[(this.ringPos - this.ringFill + i + n) % n];
    const f = findHum(x, this.fsDec, this.mode, this.harmonics);
    if (f === null) {
      // keep what we have (speech can hide the hum for a moment); with the mains frequency
      // given, start from its nominal value
      if (this.freq === null && this.mode !== 0) {
        this.freq = this.mode === 1 ? 50 : 60;
        this.setFreq(this.freq);
      }
      return;
    }
    if (this.freq === null || Math.abs(f - this.freq) > 0.1) {
      this.freq = f;
      this.setFreq(f);
      this.fastLeft = Math.round(0.3 * this.sr);
      this.fllValid = false;
    }
  }

  /** How much the hum takes of the signal, shown on the card. */
  takeGain(): number {
    return this.meter.take();
  }

  reset(): void {
    this.lp1.reset();
    this.lp2.reset();
    this.aL.fill(0);
    this.bL.fill(0);
    this.aR.fill(0);
    this.bR.fill(0);
    this.fastLeft = Math.round(0.15 * this.sr);
    this.fllValid = false;
    this.ring.fill(0);
    this.ringFill = 0;
    this.ringPos = 0;
    this.sinceEstimate = 0;
  }
}
