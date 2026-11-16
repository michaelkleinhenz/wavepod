// Speech restoration (bandwidth extension): phone calls, Zoom/VoIP and low-bitrate recordings
// lack the highs (above 3.4 kHz on a phone, 7–8 kHz on most calls) and, on phones, the lows
// below 300 Hz. The filter finds those edges by itself, then rebuilds the missing parts from the
// voice that is there: rectifying the octave below the high edge creates its overtones above it,
// rectifying the octave above the low edge recreates the fundamental below it. Each new band is
// kept at a natural level relative to the band it grew from, so it follows the voice exactly.
import type { FxProcessor } from './processors';
import { Biquad } from './biquad';
import { fft } from '../fft';
import { GainMeter } from './meter';

/** Fixed band limits for the "Source" choice (0 = find it). */
export const RESTORE_SOURCES: Array<{ label: string; low: number; high: number }> = [
  { label: 'Find it', low: 0, high: 0 },
  { label: 'Phone (300 Hz–3.4 kHz)', low: 300, high: 3400 },
  { label: 'Mobile / HD voice (7 kHz)', low: 100, high: 7000 },
  { label: 'Zoom, Teams, Skype (8 kHz)', low: 0, high: 8000 },
  { label: 'Low-bitrate MP3 (11 kHz)', low: 0, high: 11000 },
];

const N = 2048;

/**
 * Energy of each rebuilt octave relative to the octave it grows from, at "Highs" and "Lows" 0 dB.
 * In the long-term spectrum of speech the octave and a half above 3.4 kHz holds about as much as
 * the octave under it, the half octave after that about 9 dB less, and the lows below 300 Hz are close to the octave above. These
 * sit a little under that, since rebuilt overtones sound harsh sooner than real ones.
 */
const HIGH_SHARE = [Math.pow(10, 1 / 10), Math.pow(10, -8 / 10)];
const LOW_SHARE = Math.pow(10, -2 / 10);

/** Finds the band limits in an averaged power spectrum (bins of sr/N Hz). Exposed for tests. */
export function findBandLimits(avg: Float64Array, sr: number): { low: number; high: number } {
  const bin = sr / N;
  const P = (f1: number, f2: number) => {
    const a = Math.max(1, Math.floor(f1 / bin));
    const b = Math.min(avg.length - 1, Math.ceil(f2 / bin));
    let s = 0;
    for (let k = a; k <= b; k++) s += avg[k];
    return s / Math.max(1, b - a + 1) + 1e-30;
  };
  const db = (x: number) => 10 * Math.log10(x);
  // high edge: the first cliff, a fall of ≥ 20 dB within about a kilohertz after which nothing
  // comes back. The edge itself is where the level falls 10 dB under the trend of the voice below
  // the cliff (a straight line in dB fitted to the 1.3 kHz under it), so a dull voice whose
  // highs taper off anyway is not cut short.
  let high = 0;
  const top = sr * 0.45;
  const L = (f: number) => db(P(f - 250, f + 250));
  for (let f = 2500; f < top - 1000; f += 100) {
    const below = P(f - 500, f);
    if (db(below / P(f + 500, f + 1000)) >= 20 && db(below / P(f + 500, Math.min(top, f + 3000))) >= 20) {
      let sx = 0;
      let sy = 0;
      let sxx = 0;
      let sxy = 0;
      let n = 0;
      for (let g = f - 2000; g <= f - 700; g += 100) {
        const y = L(g);
        sx += g;
        sy += y;
        sxx += g * g;
        sxy += g * y;
        n++;
      }
      const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
      const at = (g: number) => sy / n + slope * (g - sx / n);
      high = f + 1000;
      for (let g = f - 600; g <= f + 1000; g += 50) {
        if (L(g) < at(g) - 10) {
          high = g;
          break;
        }
      }
      break;
    }
  }
  // low edge (a phone's high-pass): below it the level falls deep under the voice's (> 35 dB
  // under its 500 Hz–2 kHz level, per bin); the edge is where it is back within 20 dB above that
  const ref = P(500, 2000);
  const third = (f: number) => db(P(f / 1.12, f * 1.12) / ref);
  let deep = 0;
  for (let f = 120; f <= 450; f += 10) if (third(f) < -35) deep = f;
  let low = 0;
  if (deep > 0) {
    for (let f = deep + 10; f <= 600; f += 10) {
      if (third(f) >= -20) {
        low = f;
        break;
      }
    }
  }
  return { low, high };
}

