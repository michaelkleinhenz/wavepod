// WSOLA time-stretch for listening through an episode faster without the chipmunk effect.
// Only the playback path uses it; recording and export always run at 1x.

/** Renders `n` frames of the timeline from `pos` into `buf` (two channels, overwritten). Called with contiguous ranges. */
export type StretchSource = (pos: number, n: number, buf: Float32Array[]) => void;

export const PLAYBACK_SPEEDS = [1, 1.25, 1.5, 1.75, 2] as const;

export class TimeStretcher {
  /** Overlap length (= output hop) in frames. */
  readonly overlap: number;
  /** How far the search may shift a segment from its nominal position, in frames. */
  readonly tolerance: number;
  private fifo: Float32Array[] = [new Float32Array(0), new Float32Array(0)];
  /** Timeline position of fifo[.][0] and number of valid frames in it. */
  private fifoStart = 0;
  private fifoLen = 0;
  /** Nominal analysis position (timeline frames, fractional). */
  private inPos = 0;
  /** The natural continuation of the last segment, cross-faded with the next one. */
  private tail: Float32Array[];
  private hasTail = false;
  /** Output ready to hand out. */
  private ready: Float32Array[];
  private readyLen = 0;
  private readyOff = 0;
  private fadeIn: Float32Array;
  private tmp: Float32Array[] = [new Float32Array(0), new Float32Array(0)];

  constructor(
    sampleRate: number,
    private source: StretchSource,
    public speed = 1,
  ) {
    this.overlap = Math.max(64, Math.round(sampleRate * 0.02));
    this.tolerance = Math.max(16, Math.round(sampleRate * 0.008));
    this.tail = [new Float32Array(this.overlap), new Float32Array(this.overlap)];
    this.ready = [new Float32Array(this.overlap), new Float32Array(this.overlap)];
    // complementary sin²/cos² windows sum to 1
    this.fadeIn = new Float32Array(this.overlap);
    for (let i = 0; i < this.overlap; i++) this.fadeIn[i] = Math.sin(((i + 0.5) / this.overlap) * (Math.PI / 2)) ** 2;
  }

  /** Timeline position of what is being heard now. */
  get position(): number {
    return Math.round(this.inPos - (this.readyLen - this.readyOff) * this.speed);
  }

  /** Starts over at `pos` (seek, play, speed change). */
  reset(pos: number): void {
    this.fifoStart = Math.max(0, Math.round(pos));
    this.fifoLen = 0;
    this.inPos = this.fifoStart;
    this.hasTail = false;
    this.readyLen = 0;
    this.readyOff = 0;
  }

  /** Fills `out[0..1]` with `frames` stretched frames (overwrites). */
  pull(frames: number, out: Float32Array[]): void {
    let done = 0;
    while (done < frames) {
      if (this.readyOff >= this.readyLen) this.step();
      const n = Math.min(frames - done, this.readyLen - this.readyOff);
      out[0].set(this.ready[0].subarray(this.readyOff, this.readyOff + n), done);
      out[1].set(this.ready[1].subarray(this.readyOff, this.readyOff + n), done);
      this.readyOff += n;
      done += n;
    }
  }

  /** Makes sure the fifo holds timeline frames [from, to). */
  private ensure(from: number, to: number): void {
    // drop what lies before `from`
    const drop = Math.max(0, Math.min(this.fifoLen, from - this.fifoStart));
    if (drop > 0) {
      for (const ch of this.fifo) ch.copyWithin(0, drop, this.fifoLen);
      this.fifoStart += drop;
      this.fifoLen -= drop;
    }
    const need = to - this.fifoStart;
    if (need > this.fifo[0].length) {
      const size = Math.max(need, this.fifo[0].length * 2, 4096);
      this.fifo = this.fifo.map((ch) => {
        const n = new Float32Array(size);
        n.set(ch.subarray(0, this.fifoLen));
        return n;
      });
    }
    const missing = need - this.fifoLen;
    if (missing > 0) {
      if (this.tmp[0].length < missing) this.tmp = [new Float32Array(missing), new Float32Array(missing)];
      this.source(this.fifoStart + this.fifoLen, missing, this.tmp);
      this.fifo[0].set(this.tmp[0].subarray(0, missing), this.fifoLen);
      this.fifo[1].set(this.tmp[1].subarray(0, missing), this.fifoLen);
      this.fifoLen += missing;
    }
  }

  /** Produces the next `overlap` output frames. */
  private step(): void {
    const L = this.overlap;
    // at 1x the nominal position continues the last segment exactly, nothing to search
    const tol = this.hasTail && this.speed !== 1 ? this.tolerance : 0;
    const nominal = Math.round(this.inPos);
    const lo = Math.max(this.fifoStart, nominal - tol);
    this.ensure(lo, nominal + tol + 2 * L);
    const [fl, fr] = this.fifo;
    // the shift whose start best continues the previous segment's natural continuation
    let best = nominal;
    if (tol > 0) {
      let bestScore = -Infinity;
      const [tl, tr] = this.tail;
      for (let cand = lo; cand <= nominal + tol; cand++) {
        const o = cand - this.fifoStart;
        let score = 0;
        // every second sample is plenty for finding the alignment
        for (let i = 0; i < L; i += 2) score += (tl[i] + tr[i]) * (fl[o + i] + fr[o + i]);
        if (score > bestScore) {
          bestScore = score;
          best = cand;
        }
      }
    }
    const o = best - this.fifoStart;
    const [rl, rr] = this.ready;
    const w = this.fadeIn;
    if (this.hasTail) {
      const [tl, tr] = this.tail;
      for (let i = 0; i < L; i++) {
        rl[i] = tl[i] * (1 - w[i]) + fl[o + i] * w[i];
        rr[i] = tr[i] * (1 - w[i]) + fr[o + i] * w[i];
      }
    } else {
      rl.set(fl.subarray(o, o + L));
      rr.set(fr.subarray(o, o + L));
    }
    this.tail[0].set(fl.subarray(o + L, o + 2 * L));
    this.tail[1].set(fr.subarray(o + L, o + 2 * L));
    this.hasTail = true;
    this.readyLen = L;
    this.readyOff = 0;
    this.inPos += L * this.speed;
  }
}
