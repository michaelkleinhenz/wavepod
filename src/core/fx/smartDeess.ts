// Smart de-esser & de-plosive: dynamic band reduction that only acts where an "s" or a "p"/"b" pop
// happens. Both detectors compare a band with the rest of the voice (not with a fixed threshold),
// so they work at any recording level, and they turn the band down just far enough to bring it
// back to a natural balance. Wherever it does nothing the voice passes bit for bit.
import type { FxProcessor } from './processors';
import { Biquad } from './biquad';
import { GainMeter } from './meter';

const linToDb = (v: number) => (v > 1e-12 ? 20 * Math.log10(v) : -240);
const coef = (ms: number, sr: number) => Math.exp(-1 / ((ms / 1000) * sr));

/** Two cascaded Butterworth biquads (4th order low- or high-pass), one state per channel. */
class Butter4 {
  private a: Biquad;
  private b: Biquad;
  constructor(private kind: 'lowpass' | 'highpass', freq: number, sr: number) {
    this.a = new Biquad(kind, freq, sr, 0.5412);
    this.b = new Biquad(kind, freq, sr, 1.3066);
  }
  set(freq: number, sr: number): void {
    this.a.set(this.kind, freq, sr, 0.5412);
    this.b.set(this.kind, freq, sr, 1.3066);
  }
  tick(x: number, ch: number): number {
    return this.b.tick(this.a.tick(x, ch), ch);
  }
  reset(): void {
    this.a.reset();
    this.b.reset();
  }
}

/** Highest share of the voice's energy an "s" may have, for a sensitivity in %. */
export function sibilanceTarget(sensitivity: number): number {
  return 0.55 - 0.004 * Math.min(100, Math.max(0, sensitivity));
}

/** Highest ratio of pop band to the rest of the voice, for a sensitivity in %. */
export function popTarget(sensitivity: number): number {
  return Math.pow(10, (12 - 0.12 * Math.min(100, Math.max(0, sensitivity))) / 10);
}

export class SmartDeesser implements FxProcessor {
  readonly latency: number;
  private readonly sHighDet: Butter4;
  private readonly pLowDet: Butter4;
  private readonly pRestDet: Butter4;
  private readonly sLowL: Butter4;
  private readonly sLowR: Butter4;
  private readonly pHighL: Butter4;
  private readonly pHighR: Butter4;
  private readonly dL: Float32Array;
  private readonly dR: Float32Array;
  private pos = 0;
  private eHigh = 0;
  private eFull = 0;
  private eLow = 0;
  private eRest = 0;
  private gS = 1;
  private gP = 1;
  private tS = 1;
  private tP = 1;
  private sMax = 0;
  private pMax = 0;
  private sTarget = 0.35;
  private pTarget = 1;
  private removedOnly = false;
  private key = '';
  private readonly cFast: number;
  private readonly cSlow: number;
  private readonly cAtt: number;
  private readonly cRelS: number;
  private readonly cRelP: number;
  private readonly gate = Math.pow(10, -55 / 10);
  private meter = new GainMeter();
  /** Frames during which each band was reduced by more than 1 dB (for tests). */
  sibilantFrames = 0;
  popFrames = 0;

  constructor(private sr: number) {
    this.latency = Math.round(0.003 * sr);
    this.dL = new Float32Array(Math.max(1, this.latency));
    this.dR = new Float32Array(Math.max(1, this.latency));
    this.sHighDet = new Butter4('highpass', 5000, sr);
    this.pRestDet = new Butter4('highpass', 150, sr);
    this.sLowL = new Butter4('lowpass', 5000, sr);
    this.sLowR = new Butter4('lowpass', 5000, sr);
    this.pLowDet = new Butter4('lowpass', 150, sr);
    this.pHighL = new Butter4('highpass', 150, sr);
    this.pHighR = new Butter4('highpass', 150, sr);
    this.cFast = coef(2, sr);
    this.cSlow = coef(15, sr);
    this.cAtt = coef(1, sr);
    this.cRelS = coef(40, sr);
    this.cRelP = coef(60, sr);
  }