class Butter {
  private s: Biquad[];
  constructor(kind: 'lowpass' | 'highpass', f: number, sr: number, order: 2 | 4) {
    const qs = order === 4 ? [0.5412, 1.3066] : [Math.SQRT1_2];
    this.s = qs.map((q) => new Biquad(kind, f, sr, q));
  }
  tick(x: number, ch: number): number {
    for (const b of this.s) x = b.tick(x, ch);
    return x;
  }
  reset(): void {
    for (const b of this.s) b.reset();
  }
}

/** One step of a rebuild: rectify the band below, keep the new octave, at a set share of the source. */
class Stage {
  readonly outA: Butter;
  readonly outB: Butter;
  readonly eOut = [0, 0];
  readonly gain = [0, 0];
  /**
   * @param lo,hi the band it makes
   * @param share its energy relative to the source band's (natural tilt of speech)
   * @param odd also make the odd overtones (3×, 5×), which |x| alone does not
   */
  constructor(lo: number, hi: number, readonly share: number, sr: number, lowSide: boolean, readonly odd = false) {
    // above the edge: a steep high-pass at the edge; below it: a steep low-pass at the edge
    this.outA = lowSide ? new Butter('lowpass', hi, sr, 4) : new Butter('highpass', lo, sr, 4);
    this.outB = lowSide ? new Butter('highpass', lo, sr, 2) : new Butter('lowpass', hi, sr, 2);
  }
  reset(): void {
    this.outA.reset();
    this.outB.reset();
    this.eOut.fill(0);
    this.gain.fill(0);
  }
}

/**
 * One rebuilt side: the source band next to the edge is rectified, which creates its overtones
 * (above) or its difference tones (below); each stage is held at a natural share of the source
 * band's energy, so it rises and falls with the voice. Above, a second stage rectifies the first
 * to reach the octave after it.
 */
class Rebuild {
  private srcHp: Butter;
  private srcLp: Butter;
  readonly eSrc = [0, 0];
  constructor(
    srcLo: number,
    srcHi: number,
    readonly stages: Stage[],
    sr: number,
  ) {
    this.srcHp = new Butter('highpass', srcLo, sr, 4);
    this.srcLp = new Butter('lowpass', srcHi, sr, 4);
  }
  /** The added signal for channel ch, at amt × the natural level. */
  tick(x: number, ch: number, amt: number, cE: number, cG: number): number {
    const s = this.srcLp.tick(this.srcHp.tick(x, ch), ch);
    this.eSrc[ch] = s * s + cE * (this.eSrc[ch] - s * s);
    let input = s;
    let add = 0;
    const rms = Math.sqrt(this.eSrc[ch]) + 1e-9;
    for (const st of this.stages) {
      const r = Math.abs(input);
      const g = st.outB.tick(st.outA.tick(st.odd ? r + (0.5 * input * r) / rms : r, ch), ch);
      st.eOut[ch] = g * g + cE * (st.eOut[ch] - g * g);
      // at most +30 dB of make-up, so near-silence is not blown up
      const want = st.eOut[ch] > 1e-14 ? Math.min(31.6, Math.sqrt((amt * st.share * this.eSrc[ch]) / st.eOut[ch])) : 0;
      st.gain[ch] = want + cG * (st.gain[ch] - want);
      input = st.gain[ch] * g;
      add += input;
    }
    return add;
  }
  reset(): void {
    this.srcHp.reset();
    this.srcLp.reset();
    this.eSrc.fill(0);
    for (const st of this.stages) st.reset();
  }
}

export class SpeechRestore implements FxProcessor {
  readonly latency = 0;
  private source = 0;
  private highAmt = 0;
  private lowAmt = 0;
  private addedOnly = false;
  /** The band limits in use (0 = nothing to rebuild on that side); learned ones survive a jump. */
  low = 0;
  high = 0;
  private hi: Rebuild | null = null;
  private lo: Rebuild | null = null;
  // detection
  private readonly buf = new Float64Array(N);
  private fill = 0;
  private readonly avg = new Float64Array(N / 2);
  private readonly win = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  private peakE = 0;
  private speechFrames = 0;
  private readonly cE: number;
  private readonly cG: number;
  private meter = new GainMeter();

