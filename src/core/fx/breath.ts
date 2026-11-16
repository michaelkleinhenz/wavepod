// Breath control: finds breaths between phrases and turns them down (not out), so the voice keeps
// its natural rhythm without loud gasps. A breath is a stretch of unvoiced, soft, not very bright
// sound well below the speech level and above the room noise.
import type { FxProcessor } from './processors';
import { GainMeter } from './meter';

const dbToLin = (db: number) => Math.pow(10, db / 20);
const linToDb = (v: number) => (v > 1e-12 ? 20 * Math.log10(v) : -240);

/** What the detector measured for one 10 ms frame (exposed for tests). */
export interface BreathFrame {
  level: number;
  voicing: number;
  /** Rough "average frequency" of the frame in Hz (from the energy of its first difference). */
  brightness: number;
  breath: boolean;
}

export class BreathControl implements FxProcessor {
  readonly latency: number;
  private readonly hop: number;
  /** Frames of look-ahead: a breath has to be long enough before it is turned down. */
  private readonly D: number;
  private readonly win: number;
  /** Audio history: the newest `win` samples for analysis and D+1 hops waiting to be output. */
  private readonly histL: Float32Array;
  private readonly histR: Float32Array;
  private readonly inL: Float32Array;
  private readonly inR: Float32Array;
  private readonly outL: Float32Array;
  private readonly outR: Float32Array;
  private readonly cls: Uint8Array;
  private f = 0;
  private reduction = 0.25;
  private sens = 0.5;
  private minRun = 6;
  private breathsOnly = false;
  /** Speech level and noise floor (dBFS), tracked as the recording goes. */
  private speech = -20;
  private floor = -60;
  private readonly levels = new Float32Array(200).fill(200);
  private levelPos = 0;
  private gain = 1;
  private gainCoef = 0;
  private readonly dec: Float32Array;
  private meter = new GainMeter();
  /** Last frames analysed, for tests. */
  frames: BreathFrame[] = [];
  keepFrames = false;

  constructor(private sr: number) {
    this.hop = Math.max(32, Math.round(sr * 0.01));
    this.D = 15;
    this.win = this.hop * 3;
    this.latency = this.hop * (this.D + 1);
    const histLen = this.win + this.hop * (this.D + 1);
    this.histL = new Float32Array(histLen);
    this.histR = new Float32Array(histLen);
    this.inL = new Float32Array(this.hop);
    this.inR = new Float32Array(this.hop);
    this.outL = new Float32Array(this.hop);
    this.outR = new Float32Array(this.hop);
    this.cls = new Uint8Array(2 * this.D + 1);
    this.dec = new Float32Array(Math.ceil(this.win / 4));
    this.gainCoef = Math.exp(-1 / (0.02 * sr));
  }

  setParams(p: Record<string, number>): void {
    this.reduction = dbToLin(Math.min(0, p.reduction ?? -12));
    this.sens = Math.min(1, Math.max(0, (p.sensitivity ?? 50) / 100));
    this.minRun = Math.min(this.D + 1, Math.max(2, Math.round((p.minLength ?? 150) / 10)));
    this.breathsOnly = (p.output ?? 0) >= 1;
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    for (let i = 0; i < n; i++) {
      this.inL[this.f] = L[i];
      this.inR[this.f] = R[i];
      L[i] = this.outL[this.f];
      R[i] = this.outR[this.f];
      if (++this.f === this.hop) {
        this.f = 0;
        this.block();
      }
    }
  }

  private block(): void {
    const { hop, histL, histR, D, cls } = this;
    histL.copyWithin(0, hop);
    histR.copyWithin(0, hop);
    histL.set(this.inL, histL.length - hop);
    histR.set(this.inR, histR.length - hop);
    cls.copyWithin(0, 1);
    cls[cls.length - 1] = this.analyse() ? 1 : 0;
    // the frame leaving now is D frames old: look at the run of breath frames around it
    const o = D;
    let target = 1;
    if (cls[o]) {
      let a = o;
      while (a > 0 && cls[a - 1]) a--;
      let b = o;
      while (b < cls.length - 1 && cls[b + 1]) b++;
      if (b - a + 1 >= this.minRun) target = this.reduction;
    }
    // the hop leaving now is D hops older than the newest
    const start = histL.length - hop * (D + 1);
    let minG = 1;
    for (let i = 0; i < hop; i++) {
      this.gain = target + this.gainCoef * (this.gain - target);
      const g = this.breathsOnly ? 1 - this.gain : this.gain;
      this.outL[i] = histL[start + i] * g;
      this.outR[i] = histR[start + i] * g;
      if (this.gain < minG) minG = this.gain;
    }
    this.meter.note(linToDb(minG));
  }