  setParams(p: Record<string, number>): void {
    const key = `${p.freq}|${p.popFreq}`;
    if (key !== this.key) {
      this.key = key;
      const fs = p.freq ?? 5000;
      this.sHighDet.set(fs, this.sr);
      for (const f of [this.sLowL, this.sLowR]) f.set(fs, this.sr);
      const fp = p.popFreq ?? 150;
      for (const f of [this.pLowDet, this.pRestDet, this.pHighL, this.pHighR]) f.set(fp, this.sr);
    }
    this.sMax = Math.max(0, p.deess ?? 10);
    this.pMax = Math.max(0, p.deplosive ?? 12);
    this.sTarget = sibilanceTarget(p.sSensitivity ?? 50);
    this.pTarget = popTarget(p.pSensitivity ?? 50);
    this.removedOnly = (p.output ?? 0) >= 1;
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    const lat = this.latency;
    const { cFast, cSlow, cAtt, cRelS, cRelP, gate } = this;
    let minDb = 0;
    for (let i = 0; i < n; i++) {
      // detector: sees the sound `latency` frames before it is changed
      const m = 0.5 * (L[i] + R[i]);
      const hi = this.sHighDet.tick(m, 0);
      const lo = this.pLowDet.tick(m, 0);
      const rest = this.pRestDet.tick(m, 0);
      const h2 = hi * hi;
      const m2 = m * m;
      const l2 = lo * lo;
      const r2 = rest * rest;
      // fast attack, slower release for the energies
      this.eHigh = h2 + (h2 > this.eHigh ? cFast : cSlow) * (this.eHigh - h2);
      this.eFull = m2 + (m2 > this.eFull ? cFast : cSlow) * (this.eFull - m2);
      this.eLow = l2 + (l2 > this.eLow ? cFast : cSlow) * (this.eLow - l2);
      this.eRest = r2 + (r2 > this.eRest ? cFast : cSlow) * (this.eRest - r2);
      if ((i & 15) === 0) {
        // s: turn the highs down until they are at most sTarget of the whole again
        this.tS = 1;
        if (this.sMax > 0 && this.eFull > gate) {
          const share = this.eHigh / this.eFull;
          if (share > this.sTarget) {
            const other = Math.max(0, this.eFull - this.eHigh);
            const g2 = (this.sTarget * other) / ((1 - this.sTarget) * this.eHigh);
            this.tS = Math.max(Math.pow(10, -this.sMax / 20), Math.sqrt(Math.max(0, g2)));
          }
        }
        // pop: turn the lows down until they are at most pTarget times the rest again
        this.tP = 1;
        if (this.pMax > 0 && this.eLow > gate) {
          const ratio = this.eLow / (this.eRest + 1e-12);
          if (ratio > this.pTarget) this.tP = Math.max(Math.pow(10, -this.pMax / 20), Math.sqrt(this.pTarget / ratio));
        }
      }
      this.gS = this.tS + (this.tS < this.gS ? cAtt : cRelS) * (this.gS - this.tS);
      this.gP = this.tP + (this.tP < this.gP ? cAtt : cRelP) * (this.gP - this.tP);
      // back to exactly 1 once the release is inaudibly close, so the voice passes bit for bit
      if (this.gS > 0.9999) this.gS = 1;
      if (this.gP > 0.9999) this.gP = 1;
      // audio path, delayed
      let l = L[i];
      let r = R[i];
      if (lat > 0) {
        const dl = this.dL[this.pos];
        const dr = this.dR[this.pos];
        this.dL[this.pos] = l;
        this.dR[this.pos] = r;
        this.pos = this.pos + 1 === lat ? 0 : this.pos + 1;
        l = dl;
        r = dr;
      }
      // each stage turns everything down by g and adds back the part it keeps, (1 − g) times
      // through a filter, so the reduced band is exact in level whatever the filter's phase
      const sl = this.sLowL.tick(l, 0);
      const sr = this.sLowR.tick(r, 1);
      const ml = this.gS === 1 ? l : this.gS * l + (1 - this.gS) * sl;
      const mr = this.gS === 1 ? r : this.gS * r + (1 - this.gS) * sr;
      const pl = this.pHighL.tick(ml, 0);
      const pr = this.pHighR.tick(mr, 1);
      const yl = this.gP === 1 ? ml : this.gP * ml + (1 - this.gP) * pl;
      const yr = this.gP === 1 ? mr : this.gP * mr + (1 - this.gP) * pr;
      L[i] = this.removedOnly ? l - yl : yl;
      R[i] = this.removedOnly ? r - yr : yr;
      if (this.gS < 0.89) this.sibilantFrames++;
      if (this.gP < 0.89) this.popFrames++;
      const g = Math.min(this.gS, this.gP);
      if (g < 1) minDb = Math.min(minDb, linToDb(g));
    }
    this.meter.note(minDb);
  }

  takeGain(): number {
    return this.meter.take();
  }

  reset(): void {
    for (const f of [this.sHighDet, this.pRestDet, this.sLowL, this.sLowR, this.pLowDet, this.pHighL, this.pHighR]) f.reset();
    this.dL.fill(0);
    this.dR.fill(0);
    this.pos = 0;
    this.eHigh = this.eFull = this.eLow = this.eRest = 0;
    this.gS = this.gP = this.tS = this.tP = 1;
  }
}