  constructor(private sr: number) {
    this.cE = Math.exp(-1 / (0.01 * sr));
    this.cG = Math.exp(-1 / (0.005 * sr));
  }

  setParams(p: Record<string, number>): void {
    const source = Math.max(0, Math.min(RESTORE_SOURCES.length - 1, Math.round(p.source ?? 0)));
    const highs = p.highs ?? 0;
    const lows = p.lows ?? 0;
    this.highAmt = highs <= -18 ? 0 : Math.pow(10, highs / 10);
    this.lowAmt = lows <= -18 ? 0 : Math.pow(10, lows / 10);
    this.addedOnly = (p.output ?? 0) >= 1;
    if (source !== this.source || (!this.hi && !this.lo && source > 0)) {
      this.source = source;
      if (source > 0) this.setLimits(RESTORE_SOURCES[source].low, RESTORE_SOURCES[source].high);
    }
  }

  private setLimits(low: number, high: number): void {
    const sr = this.sr;
    if (high !== this.high) {
      this.high = high;
      // the octave below the edge grows its 2nd and 3rd overtones above it, and those the next ones
      const top = sr * 0.45;
      const stages = high > 0 && high < sr * 0.42 ? [new Stage(high, Math.min(top, 3 * high), HIGH_SHARE[0], sr, false, true)] : [];
      if (stages.length && 3 * high < sr * 0.4) stages.push(new Stage(3 * high, Math.min(top, 4.5 * high), HIGH_SHARE[1], sr, false));
      this.hi = stages.length ? new Rebuild(high / 2, high * 0.95, stages, sr) : null;
    }
    if (low !== this.low) {
      this.low = low;
      this.lo = low > 60 ? new Rebuild(low * 1.05, low * 2, [new Stage(50, low, LOW_SHARE, sr, true)], sr) : null;
    }
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    const { cE, cG } = this;
    let added = 0;
    let total = 0;
    for (let i = 0; i < n; i++) {
      if (this.source === 0) {
        this.buf[this.fill++] = 0.5 * (L[i] + R[i]);
        if (this.fill === N) {
          this.fill = 0;
          this.detect();
        }
      }
      for (let ch = 0; ch < 2; ch++) {
        const x = ch === 0 ? L[i] : R[i];
        let add = 0;
        if (this.hi && this.highAmt > 0) add += this.hi.tick(x, ch, this.highAmt, cE, cG);
        if (this.lo && this.lowAmt > 0) add += this.lo.tick(x, ch, this.lowAmt, cE, cG);
        const y = this.addedOnly ? add : x + add;
        if (ch === 0) L[i] = y;
        else R[i] = y;
        added += add * add;
        total += x * x;
      }
    }
    // the card shows how much was added (positive dB)
    if (total > 0 && added > 0) this.meter.note(Math.min(24, 10 * Math.log10(1 + added / total)));
  }

  private detect(): void {
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    let e = 0;
    for (let i = 0; i < N; i++) {
      re[i] = this.buf[i] * this.win[i];
      e += this.buf[i] * this.buf[i];
    }
    e /= N;
    this.peakE = Math.max(e, this.peakE * 0.999);
    // only speech: frames within 13 dB of the recent loudest
    if (e < this.peakE * 0.05 || e < 1e-8) return;
    fft(re, im);
    const a = this.speechFrames < 200 ? 1 / (this.speechFrames + 1) : 0.005;
    for (let k = 0; k < N / 2; k++) this.avg[k] += a * (re[k] * re[k] + im[k] * im[k] - this.avg[k]);
    this.speechFrames++;
    if (this.speechFrames >= 20 && this.speechFrames % 10 === 0) {
      const { low, high } = findBandLimits(this.avg, this.sr);
      // move only on a clear change, so the sound does not flutter
      this.setLimits(Math.abs(low - this.low) > 40 ? low : this.low, Math.abs(high - this.high) > 300 ? high : this.high);
    }
  }

  takeGain(): number {
    return this.meter.take();
  }

  reset(): void {
    this.hi?.reset();
    this.lo?.reset();
    this.fill = 0;
  }
}
