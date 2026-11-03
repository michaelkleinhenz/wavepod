// Noise reduction: spectral gating. The noise floor of each frequency band is learned all the time
// from the quietest moments (a slowly rising minimum), so there is no "learn noise" step; bands that
// are not clearly above it are turned down. Gains come from the mid signal and apply to both
// channels, so the stereo image stays put. Adds FRAME frames of latency (compensated by the mixer).
import { fft } from '../fft';
import type { FxProcessor } from './processors';

const FRAME = 1024;
const HOP = 256;
const BINS = FRAME / 2 + 1;
/** Mean over minimum of the smoothed noise power (about 4 dB). */
const NOISE_BIAS = 2.5;

export class NoiseReduction implements FxProcessor {
  readonly latency = FRAME;
  private win = Float64Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME));
  /** Input ring (last FRAME samples) per channel, and the overlap-add output per channel. */
  private inL = new Float32Array(FRAME);
  private inR = new Float32Array(FRAME);
  private outL = new Float32Array(FRAME * 2);
  private outR = new Float32Array(FRAME * 2);
  private fill = 0;
  /** Where the next input sample goes in the rings (= the oldest sample). */
  private inPos = 0;
  private outPos = 0;
  private power = new Float64Array(BINS);
  private slow = new Float64Array(BINS);
  private noise = new Float64Array(BINS).fill(-1);
  private gain = new Float64Array(BINS).fill(1);
  private re = new Float64Array(FRAME);
  private im = new Float64Array(FRAME);
  private reR = new Float64Array(FRAME);
  private imR = new Float64Array(FRAME);
  private floor = 0.25;
  private threshold = 4;
  /** Per-hop factor the noise estimate may rise by (it follows drops at once). */
  private rise: number;
  private release: number;
  private reduced = 0;
  private frames = 0;
  private warm = false;

  constructor(sr: number) {
    // noise estimate may rise about 10 dB per second; gains open fast and close over ~80 ms
    this.rise = Math.pow(10, 10 / 10 / (sr / HOP));
    this.release = Math.exp(-HOP / (0.08 * sr));
  }

  setParams(p: Record<string, number>): void {
    this.floor = Math.pow(10, -Math.abs(p.reduction ?? 12) / 20);
    this.threshold = Math.pow(10, (p.threshold ?? 6) / 10);
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    for (let i = 0; i < n; i++) {
      // the sample leaving now is FRAME samples old
      const yl = this.outL[this.outPos];
      const yr = this.outR[this.outPos];
      this.outL[this.outPos] = 0;
      this.outR[this.outPos] = 0;
      this.outPos = (this.outPos + 1) % this.outL.length;
      this.inL[this.inPos] = L[i];
      this.inR[this.inPos] = R[i];
      this.inPos = (this.inPos + 1) % FRAME;
      L[i] = yl;
      R[i] = yr;
      if (++this.fill === HOP) {
        this.fill = 0;
        this.frame();
      }
    }
  }

  /** Analyses the last FRAME samples and overlap-adds the filtered frame. */
  private frame(): void {
    // the first frames hold the silence before the audio began: no estimate from them
    if (this.frames < FRAME / HOP) {
      this.frames++;
      const j0 = this.inPos;
      for (let i = 0; i < FRAME; i++) {
        const j = (j0 + i) % FRAME;
        this.outL[(this.outPos + i) % this.outL.length] += (this.inL[j] * this.win[i] * this.win[i]) / 1.5;
        this.outR[(this.outPos + i) % this.outR.length] += (this.inR[j] * this.win[i] * this.win[i]) / 1.5;
      }
      return;
    }
    const { re, im, reR, imR, win } = this;
    for (let i = 0; i < FRAME; i++) {
      const j = (this.inPos + i) % FRAME;
      re[i] = this.inL[j] * win[i];
      im[i] = 0;
      reR[i] = this.inR[j] * win[i];
      imR[i] = 0;
    }
    fft(re, im);
    fft(reR, imR);
    let minGain = 1;
    for (let k = 0; k < BINS; k++) {
      // mid power of the bin, smoothed over time
      const mr = (re[k] + reR[k]) / 2;
      const mi = (im[k] + imR[k]) / 2;
      const p = mr * mr + mi * mi;
      this.power[k] = 0.6 * this.power[k] + 0.4 * p;
      const pk = this.power[k];
      // the noise floor: a slowly rising minimum of a longer average; the minimum of a noisy
      // power sits below its mean, hence the bias factor
      this.slow[k] = this.warm ? 0.92 * this.slow[k] + 0.08 * p : p;
      const ps = this.slow[k];
      if (this.noise[k] < 0 || ps < this.noise[k]) this.noise[k] = ps;
      else this.noise[k] *= this.rise;
      const nk = this.noise[k] * NOISE_BIAS;
      // Wiener-like gain: what is above threshold × noise passes
      const g = pk > 0 ? Math.max(this.floor, Math.min(1, 1 - (this.threshold * nk) / pk)) : this.floor;
      const prev = this.gain[k];
      this.gain[k] = g > prev ? g : prev * this.release + g * (1 - this.release);
    }
    // smooth across neighbouring bins against "musical noise"
    let a = this.gain[0];
    for (let k = 0; k < BINS; k++) {
      const b = this.gain[k];
      const c = this.gain[Math.min(BINS - 1, k + 1)];
      const g = (a + 2 * b + c) / 4;
      a = b;
      if (g < minGain) minGain = g;
      re[k] *= g;
      im[k] *= g;
      reR[k] *= g;
      imR[k] *= g;
      if (k > 0 && k < FRAME / 2) {
        re[FRAME - k] *= g;
        im[FRAME - k] *= g;
        reR[FRAME - k] *= g;
        imR[FRAME - k] *= g;
      }
    }
    this.warm = true;
    this.reduced = Math.min(this.reduced, 20 * Math.log10(Math.max(1e-6, minGain)));
    fft(re, im, true);
    fft(reR, imR, true);
    // Hann analysis + Hann synthesis at 75 % overlap sums to 1.5
    const len = this.outL.length;
    for (let i = 0; i < FRAME; i++) {
      const j = (this.outPos + i) % len;
      this.outL[j] += (re[i] * win[i]) / 1.5;
      this.outR[j] += (reR[i] * win[i]) / 1.5;
    }
  }

  takeGain(): number {
    const g = this.reduced;
    this.reduced = 0;
    return g;
  }

  reset(): void {
    this.inL.fill(0);
    this.inR.fill(0);
    this.outL.fill(0);
    this.outR.fill(0);
    this.fill = 0;
    this.inPos = 0;
    this.outPos = 0;
    this.power.fill(0);
    this.slow.fill(0);
    this.noise.fill(-1);
    this.gain.fill(1);
    this.frames = 0;
    this.warm = false;
  }
}
