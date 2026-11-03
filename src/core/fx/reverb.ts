// Reverb: a Schroeder/Moorer network in the style of the public-domain Freeverb (8 damped comb
// filters and 4 all-passes per channel), for a touch of room on dry voices or a jingle bed.
import type { FxProcessor } from './processors';

const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASSES = [556, 441, 341, 225];
const STEREO_SPREAD = 23;

class Comb {
  private buf: Float32Array;
  private i = 0;
  private store = 0;
  constructor(len: number) {
    this.buf = new Float32Array(len);
  }
  tick(x: number, feedback: number, damp: number): number {
    const y = this.buf[this.i];
    this.store = y * (1 - damp) + this.store * damp;
    this.buf[this.i] = x + this.store * feedback;
    if (++this.i === this.buf.length) this.i = 0;
    return y;
  }
  reset(): void {
    this.buf.fill(0);
    this.store = 0;
  }
}

class AllPass {
  private buf: Float32Array;
  private i = 0;
  constructor(len: number) {
    this.buf = new Float32Array(len);
  }
  tick(x: number): number {
    const b = this.buf[this.i];
    this.buf[this.i] = x + b * 0.5;
    if (++this.i === this.buf.length) this.i = 0;
    return b - x;
  }
  reset(): void {
    this.buf.fill(0);
  }
}

export class Reverb implements FxProcessor {
  readonly latency = 0;
  private combsL: Comb[];
  private combsR: Comb[];
  private apsL: AllPass[];
  private apsR: AllPass[];
  private pre: Float32Array;
  private preIdx = 0;
  private preLen = 0;
  private feedback = 0.84;
  private damp = 0.2;
  private wet = 0.2;
  private dry = 1;
  private width = 1;

  constructor(private sr: number) {
    const s = sr / 44100;
    this.combsL = COMBS.map((c) => new Comb(Math.round(c * s)));
    this.combsR = COMBS.map((c) => new Comb(Math.round((c + STEREO_SPREAD) * s)));
    this.apsL = ALLPASSES.map((a) => new AllPass(Math.round(a * s)));
    this.apsR = ALLPASSES.map((a) => new AllPass(Math.round((a + STEREO_SPREAD) * s)));
    this.pre = new Float32Array(Math.ceil(0.2 * sr) + 1);
  }

  setParams(p: Record<string, number>): void {
    const size = (p.size ?? 50) / 100;
    this.feedback = 0.7 + 0.28 * size;
    this.damp = ((p.damping ?? 50) / 100) * 0.4;
    const mix = (p.mix ?? 15) / 100;
    // the classic Freeverb input scaling keeps the wet level in range
    this.wet = mix * 3 * 0.015 * 4;
    this.dry = 1 - mix * 0.5;
    this.width = (p.width ?? 100) / 100;
    this.preLen = Math.min(this.pre.length - 1, Math.round(((p.predelay ?? 10) / 1000) * this.sr));
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    const w1 = this.wet * (this.width / 2 + 0.5);
    const w2 = this.wet * ((1 - this.width) / 2);
    for (let i = 0; i < n; i++) {
      const xin = (L[i] + R[i]) * 0.5;
      // pre-delay
      this.pre[this.preIdx] = xin;
      const d = this.preIdx - this.preLen;
      const x = this.pre[d < 0 ? d + this.pre.length : d];
      if (++this.preIdx === this.pre.length) this.preIdx = 0;
      let outL = 0;
      let outR = 0;
      for (let k = 0; k < 8; k++) {
        outL += this.combsL[k].tick(x, this.feedback, this.damp);
        outR += this.combsR[k].tick(x, this.feedback, this.damp);
      }
      for (let k = 0; k < 4; k++) {
        outL = this.apsL[k].tick(outL);
        outR = this.apsR[k].tick(outR);
      }
      L[i] = L[i] * this.dry + outL * w1 + outR * w2;
      R[i] = R[i] * this.dry + outR * w1 + outL * w2;
    }
  }

  reset(): void {
    for (const c of [...this.combsL, ...this.combsR]) c.reset();
    for (const a of [...this.apsL, ...this.apsR]) a.reset();
    this.pre.fill(0);
    this.preIdx = 0;
  }
}
