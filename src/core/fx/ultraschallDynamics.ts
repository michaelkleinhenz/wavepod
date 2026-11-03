// A port of the "Ultraschall Dynamics" JSFX (Ultraschall 5, Effects/dynamics/Ultraschall_Dynamics,
// LGPL; derived from Cockos "General Dynamics", limiter from LOSER's "MGA JS Limiter").
//
// How it works:
// - A detector measures the RMS level over 188 ms (the louder of both channels) and smooths it
//   with 5 ms attack / 250 ms release.
// - The level is looked up in a 250-point gain curve spanning -108..0 dB input. The curve is
//   built from three settings: Target (T, LUFS), Noise floor (NF, dB) and Noise gate (NG, dB):
//     * from NF up to 0 dB an S-curve (logistic function) maps the input onto NF..≈T, so quiet
//       speech is raised towards the target and loud speech is held back;
//     * from NF-NG up to NF the output rises linearly (in dB) from silence to NF (an expander);
//     * below NF-NG everything is muted (gate).
//   The curve is smoothed with a 3-tap FIR, exactly like the original.
// - The audio is delayed by 100 ms before the gain is applied (lookahead), so the gain reacts
//   before a loud word arrives. WavePod compensates this latency on the timeline.
// - A peak limiter with a ceiling of -0.1 dBFS follows.
import { GainMeter } from './meter';
import type { FxProcessor } from './processors';

export const DYNAMICS_DB_BOTTOM = -108;
const TAB_SIZE = 250;
const RMS_MS = 188;
const LOOKAHEAD_MS = 100;
const ATTACK_MS = 5;
const RELEASE_MS = 250;
const S_B = 0.266;
const GAIN_STEP = 8;

export interface DynamicsSettings {
  target: number;
  noiseFloor: number;
  noiseGate: number;
}

/** Gain needed at table index `idx` to reach output level `x` dB (the JSFX's amplification_for_tab_to_get_x). */
function ampForTab(idx: number, x: number): number {
  return x - (-108 + (36 / 83) * idx);
}

function sCurve(x: number, b: number, c: number, d: number, u: number): number {
  return c + d / (1 + Math.exp(-(b * (x - u))));
}

/** Builds the gain table (dB of gain per input level, 250 points over -108..0 dB). */
export function buildDynamicsTable({ target, noiseFloor, noiseGate }: DynamicsSettings): Float64Array {
  const tab = new Float64Array(TAB_SIZE);
  const nf = noiseFloor;
  const ng = Math.max(noiseGate, (108 + nf) / 3);
  const curveStart = 249 - Math.floor((nf / -108) * 249);
  const upperWidth = 249 - curveStart;

  // Upper part: S-curve from the noise floor up to 0 dB.
  const d = (-nf - 40) * 0.9 + 46 + target;
  const u = (-nf - 40) * 0.2 + 5;
  const c = -ampForTab(0, sCurve(0, S_B, 0, d, u));
  for (let i = 0; i < upperWidth; i++) tab[curveStart + i] = ampForTab(i, sCurve((i / 249) * 108, S_B, c, d, u));
  const startValue = tab[curveStart];

  // Lower part: muted below NF-NG, then a linear ramp up to the curve's start.
  const noiseWidth = Math.min(ng, nf + 108);
  const zeroWidth = Math.floor(((nf - noiseWidth + 108) / 108) * 249);
  for (let i = 0; i < zeroWidth; i++) tab[i] = ampForTab(i, -108);
  const b = nf + startValue + 108;
  const m = b / ((noiseWidth / 108) * 249);
  const rampCount = Math.floor((noiseWidth / 108) * 249) + 1;
  for (let i = 0; i < rampCount && zeroWidth + i < TAB_SIZE; i++) tab[zeroWidth + i] = ampForTab(zeroWidth + i, i * m - 108);
  // the S-curve owns the part from the noise floor up (the JSFX writes it last)
  for (let i = 0; i < upperWidth; i++) tab[curveStart + i] = ampForTab(i, sCurve((i / 249) * 108, S_B, c, d, u));
  tab[TAB_SIZE - 1] = tab[TAB_SIZE - 2];

  // blur with a simple 3-tap FIR (in place, like the original)
  let i = 1;
  for (; i < TAB_SIZE - 1; i++) tab[i] = tab[i - 1] * 0.25 + tab[i] * 0.5 + tab[i + 1] * 0.25;
  tab[i] = tab[i - 1] * 0.25 + tab[i] * 0.75;
  return tab;
}