  /** Classifies the newest frame (the last `win` samples). */
  private analyse(): boolean {
    const { histL, histR, win, dec } = this;
    const off = histL.length - win;
    // level and first-difference energy of the newest hop + its two predecessors
    let e = 0;
    let e1 = 0;
    let prev = 0.5 * (histL[off] + histR[off]);
    for (let i = 1; i < win; i++) {
      const m = 0.5 * (histL[off + i] + histR[off + i]);
      e += m * m;
      e1 += (m - prev) * (m - prev);
      prev = m;
    }
    const rms = Math.sqrt(e / win);
    const level = linToDb(rms);
    // e1/e = mean of (2 sin(pi f / sr))^2 over the spectrum: turn it back into a frequency
    const ratio = e > 1e-14 ? Math.min(4, e1 / e) : 0;
    const brightness = (Math.asin(Math.sqrt(ratio) / 2) * this.sr) / Math.PI;
    // voicing: normalised autocorrelation peak in the pitch range, on a 4x decimated copy
    const step = 4;
    const sr4 = this.sr / step;
    const nd = Math.floor(win / step);
    for (let j = 0; j < nd; j++) {
      let s = 0;
      for (let k = 0; k < step; k++) s += histL[off + j * step + k] + histR[off + j * step + k];
      dec[j] = s;
    }
    const minLag = Math.max(2, Math.floor(sr4 / 400));
    const maxLag = Math.min(nd - 8, Math.ceil(sr4 / 70));
    let voicing = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let xy = 0;
      let xx = 0;
      let yy = 0;
      for (let j = 0; j + lag < nd; j++) {
        xy += dec[j] * dec[j + lag];
        xx += dec[j] * dec[j];
        yy += dec[j + lag] * dec[j + lag];
      }
      const r = xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : 0;
      if (r > voicing) voicing = r;
    }
    // trackers: speech level follows voiced frames, the floor follows the quietest frames
    const dt = this.hop / this.sr;
    if (voicing > 0.6 && level > this.floor + 15) {
      this.speech += (level > this.speech ? 1 - Math.exp(-dt / 0.3) : 1 - Math.exp(-dt / 8)) * (level - this.speech);
    } else {
      this.speech -= 0.5 * dt; // drifts down slowly so a quieter speaker is found again
    }
    // noise floor: the quietest frame of the last two seconds (minimum statistics)
    this.levels[this.levelPos] = level;
    this.levelPos = (this.levelPos + 1) % this.levels.length;
    let min = Infinity;
    for (const v of this.levels) if (v < min) min = v;
    this.floor = Math.max(-100, min);

    const s = this.sens;
    const belowSpeech = 8 + 10 * (1 - s); // dB a breath sits under the speech, at least
    const aboveFloor = 4 + 8 * (1 - s); // dB a breath sits over the room, at least
    const breath =
      voicing < 0.35 + 0.25 * s &&
      level < this.speech - belowSpeech &&
      level > this.floor + aboveFloor &&
      brightness > 300 &&
      brightness < 7500 + 2000 * s;
    if (this.keepFrames) this.frames.push({ level, voicing, brightness, breath });
    return breath;
  }

  takeGain(): number {
    return this.meter.take();
  }

  reset(): void {
    for (const a of [this.histL, this.histR, this.inL, this.inR, this.outL, this.outR]) a.fill(0);
    this.cls.fill(0);
    this.f = 0;
    this.gain = 1;
    this.speech = -20;
    this.floor = -60;
    this.levels.fill(200);
    this.levelPos = 0;
  }
}
