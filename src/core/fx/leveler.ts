// Voice leveler: rides the level of one speaker slowly and smoothly towards a target, like an
// engineer's hand on the fader: a speaker who leans back or gets quieter towards the end of a
// sentence is brought up, one who gets loud is brought down. It only listens to speech (pauses,
// breaths and room noise do not move it) and looks ahead, so the fader moves before a phrase
// starts. Meant to go before the compressor, which then only has to catch the peaks.
import type { FxProcessor } from './processors';
import { kWeighting } from '../loudness';
import { GainMeter } from './meter';

const SPEEDS = [3, 1.2, 0.5];

export class VoiceLeveler implements FxProcessor {
  readonly latency: number;
  private readonly hop: number;
  /** Look-ahead in hops. */
  private readonly ahead = 3;
  private readonly delayL: Float32Array;
  private readonly delayR: Float32Array;
  private pos = 0;
  private readonly k: Array<{ b0: number; b1: number; b2: number; a1: number; a2: number }>;
  /** K-weighting state: [stage][channel][z1, z2]. */
  private readonly z = new Float64Array(8);
  private acc = 0;
  private count = 0;
  /** Energies of the last four hops (400 ms short-term window). */
  private readonly blocks = new Float64Array(4);
  private blockPos = 0;
  private readonly levels = new Float32Array(30).fill(200);
  private levelPos = 0;
  private target = -20;
  private range = 9;
  private speedS = 1.2;
  /** Current and wanted gain in dB. */
  private gainDb = 0;
  private wantDb = 0;
  private gainLin = 1;
  private nextLin = 1;
  private speech = -100;
  private meter = new GainMeter();

  constructor(private sr: number) {
    this.hop = Math.max(32, Math.round(sr * 0.1));
    this.latency = this.hop * this.ahead;
    this.delayL = new Float32Array(this.latency);
    this.delayR = new Float32Array(this.latency);
    this.k = kWeighting(sr);
  }

  setParams(p: Record<string, number>): void {
    this.target = p.target ?? -20;
    this.range = Math.max(0, p.range ?? 9);
    this.speedS = SPEEDS[Math.max(0, Math.min(2, Math.round(p.speed ?? 1)))];
  }

  private kw(x: number, ch: number): number {
    // two biquads in direct form II transposed
    let y = x;
    for (let s = 0; s < 2; s++) {
      const c = this.k[s];
      const o = s * 4 + ch * 2;
      const out = c.b0 * y + this.z[o];
      this.z[o] = c.b1 * y - c.a1 * out + this.z[o + 1];
      this.z[o + 1] = c.b2 * y - c.a2 * out;
      y = out;
    }
    return y;
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    const lat = this.latency;
    let extreme = 0;
    for (let i = 0; i < n; i++) {
      const l = L[i];
      const r = R[i];
      const kl = this.kw(l, 0);
      const kr = this.kw(r, 1);
      this.acc += 0.5 * (kl * kl + kr * kr);
      if (++this.count === this.hop) this.endBlock();
      // gain moves linearly across each hop towards the value for the next one
      this.gainLin += (this.nextLin - this.gainLin) / Math.max(1, this.hop - this.count);
      const dl = this.delayL[this.pos];
      const dr = this.delayR[this.pos];
      this.delayL[this.pos] = l;
      this.delayR[this.pos] = r;
      this.pos = this.pos + 1 === lat ? 0 : this.pos + 1;
      L[i] = dl * this.gainLin;
      R[i] = dr * this.gainLin;
    }
    extreme = this.gainDb;
    this.meter.note(extreme);
  }

  private endBlock(): void {
    const e = this.acc / this.hop;
    this.acc = 0;
    this.count = 0;
    this.blocks[this.blockPos] = e;
    this.blockPos = (this.blockPos + 1) % this.blocks.length;
    let sum = 0;
    for (const v of this.blocks) sum += v;
    const loud = -0.691 + 10 * Math.log10(sum / this.blocks.length + 1e-15);
    const momentary = -0.691 + 10 * Math.log10(e + 1e-15);
    // noise floor: the quietest 100 ms of the last three seconds
    this.levels[this.levelPos] = momentary;
    this.levelPos = (this.levelPos + 1) % this.levels.length;
    let floor = Infinity;
    for (const v of this.levels) if (v < floor) floor = v;
    // speech: clearly above the room, not far below the speaker's recent level, not silence
    const isSpeech = momentary > -60 && momentary > floor + 10 && momentary > this.speech - 20;
    if (isSpeech) {
      this.speech = Math.max(this.speech - 0.5, loud);
      this.wantDb = Math.max(-this.range, Math.min(this.range, this.target - loud));
    } else {
      this.speech -= 0.3; // slowly lets a quieter speaker count as speech again
    }
    // in pauses the fader stays where it is
    const c = Math.exp(-(this.hop / this.sr) / this.speedS);
    this.gainDb = this.wantDb + c * (this.gainDb - this.wantDb);
    this.nextLin = Math.pow(10, this.gainDb / 20);
  }

  takeGain(): number {
    return this.meter.take();
  }

  reset(): void {
    this.delayL.fill(0);
    this.delayR.fill(0);
    this.pos = 0;
    this.z.fill(0);
    this.acc = 0;
    this.count = 0;
    this.blocks.fill(0);
    // the fader position and what was learned about the speaker stay across a jump
  }
}