/** Gain in dB for a linear detector level, interpolated from the table. */
export function dynamicsGainDb(tab: Float64Array, level: number): number {
  let x = level > 1e-10 ? Math.max(0, Math.min(1, (20 * Math.log10(level) - DYNAMICS_DB_BOTTOM) / -DYNAMICS_DB_BOTTOM)) : 0;
  x *= TAB_SIZE - 1;
  const idx = Math.floor(x);
  if (idx < 0) return tab[0];
  if (idx >= TAB_SIZE - 1) return tab[TAB_SIZE - 1];
  const p = tab[idx];
  return p + (tab[idx + 1] - p) * (x - idx);
}

/** Static input→output curve in dB, for drawing. */
export function dynamicsCurve(settings: DynamicsSettings, points = 109): Array<[number, number]> {
  const tab = buildDynamicsTable(settings);
  const out: Array<[number, number]> = [];
  for (let k = 0; k < points; k++) {
    const inDb = DYNAMICS_DB_BOTTOM + (k / (points - 1)) * -DYNAMICS_DB_BOTTOM;
    out.push([inDb, inDb + dynamicsGainDb(tab, Math.pow(10, inDb / 20))]);
  }
  return out;
}

/** The MGA JS limiter as used by Ultraschall Dynamics: instant attack, block-max hold, exponential release. */
export class PeakLimiter {
  private hold: number;
  private r1 = 0;
  private r2: number;
  private max1 = 0;
  private max2 = 0;
  private env = 0;
  private r: number;

  private sampleRate: number;

  constructor(
    sampleRate: number,
    private thresh = 1,
    private volume = Math.pow(10, -0.1 / 20),
    releaseSeconds = 0.2,
  ) {
    this.sampleRate = sampleRate;
    this.hold = sampleRate / 128;
    this.r2 = this.hold / 2;
    this.r = Math.exp(-3 / (sampleRate * Math.max(releaseSeconds, 0.05)));
  }

  configure(thresh: number, volume: number, releaseSeconds: number): void {
    this.thresh = thresh;
    this.volume = volume;
    this.r = Math.exp(-3 / (this.sampleRate * Math.max(releaseSeconds, 0.05)));
  }

  /** Gain for the current stereo sample. */
  gain(l: number, r: number): number {
    const m = Math.max(Math.abs(l), Math.abs(r));
    if (++this.r1 > this.hold) {
      this.r1 = 0;
      this.max1 = 0;
    }
    this.max1 = Math.max(this.max1, m);
    if (++this.r2 > this.hold) {
      this.r2 = 0;
      this.max2 = 0;
    }
    this.max2 = Math.max(this.max2, m);
    const envT = Math.max(this.max1, this.max2);
    this.env = this.env < envT ? envT : envT + this.r * (this.env - envT);
    return this.env > this.thresh ? (this.thresh / this.env) * this.volume : this.volume;
  }

  reset(): void {
    this.r1 = 0;
    this.r2 = this.hold / 2;
    this.max1 = this.max2 = this.env = 0;
  }
}

export class UltraschallDynamics implements FxProcessor {
  readonly latency: number;
  private tab: Float64Array = new Float64Array(TAB_SIZE);
  private key = '';
  private rmsBuf: Float64Array;
  private rmsSize: number;
  private rmsPtr = 0;
  private rmsCnt = 0;
  private sumL = 0;
  private sumR = 0;
  private delayL: Float32Array;
  private delayR: Float32Array;
  private delayPtr = 0;
  private env = 0;
  /** Gain is looked up every GAIN_STEP samples and interpolated in between (saves log/pow per sample). */
  private gain = 1;
  private gainStep = 0;
  private stepLeft = 0;
  private attack: number;
  private release: number;
  private limiter: PeakLimiter;

