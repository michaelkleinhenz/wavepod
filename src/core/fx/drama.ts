// Sound-design filters for audio dramas: band-pass (telephone, radio, behind a wall), distortion
// (grit, clipping, bit crushing) and echo (outdoors, mountains, dreams).
import type { FxProcessor } from './processors';
import { Biquad } from './biquad';

const dbToLin = (db: number) => Math.pow(10, db / 20);
const BUTTERWORTH = { 12: [Math.SQRT1_2], 24: [0.5412, 1.3066] } as const;

/** Butterworth high-pass and low-pass in series: only the band between the two cuts passes. */
export class BandPass implements FxProcessor {
  readonly latency = 0;
  private stages: Biquad[] = [];
  private gain = 1;
  private key = '';
  constructor(private sr: number) {}
  setParams(p: Record<string, number>): void {
    this.gain = dbToLin(p.gain ?? 0);
    const qs = p.slope >= 24 ? BUTTERWORTH[24] : BUTTERWORTH[12];
    // a low cut at the minimum is off, so "behind a wall" can be a pure low-pass
    const lowCut = p.lowCut > 20.5 ? p.lowCut : 0;
    const highCut = Math.max(p.highCut, lowCut * 1.1);
    const key = `${lowCut}/${highCut}/${qs.length}`;
    if (key === this.key) return;
    this.key = key;
    const specs: Array<['highpass' | 'lowpass', number, number]> = [];
    if (lowCut) for (const q of qs) specs.push(['highpass', lowCut, q]);
    if (highCut < this.sr * 0.45) for (const q of qs) specs.push(['lowpass', highCut, q]);
    if (specs.length !== this.stages.length) this.stages = specs.map(([k, f, q]) => new Biquad(k, f, this.sr, q));
    else specs.forEach(([k, f, q], i) => this.stages[i].set(k, f, this.sr, q));
  }
  process(L: Float32Array, R: Float32Array, n: number): void {
    for (const s of this.stages) {
      s.process(L, n, 0);
      s.process(R, n, 1);
    }
    if (this.gain !== 1) {
      for (let i = 0; i < n; i++) {
        L[i] *= this.gain;
        R[i] *= this.gain;
      }
    }
  }
  reset(): void {
    for (const s of this.stages) s.reset();
  }
}

type Shape = (x: number) => number;
const SHAPES: Shape[] = [
  // soft: tanh saturation
  Math.tanh,
  // hard: clipping at full scale
  (x) => (x > 1 ? 1 : x < -1 ? -1 : x),
  // fuzz: asymmetric, the negative half clips early (odd and even harmonics, like a torn cone)
  (x) => (x >= 0 ? Math.tanh(x) : Math.max(-0.4, Math.tanh(x * 1.8) * 0.6)),
];

/** Speech peaks sit around this level; the distortion keeps it about the same loudness there. */
const REF_LEVEL = 0.15;

/** Waveshaper with drive, optional bit and sample-rate reduction and a tone filter (always 100 % wet). */
export class Distortion implements FxProcessor {
  readonly latency = 0;
  private shape: Shape = SHAPES[0];
  private drive = 1;
  private comp = 1;
  private levels = 0;
  private step = 1;
  private phase = 0;
  private held = [0, 0];
  private tone = new Biquad('lowpass', 12000, 48000);
  private toneOn = true;
  private dcX = [0, 0];
  private dcY = [0, 0];
  private dcR = 0.995;
  private key = '';
  constructor(private sr: number) {
    this.dcR = Math.exp((-2 * Math.PI * 20) / sr);
  }
  setParams(p: Record<string, number>): void {
    this.shape = SHAPES[Math.round(p.mode ?? 0)] ?? SHAPES[0];
    this.drive = dbToLin(p.drive ?? 0);
    const atRef = Math.abs(this.shape(this.drive * REF_LEVEL));
    this.comp = atRef > 1e-6 ? REF_LEVEL / atRef : 1;
    const bits = Math.round(p.bits ?? 16);
    this.levels = bits >= 16 ? 0 : Math.pow(2, bits - 1);
    this.step = Math.max(1, this.sr / Math.max(1000, p.rate ?? this.sr));
    const tone = p.tone ?? 20000;
    this.toneOn = tone < this.sr * 0.45 && tone < 19900;
    const key = String(tone);
    if (key !== this.key) {
      this.key = key;
      this.tone.set('lowpass', tone, this.sr, Math.SQRT1_2);
    }
  }
  process(L: Float32Array, R: Float32Array, n: number): void {
    this.channel(L, n, 0, this.phase);
    this.phase = this.channel(R, n, 1, this.phase);
  }
  /** Processes one channel; returns the sample-and-hold phase after the block. */
  private channel(buf: Float32Array, n: number, ch: number, phase0: number): number {
    const { shape, drive, comp, levels, step, dcR } = this;
    let phase = phase0;
    let held = this.held[ch];
    let x1 = this.dcX[ch];
    let y1 = this.dcY[ch];
    for (let i = 0; i < n; i++) {
      const x = buf[i];
      let y = shape(x * drive) * comp;
      if (levels) y = Math.round(y * levels) / levels;
      if (step > 1) {
        // sample and hold: the sound of a low sample rate, aliasing included
        if (phase <= 0) {
          held = y;
          phase += step;
        }
        phase -= 1;
        y = held;
      }
      // DC blocker (the fuzz curve is asymmetric)
      const d = y - x1 + dcR * y1;
      x1 = y;
      y1 = Math.abs(d) < 1e-25 ? 0 : d;
      buf[i] = d;
    }
    this.held[ch] = held;
    this.dcX[ch] = x1;
    this.dcY[ch] = y1;
    if (this.toneOn) this.tone.process(buf, n, ch);
    return phase;
  }
  reset(): void {
    this.phase = 0;
    this.held = [0, 0];
    this.dcX = [0, 0];
    this.dcY = [0, 0];
    this.tone.reset();
  }
}

