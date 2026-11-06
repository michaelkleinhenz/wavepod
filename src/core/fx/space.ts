// Space: puts a voice into a room (kitchen, car, church, forest…) and at a distance from the
// listener. One filter does what would otherwise take a reverb, an EQ and a volume change:
//  - Distance turns the direct sound down, takes away highs (air) and, close up, adds the bass of
//    the proximity effect; far away the bass thins out. The room stays as loud, so a voice moving
//    away sounds more and more "in the room".
//  - Early reflections (a few discrete echoes off nearby walls) give the size and shape of a room;
//    the late reverb tail (Freeverb network, see reverb.ts) gives its decay.
import type { FxProcessor } from './processors';
import { Biquad } from './biquad';
import { Reverb } from './reverb';

/** Early reflection pattern: relative times (of the room's reflection span), gains and sides. */
const TAPS = [
  [0.13, 1.0, 0.85],
  [0.21, 0.82, 0.2],
  [0.34, 0.74, 0.7],
  [0.45, 0.62, 0.3],
  [0.57, 0.55, 0.9],
  [0.68, 0.46, 0.1],
  [0.82, 0.38, 0.6],
  [1.0, 0.3, 0.4],
] as const;
const TAP_NORM = 1 / Math.sqrt(TAPS.reduce((s, [, g]) => s + g * g, 0));

/** Gain of the direct sound at a distance (m): about −4.5 dB per doubling beyond 1 m. */
export function distanceGainDb(d: number): number {
  return d <= 1 ? 0 : -15 * Math.log10(d);
}

/** High cut (Hz) of the direct sound at a distance, or 0 for none. */
export function distanceHighCut(d: number): number {
  return d <= 1.2 ? 0 : Math.max(1500, 20000 / Math.pow(d, 0.6));
}

/** Low shelf (dB at 250 Hz): proximity bass close up, thinner far away. */
export function distanceBassDb(d: number): number {
  return d < 1 ? Math.min(5, 3 * Math.log2(1 / d)) : -Math.min(6, 2 * Math.log2(d));
}

/** Span of the early reflections in ms for a room size in %. */
const reflectionSpanMs = (size: number) => 3 + 0.9 * size;

export class Space implements FxProcessor {
  readonly latency = 0;
  private reverb: Reverb;
  private direct = 1;
  private air: Biquad | null = null;
  private bass: Biquad | null = null;
  private room = 0;
  private early = 0;
  private taps: Array<{ delay: number; gL: number; gR: number }> = [];
  private erBuf: Float32Array;
  private erPos = 0;
  /** One-pole low-pass on the reflections: soft surfaces swallow highs. */
  private erDamp = 0;
  private erLp = [0, 0];
  private mono = new Float32Array(0);
  private wetL = new Float32Array(0);
  private wetR = new Float32Array(0);
  private key = '';
  constructor(private sr: number) {
    this.reverb = new Reverb(sr);
    this.erBuf = new Float32Array(Math.ceil(0.35 * sr));
  }

  setParams(p: Record<string, number>): void {
    const d = Math.max(0.1, p.distance ?? 1);
    const size = p.size ?? 40;
    const damping = p.damping ?? 50;
    // The gap between the direct sound and the first reflections shrinks as the source moves away.
    const predelay = (p.predelay ?? 10) / (1 + d / 4);
    this.reverb.setParams({ size, damping, mix: 100, predelay: predelay + reflectionSpanMs(size) * 0.4, width: p.width ?? 100 });
    this.direct = Math.pow(10, distanceGainDb(d) / 20);
    this.room = (p.room ?? 20) / 100;
    this.early = ((p.early ?? 30) / 100) * TAP_NORM * 0.7;
    this.erDamp = Math.exp((-2 * Math.PI * Math.max(800, 14000 * (1 - (damping / 100) * 0.85))) / this.sr);
    const span = reflectionSpanMs(size);
    const w = (p.width ?? 100) / 100;
    this.taps = TAPS.map(([t, g, side]) => {
      const pan = 0.5 + (side - 0.5) * w;
      return {
        delay: Math.min(this.erBuf.length - 1, Math.max(1, Math.round(((predelay + t * span) / 1000) * this.sr))),
        gL: g * Math.cos((pan * Math.PI) / 2) * Math.SQRT2,
        gR: g * Math.sin((pan * Math.PI) / 2) * Math.SQRT2,
      };
    });
    const hc = distanceHighCut(d);
    const bass = distanceBassDb(d);
    const key = `${hc}/${bass.toFixed(2)}`;
    if (key !== this.key) {
      this.key = key;
      if (!hc) this.air = null;
      else if (this.air) this.air.set('lowpass', hc, this.sr, Math.SQRT1_2);
      else this.air = new Biquad('lowpass', hc, this.sr, Math.SQRT1_2);
      if (Math.abs(bass) < 0.1) this.bass = null;
      else if (this.bass) this.bass.set('lowshelf', 250, this.sr, Math.SQRT1_2, bass);
      else this.bass = new Biquad('lowshelf', 250, this.sr, Math.SQRT1_2, bass);
    }
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    if (this.mono.length < n) {
      this.mono = new Float32Array(n);
      this.wetL = new Float32Array(n);
      this.wetR = new Float32Array(n);
    }
    const { mono, wetL, wetR, erBuf, taps, early, erDamp } = this;
    for (let i = 0; i < n; i++) mono[i] = (L[i] + R[i]) * 0.5;
    wetL.fill(0, 0, n);
    wetR.fill(0, 0, n);
    // early reflections
    const len = erBuf.length;
    let pos = this.erPos;
    let [lpL, lpR] = this.erLp;
    for (let i = 0; i < n; i++) {
      erBuf[pos] = mono[i];
      let l = 0;
      let r = 0;
      for (const t of taps) {
        let k = pos - t.delay;
        if (k < 0) k += len;
        const v = erBuf[k];
        l += v * t.gL;
        r += v * t.gR;
      }
      lpL = l + erDamp * (lpL - l);
      lpR = r + erDamp * (lpR - r);
      wetL[i] = lpL * early;
      wetR[i] = lpR * early;
      if (++pos === len) pos = 0;
    }
    this.erPos = pos;
    this.erLp = [Math.abs(lpL) < 1e-25 ? 0 : lpL, Math.abs(lpR) < 1e-25 ? 0 : lpR];
    // late reverb
    if (this.room > 0) this.reverb.addWet(mono, wetL, wetR, n, this.room);
    // direct sound at its distance
    if (this.bass) {
      this.bass.process(L, n, 0);
      this.bass.process(R, n, 1);
    }
    if (this.air) {
      this.air.process(L, n, 0);
      this.air.process(R, n, 1);
    }
    const g = this.direct;
    for (let i = 0; i < n; i++) {
      L[i] = L[i] * g + wetL[i];
      R[i] = R[i] * g + wetR[i];
    }
  }

  reset(): void {
    this.reverb.reset();
    this.erBuf.fill(0);
    this.erPos = 0;
    this.erLp = [0, 0];
    this.air?.reset();
    this.bass?.reset();
  }
}
