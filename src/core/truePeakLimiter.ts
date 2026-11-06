// Look-ahead true-peak limiter for the export: lets loudness normalisation reach its
// target when the peaks would otherwise go over the ceiling.
import { TP_COEFFS, TP_TAPS } from './loudness';

const HALF = TP_TAPS / 2;

/**
 * Stereo brickwall limiter that keeps true peaks (4x oversampled, like the
 * loudness meter) at or below `ceiling` (linear).
 *
 * The gain for each frame is the lowest gain any peak within the look-ahead
 * window needs, averaged over that window, so it ramps down ahead of a peak
 * instead of clipping it, and recovers with an exponential release.
 * Output is delayed by `latency` frames; call `flush` at the end for the tail.
 */
export class TruePeakLimiter {
  readonly latency: number;
  /** Largest gain reduction so far, in dB (0 or negative). */
  maxReductionDb = 0;
  private readonly look: number;
  private readonly release: number;
  /** Doubled ring buffers: the last TP_TAPS samples are always contiguous at [histPos, histPos + TP_TAPS). */
  private readonly histL = new Float64Array(TP_TAPS * 2);
  private readonly histR = new Float64Array(TP_TAPS * 2);
  private histPos = 0;
  private prevNeed = 1;
  /** Monotonic deque (values and frame numbers) for the sliding minimum of the needed gain. */
  private readonly dqVal: Float64Array;
  private readonly dqIdx: Float64Array;
  private dqHead = 0;
  private dqTail = 0;
  private frame = 0;
  private held = 1;
  private readonly avgBuf: Float64Array;
  private avgPos = 0;
  private avgSum: number;
  /** Input waiting until its gain is known. */
  private readonly delayL: Float32Array;
  private readonly delayR: Float32Array;
  private delayPos = 0;
  private minGain = 1;

  constructor(sampleRate: number, private readonly ceiling: number, lookaheadSeconds = 0.005, releaseSeconds = 0.15) {
    this.look = Math.max(2, Math.round(sampleRate * lookaheadSeconds));
    // a frame's gain is final `look - 1` frames after the detector has seen the peaks on both sides of it
    this.latency = HALF + this.look - 1;
    this.dqVal = new Float64Array(this.look + 1);
    this.dqIdx = new Float64Array(this.look + 1);
    this.avgBuf = new Float64Array(this.look).fill(1);
    this.avgSum = this.look;
    this.release = Math.exp(-3 / (sampleRate * releaseSeconds));
    this.delayL = new Float32Array(this.latency + 1);
    this.delayR = new Float32Array(this.latency + 1);
  }

  /** Peak between taps HALF-1 and HALF of a history window, the samples themselves included. */
  private interPeak(h: Float64Array, base: number, peak: number): number {
    for (let p = 0; p < TP_COEFFS.length; p++) {
      const co = TP_COEFFS[p];
      let y = 0;
      for (let j = 0; j < TP_TAPS; j++) y += co[j] * h[base + j];
      if (y < 0) y = -y;
      if (y > peak) peak = y;
    }
    return peak;
  }

  /** Limits `n` frames; writes `n` delayed frames to `out` (the first `latency` frames of the stream are silence). */
  process(inL: Float32Array, inR: Float32Array, n: number, outL: Float32Array, outR: Float32Array): void {
    const { histL, histR, dqVal, dqIdx, avgBuf, delayL, delayR, ceiling, look, release } = this;
    const cap = dqVal.length;
    const dsize = delayL.length;
    // band-limited audio does not peak far above both neighbouring samples (see the meter)
    const quiet = ceiling * 0.5;
    let { histPos, prevNeed, dqHead, dqTail, frame, held, avgPos, avgSum, delayPos, minGain } = this;
    for (let k = 0; k < n; k++) {
      const l = inL[k];
      const r = inR[k];
      histL[histPos] = l;
      histL[histPos + TP_TAPS] = l;
      histR[histPos] = r;
      histR[histPos + TP_TAPS] = r;
      histPos = histPos + 1 === TP_TAPS ? 0 : histPos + 1;
      const c = histPos + HALF;
      let pl = Math.max(Math.abs(histL[c - 1]), Math.abs(histL[c]));
      let pr = Math.max(Math.abs(histR[c - 1]), Math.abs(histR[c]));
      if (pl >= quiet) pl = this.interPeak(histL, histPos, pl);
      if (pr >= quiet) pr = this.interPeak(histR, histPos, pr);
      const peak = pl > pr ? pl : pr;
      const here = peak > ceiling ? ceiling / peak : 1;
      // the detector looks between two frames, so both of them need the gain
      const need = here < prevNeed ? here : prevNeed;
      prevNeed = here;

      // sliding minimum of the needed gain over the look-ahead window
      while (dqTail !== dqHead) {
        const last = dqTail === 0 ? cap - 1 : dqTail - 1;
        if (dqVal[last] < need) break;
        dqTail = last;
      }
      dqVal[dqTail] = need;
      dqIdx[dqTail] = frame;
      dqTail = dqTail + 1 === cap ? 0 : dqTail + 1;
      if (dqIdx[dqHead] <= frame - look) dqHead = dqHead + 1 === cap ? 0 : dqHead + 1;
      frame++;
      const windowMin = dqVal[dqHead];

      // release: rise back slowly, never above what the window needs
      const released = 1 - (1 - held) * release;
      held = windowMin < released ? windowMin : released;
      // averaged over the window: every value in it has seen the peak, so the mean stays below it
      avgSum += held - avgBuf[avgPos];
      avgBuf[avgPos] = held;
      avgPos = avgPos + 1 === look ? 0 : avgPos + 1;
      let g = avgSum / look;
      if (g > 1) g = 1;
      if (g < minGain) minGain = g;

      delayL[delayPos] = l;
      delayR[delayPos] = r;
      delayPos = delayPos + 1 === dsize ? 0 : delayPos + 1;
      // the oldest frame waiting, whose gain this is
      outL[k] = delayL[delayPos] * g;
      outR[k] = delayR[delayPos] * g;
    }
    Object.assign(this, { histPos, prevNeed, dqHead, dqTail, frame, held, avgPos, avgSum, delayPos, minGain });
    // the running sum drifts a little over hours; rebuild it now and then
    if (frame % (1 << 20) < n) {
      let s = 0;
      for (let i = 0; i < look; i++) s += avgBuf[i];
      this.avgSum = s;
    }
    this.maxReductionDb = minGain < 1 ? 20 * Math.log10(minGain) : 0;
  }

  /** Writes the last `latency` frames to `out` (which must hold that many). */
  flush(outL: Float32Array, outR: Float32Array): number {
    const zeros = new Float32Array(this.latency);
    this.process(zeros, zeros, this.latency, outL, outR);
    return this.latency;
  }
}
