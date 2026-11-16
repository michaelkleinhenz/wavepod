// De-clip: rebuilds peaks that were cut flat because the input was too loud. A clipped stretch is
// a run of samples stuck at the same (highest) level; the filter replaces it with what the
// waveform before and after predicts, never lower than the level it was clipped at, so the peak
// gets its round top back.
import type { FxProcessor } from './processors';
import { interpolateGap } from './lpc';

/** Longest clipped run the filter rebuilds, in ms; longer runs are left as they are. */
export const MAX_CLIP_MS = 5;

/** Finds runs of clipped samples in x[from..to): [start, end) pairs (exposed for tests). */
export function findClipped(x: Float32Array, from: number, to: number, level: number, minRun: number): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  if (level <= 0) return runs;
  const tol = level * 2e-4;
  let i = from;
  while (i < to) {
    const v = x[i];
    if (Math.abs(v) < level - tol) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < x.length && Math.abs(x[j] - v) <= tol) j++;
    if (j - i >= minRun) runs.push([i, j]);
    i = j;
  }
  return runs;
}

export class DeClip implements FxProcessor {
  readonly latency: number;
  private readonly H: number;
  private readonly A: number;
  private readonly P: number;
  private readonly len: number;
  private readonly ctx: number;
  private readonly maxRun: number;
  private readonly bufs: Float32Array[];
  private readonly orig: Float32Array[];
  private readonly ins: Float32Array[];
  private readonly outs: Float32Array[];
  private f = 0;
  /** Highest level seen per channel, slowly forgotten: where clipping sits. */
  private readonly peak = [0, 0];
  private readonly peakDecay: number;
  private minRun = 3;
  private gain = 1;
  private peaksOnly = false;
  /** Clipped runs rebuilt so far (for tests). */
  repaired = 0;

  constructor(sr: number) {
    const fr = (ms: number) => Math.max(1, Math.round((ms / 1000) * sr));
    this.H = Math.max(64, 1 << Math.round(Math.log2(fr(5.3))));
    this.ctx = fr(4);
    this.maxRun = fr(MAX_CLIP_MS);
    this.A = Math.ceil((this.maxRun + this.ctx + 4) / this.H) * this.H;
    this.P = this.ctx + 4;
    this.len = this.P + this.H + this.A;
    this.latency = this.H + this.A;
    const mk = () => [new Float32Array(this.len), new Float32Array(this.len)];
    this.bufs = mk();
    this.orig = mk();
    this.ins = [new Float32Array(this.H), new Float32Array(this.H)];
    this.outs = [new Float32Array(this.H), new Float32Array(this.H)];
    // the clip level is forgotten over about a minute, per block
    this.peakDecay = Math.exp(-this.H / (60 * sr));
  }

  setParams(p: Record<string, number>): void {
    this.minRun = Math.max(2, Math.round(p.minRun ?? 3));
    this.gain = Math.pow(10, (p.gain ?? 0) / 20);
    this.peaksOnly = (p.output ?? 0) >= 1;
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    const [inL, inR] = this.ins;
    const [outL, outR] = this.outs;
    for (let i = 0; i < n; i++) {
      inL[this.f] = L[i];
      inR[this.f] = R[i];
      L[i] = outL[this.f];
      R[i] = outR[this.f];
      if (++this.f === this.H) {
        this.f = 0;
        this.block();
      }
    }
  }

  private block(): void {
    const { H, len, P } = this;
    for (let ch = 0; ch < 2; ch++) {
      const x = this.bufs[ch];
      const o = this.orig[ch];
      x.copyWithin(0, H);
      o.copyWithin(0, H);
      x.set(this.ins[ch], len - H);
      o.set(this.ins[ch], len - H);
      let m = 0;
      for (let i = len - H; i < len; i++) m = Math.max(m, Math.abs(o[i]));
      this.peak[ch] = Math.max(m, this.peak[ch] * this.peakDecay);
      // runs that start in this block and end before the context after them runs out
      const level = this.peak[ch];
      for (const [a, b] of findClipped(o, P, P + H, level, this.minRun)) {
        if (b - a > this.maxRun || b + this.ctx > len) continue;
        this.rebuild(x, a, b, Math.sign(o[a]) * Math.abs(o[a]));
      }
      const out = this.outs[ch];
      for (let i = 0; i < H; i++) out[i] = (this.peaksOnly ? x[P + i] - o[P + i] : x[P + i]) * this.gain;
    }
  }

  private rebuild(x: Float32Array, a: number, b: number, clipped: number): void {
    interpolateGap(x, a, b, this.ctx, 16);
    // the true peak was at least as high as where it was cut off, and on the same side
    const lv = Math.abs(clipped);
    const s = Math.sign(clipped);
    for (let i = a; i < b; i++) if (s * x[i] < lv) x[i] = s * lv;
    this.repaired++;
  }

  reset(): void {
    for (const a of [...this.bufs, ...this.orig, ...this.ins, ...this.outs]) a.fill(0);
    this.f = 0;
    // the clip level stays: a jump in the timeline does not change the recording
  }
}