/**
 * Wraps the shaper so the dry signal can be mixed back in: the shaper works on a copy.
 * (Kept apart from Distortion so the common 100 % wet case needs no extra buffers.)
 */
export class DistortionMix implements FxProcessor {
  readonly latency = 0;
  private inner: Distortion;
  private wet = 1;
  private out = 1;
  private dryL = new Float32Array(0);
  private dryR = new Float32Array(0);
  constructor(sr: number) {
    this.inner = new Distortion(sr);
  }
  setParams(p: Record<string, number>): void {
    this.inner.setParams(p);
    this.wet = Math.min(1, Math.max(0, (p.mix ?? 100) / 100));
    this.out = dbToLin(p.output ?? 0);
  }
  process(L: Float32Array, R: Float32Array, n: number): void {
    const wet = this.wet;
    if (wet < 1) {
      if (this.dryL.length < n) {
        this.dryL = new Float32Array(n);
        this.dryR = new Float32Array(n);
      }
      this.dryL.set(L.subarray(0, n));
      this.dryR.set(R.subarray(0, n));
    }
    this.inner.process(L, R, n);
    const dry = 1 - wet;
    const out = this.out;
    if (wet < 1 || out !== 1) {
      for (let i = 0; i < n; i++) {
        L[i] = (wet < 1 ? L[i] * wet + this.dryL[i] * dry : L[i]) * out;
        R[i] = (wet < 1 ? R[i] * wet + this.dryR[i] * dry : R[i]) * out;
      }
    }
  }
  reset(): void {
    this.inner.reset();
  }
}

/** Stereo delay with damped feedback and optional ping-pong. */
export class Echo implements FxProcessor {
  readonly latency = 0;
  private bufL: Float32Array;
  private bufR: Float32Array;
  private pos = 0;
  private delay = 1;
  private fb = 0.3;
  private dry = 1;
  private wet = 0.5;
  private spread = 0;
  private damp = 0;
  private lpL = 0;
  private lpR = 0;
  constructor(private sr: number) {
    this.bufL = new Float32Array(Math.ceil(2.05 * sr));
    this.bufR = new Float32Array(this.bufL.length);
  }
  setParams(p: Record<string, number>): void {
    this.delay = Math.min(this.bufL.length - 1, Math.max(1, Math.round(((p.time ?? 300) / 1000) * this.sr)));
    this.fb = Math.min(0.9, Math.max(0, (p.feedback ?? 30) / 100));
    const mix = Math.min(1, Math.max(0, (p.mix ?? 25) / 100));
    // equal at 50 %: full dry below, full wet above
    this.dry = mix <= 0.5 ? 1 : 2 * (1 - mix);
    this.wet = mix <= 0.5 ? 2 * mix : 1;
    this.spread = Math.min(1, Math.max(0, (p.spread ?? 0) / 100));
    const hc = p.highCut ?? 5000;
    this.damp = hc >= 19900 ? 0 : Math.exp((-2 * Math.PI * hc) / this.sr);
  }
  process(L: Float32Array, R: Float32Array, n: number): void {
    const { bufL, bufR, delay, fb, dry, wet, spread, damp } = this;
    const len = bufL.length;
    const s = spread;
    let pos = this.pos;
    let lpL = this.lpL;
    let lpR = this.lpR;
    for (let i = 0; i < n; i++) {
      let r = pos - delay;
      if (r < 0) r += len;
      // each repeat passes a one-pole low-pass: later echoes get duller, like real reflections
      lpL = bufL[r] + damp * (lpL - bufL[r]);
      lpR = bufR[r] + damp * (lpR - bufR[r]);
      const l = L[i];
      const rr = R[i];
      const mono = (l + rr) * 0.5;
      // ping-pong: the input enters on the left only and each repeat crosses to the other side
      bufL[pos] = (1 - s) * l + s * mono + fb * ((1 - s) * lpL + s * lpR);
      bufR[pos] = (1 - s) * rr + fb * ((1 - s) * lpR + s * lpL);
      L[i] = l * dry + lpL * wet;
      R[i] = rr * dry + lpR * wet;
      if (++pos === len) pos = 0;
    }
    this.pos = pos;
    this.lpL = Math.abs(lpL) < 1e-25 ? 0 : lpL;
    this.lpR = Math.abs(lpR) < 1e-25 ? 0 : lpR;
  }
  reset(): void {
    this.bufL.fill(0);
    this.bufR.fill(0);
    this.pos = 0;
    this.lpL = 0;
    this.lpR = 0;
  }
}