  constructor(sampleRate: number) {
    this.rmsSize = Math.max(1, Math.floor((RMS_MS / 1000) * sampleRate));
    this.rmsBuf = new Float64Array(this.rmsSize * 2);
    this.latency = Math.floor((LOOKAHEAD_MS / 1000) * sampleRate);
    this.delayL = new Float32Array(this.latency);
    this.delayR = new Float32Array(this.latency);
    const slope = (ms: number) => {
      const n = (ms / 1000) * sampleRate;
      return n < 1 ? 0 : Math.exp(-1 / n);
    };
    this.attack = slope(ATTACK_MS);
    this.release = slope(RELEASE_MS);
    this.limiter = new PeakLimiter(sampleRate);
  }

  setParams(p: Record<string, number>): void {
    const key = `${p.target}|${p.noiseFloor}|${p.noiseGate}`;
    if (key === this.key) return;
    this.key = key;
    this.tab = buildDynamicsTable({ target: p.target, noiseFloor: p.noiseFloor, noiseGate: p.noiseGate });
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    const size = this.rmsSize;
    const buf = this.rmsBuf;
    const dl = this.delayL;
    const dr = this.delayR;
    const lat = this.latency;
    let minLimit = 1;
    for (let i = 0; i < n; i++) {
      const l = L[i];
      const r = R[i];
      // running RMS over the last `size` samples (max of both channels)
      if (this.rmsCnt >= size) {
        const k = this.rmsPtr * 2;
        this.sumL -= buf[k];
        this.sumR -= buf[k + 1];
      } else {
        this.rmsCnt++;
      }
      const k = this.rmsPtr * 2;
      buf[k] = l * l;
      buf[k + 1] = r * r;
      if (++this.rmsPtr >= size) this.rmsPtr = 0;
      if ((this.sumL += l * l) < 0) this.sumL = 0;
      if ((this.sumR += r * r) < 0) this.sumR = 0;
      const mv = Math.sqrt(Math.max(this.sumL, this.sumR) / size);
      this.env = mv + (mv > this.env ? this.attack : this.release) * (this.env - mv);
      if (this.stepLeft-- <= 0) {
        const target = Math.pow(10, dynamicsGainDb(this.tab, this.env) / 20);
        this.gainStep = (target - this.gain) / GAIN_STEP;
        this.stepLeft = GAIN_STEP - 1;
      }
      const g = (this.gain += this.gainStep);
      // lookahead: apply the gain to audio from `latency` samples ago
      let ol = l;
      let or = r;
      if (lat > 0) {
        ol = dl[this.delayPtr];
        or = dr[this.delayPtr];
        dl[this.delayPtr] = l;
        dr[this.delayPtr] = r;
        if (++this.delayPtr >= lat) this.delayPtr = 0;
      }
      ol *= g;
      or *= g;
      const lg = this.limiter.gain(ol, or);
      L[i] = ol * lg;
      R[i] = or * lg;
      if (lg < minLimit) minLimit = lg;
    }
    // the gain the curve applies (boost or cut) together with the limiter's reduction
    this.meter.note(20 * Math.log10(Math.max(1e-6, this.gain * minLimit)));
  }

  private meter = new GainMeter();
  takeGain(): number {
    return this.meter.take();
  }

  /** RMS level the detector sees, in dB (the input to the curve). */
  detectorLevel(): number {
    return this.env > 1e-6 ? 20 * Math.log10(this.env) : -120;
  }

  reset(): void {
    this.rmsBuf.fill(0);
    this.rmsPtr = this.rmsCnt = 0;
    this.sumL = this.sumR = 0;
    this.delayL.fill(0);
    this.delayR.fill(0);
    this.delayPtr = 0;
    this.env = 0;
    this.gain = 0;
    this.gainStep = 0;
    this.stepLeft = 0;
    this.limiter.reset();
  }
}
