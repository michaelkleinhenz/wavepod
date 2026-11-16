// Mouth de-click: finds lip smacks, tongue and saliva clicks (very short, sharp bursts that stand
// out from the sound around them) and fills them in with what the surrounding audio predicts.
import type { FxProcessor } from './processors';
import { interpolateGap } from './lpc';

/** The longest click the filter can be set to repair, in ms (sets the look-ahead). */
export const MAX_CLICK_MS = 10;

/** Detection threshold (how far a click must stand out, in dB) for a sensitivity in %. */
export function declickThresholdDb(sensitivity: number): number {
  return 30 - 0.24 * Math.min(100, Math.max(0, sensitivity));
}

export class MouthDeclick implements FxProcessor {
  readonly latency: number;
  /** Block size, look-ahead and past context in frames. */
  private readonly H: number;
  private readonly A: number;
  private readonly P: number;
  private readonly len: number;
  /** Half-widths: the click window, the window it is compared with, and the gap left out of it. */
  private readonly w: number;
  private readonly W: number;
  private readonly ctx: number;
  private readonly pad: number;
  private readonly merge: number;
  private readonly xL: Float32Array;
  private readonly xR: Float32Array;
  private readonly oL: Float32Array;
  private readonly oR: Float32Array;
  /** Detection signal: third difference of the (repaired) mono sum, i.e. the highs of it. */
  private readonly d: Float32Array;
  private readonly S: Float64Array;
  private readonly flags: Uint8Array;
  private readonly inL: Float32Array;
  private readonly inR: Float32Array;
  private readonly outL: Float32Array;
  private readonly outR: Float32Array;
  private f = 0;
  private ratio = 1;
  private maxLen = 0;
  private gap = 0;
  private clicksOnly = false;

  constructor(private sr: number) {
    const fr = (ms: number) => Math.max(1, Math.round((ms / 1000) * sr));
    this.H = Math.max(64, 1 << Math.round(Math.log2(fr(5.3))));
    this.w = fr(0.25);
    this.W = fr(10);
    this.ctx = fr(8);
    this.pad = fr(0.5);
    this.merge = fr(0.5);
    const maxLenMax = fr(MAX_CLICK_MS);
    this.A = Math.ceil((maxLenMax + 2 * this.pad + this.merge + Math.max(this.W, this.ctx) + this.w + 4) / this.H) * this.H;
    this.P = Math.max(this.W, this.ctx) + this.pad + 4;
    this.len = this.P + this.H + this.A;
    this.latency = this.H + this.A;
    const f32 = () => new Float32Array(this.len);
    this.xL = f32();
    this.xR = f32();
    this.oL = f32();
    this.oR = f32();
    this.d = f32();
    this.S = new Float64Array(this.len + 1);
    this.flags = new Uint8Array(this.len);
    this.inL = new Float32Array(this.H);
    this.inR = new Float32Array(this.H);
    this.outL = new Float32Array(this.H);
    this.outR = new Float32Array(this.H);
  }

  setParams(p: Record<string, number>): void {
    this.ratio = Math.pow(10, declickThresholdDb(p.sensitivity ?? 50) / 10);
    this.maxLen = Math.max(1, Math.round((Math.min(MAX_CLICK_MS, Math.max(0.1, p.length ?? 3)) / 1000) * this.sr));
    // the window a click is compared with leaves out the click itself
    this.gap = Math.min(this.W - this.w - 1, Math.max(Math.round(0.002 * this.sr), Math.ceil(this.maxLen / 2) + 2 * this.w));
    this.clicksOnly = (p.output ?? 0) >= 1;
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    const H = this.H;
    for (let i = 0; i < n; i++) {
      this.inL[this.f] = L[i];
      this.inR[this.f] = R[i];
      L[i] = this.outL[this.f];
      R[i] = this.outR[this.f];
      if (++this.f === H) {
        this.f = 0;
        this.block();
      }
    }
  }

  /** Number of clicks repaired since the last call (for tests and the MCP). */
  clicks = 0;

  private block(): void {
    const { H, len, P, xL, xR, oL, oR, d } = this;
    for (const a of [xL, xR, oL, oR, d]) a.copyWithin(0, H);
    xL.set(this.inL, len - H);
    xR.set(this.inR, len - H);
    oL.set(this.inL, len - H);
    oR.set(this.inR, len - H);
    this.detection(len - H, len);
    this.detect();
    for (let i = 0; i < H; i++) {
      if (this.clicksOnly) {
        this.outL[i] = oL[P + i] - xL[P + i];
        this.outR[i] = oR[P + i] - xR[P + i];
      } else {
        this.outL[i] = xL[P + i];
        this.outR[i] = xR[P + i];
      }
    }
  }

  /** Recomputes the detection signal for frames [from, to). */
  private detection(from: number, to: number): void {
    const { xL, xR, d } = this;
    // third difference: rises 18 dB per octave, so the voice's own highs hardly count
    for (let i = Math.max(3, from); i < to; i++) d[i] = 0.5 * (xL[i] - 3 * xL[i - 1] + 3 * xL[i - 2] - xL[i - 3] + xR[i] - 3 * xR[i - 1] + 3 * xR[i - 2] - xR[i - 3]);
  }

  private detect(): void {
    const { P, H, len, w, W, d, S, flags } = this;
    S[0] = 0;
    for (let i = 0; i < len; i++) S[i + 1] = S[i] + d[i] * d[i];
    const gap = this.gap;
    const from = P - this.merge - 1;
    const to = Math.min(len - W - 1, P + H + this.maxLen + this.merge + 1);
    const floor = 1e-9;
    for (let i = from; i < to; i++) {
      const short = (S[i + w + 1] - S[i - w]) / (2 * w + 1);
      const bg = (S[i + W] - S[i - W] - (S[i + gap + 1] - S[i - gap])) / (2 * W - 2 * gap - 1);
      flags[i] = short > floor && short > this.ratio * (bg + floor * 0.01) ? 1 : 0;
    }
    // runs of flagged frames that start in this block (short gaps inside a run are bridged)
    let i = from;
    while (i < to) {
      if (!flags[i]) {
        i++;
        continue;
      }
      const s = i;
      let e = i + 1;
      let k = e;
      while (k < to && k - e <= this.merge) {
        if (flags[k]) e = k + 1;
        k++;
      }
      i = e;
      if (s < P || s >= P + H) continue;
      // the short window widens each run by w on both sides
      const width = e - s - 2 * w;
      if (width > this.maxLen) continue;
      this.repair(Math.max(this.ctx, s + w - this.pad), Math.min(len - this.ctx, e - w + this.pad));
    }
  }

  private repair(a: number, b: number): void {
    if (b <= a) return;
    interpolateGap(this.xL, a, b, this.ctx);
    interpolateGap(this.xR, a, b, this.ctx);
    this.detection(a, b + 3);
    // keep the prefix sums in step so a later click in this block is judged on the repaired audio
    const { S, d } = this;
    for (let i = a; i < this.len; i++) S[i + 1] = S[i] + d[i] * d[i];
    this.clicks++;
  }

  reset(): void {
    for (const a of [this.xL, this.xR, this.oL, this.oR, this.d, this.inL, this.inR, this.outL, this.outR]) a.fill(0);
    this.f = 0;
  }
}
