// Voice changers for audio dramas: pitch shift (giants, creatures, chipmunks), ring modulator
// (robots, aliens) and chorus / flanger / vibrato (magic, dreams, ghosts).
import type { FxProcessor } from './processors';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Reads a circular buffer `delay` samples (fractional) behind `pos`, linearly interpolated. */
function readAt(buf: Float32Array, pos: number, delay: number): number {
  let r = pos - delay;
  const len = buf.length;
  while (r < 0) r += len;
  const i = Math.floor(r);
  const f = r - i;
  const a = buf[i];
  const b = buf[i + 1 === len ? 0 : i + 1];
  return a + (b - a) * f;
}

/**
 * Delay-line pitch shifter: two read heads sweep through a short window at the new speed and
 * cross-fade (Hann windows), so the pitch changes but the timing stays. The window decides the
 * character: short is grainier but follows fast speech, long is smoother but smears.
 * Formants move with the pitch (up sounds smaller, down sounds bigger).
 * Latency: half a window, compensated by the mixer; the dry signal is delayed to match.
 */
export class PitchShift implements FxProcessor {
  latency = 0;
  private bufL: Float32Array;
  private bufR: Float32Array;
  private pos = 0;
  private phase = 0;
  private ratio = 1;
  private window = 2400;
  private wet = 1;
  private dry = 0;
  constructor(private sr: number) {
    this.bufL = new Float32Array(Math.ceil(0.25 * sr));
    this.bufR = new Float32Array(this.bufL.length);
  }
  setParams(p: Record<string, number>): void {
    const semis = (p.semitones ?? 0) + (p.cents ?? 0) / 100;
    this.ratio = Math.pow(2, semis / 12);
    this.window = Math.round(clamp(p.window ?? 50, 10, 200) * this.sr / 1000);
    this.latency = Math.round(this.window / 2);
    const mix = clamp((p.mix ?? 100) / 100, 0, 1);
    this.wet = mix;
    this.dry = 1 - mix;
  }
  process(L: Float32Array, R: Float32Array, n: number): void {
    const { bufL, bufR, window: w, wet, dry, latency } = this;
    const len = bufL.length;
    // delay of a head falls (pitch up) or rises (pitch down) by (ratio - 1) samples per sample
    const step = (1 - this.ratio) / w;
    let pos = this.pos;
    let ph = this.phase;
    for (let i = 0; i < n; i++) {
      bufL[pos] = L[i];
      bufR[pos] = R[i];
      const ph2 = ph + 0.5 >= 1 ? ph - 0.5 : ph + 0.5;
      const d1 = 1 + ph * w;
      const d2 = 1 + ph2 * w;
      const g1 = 0.5 - 0.5 * Math.cos(2 * Math.PI * ph);
      const g2 = 1 - g1;
      const l = readAt(bufL, pos, d1) * g1 + readAt(bufL, pos, d2) * g2;
      const r = readAt(bufR, pos, d1) * g1 + readAt(bufR, pos, d2) * g2;
      if (dry > 0) {
        let k = pos - latency;
        if (k < 0) k += len;
        L[i] = l * wet + bufL[k] * dry;
        R[i] = r * wet + bufR[k] * dry;
      } else {
        L[i] = l;
        R[i] = r;
      }
      ph += step;
      if (ph >= 1) ph -= 1;
      else if (ph < 0) ph += 1;
      if (++pos === len) pos = 0;
    }
    this.pos = pos;
    this.phase = ph;
  }
  reset(): void {
    this.bufL.fill(0);
    this.bufR.fill(0);
    this.pos = 0;
    this.phase = 0;
  }
}

type Wave = (phase: number) => number;
const WAVES: Wave[] = [
  (p) => Math.sin(2 * Math.PI * p),
  (p) => (p < 0.5 ? 1 : -1),
  (p) => (p < 0.5 ? 4 * p - 1 : 3 - 4 * p),
];

/**
 * Ring modulator: multiplies the voice with a tone. Low tones (30–60 Hz) give the classic metallic
 * robot, higher ones an alien, bell-like voice. Wobble moves the tone slowly up and down.
 */
export class RingMod implements FxProcessor {
  readonly latency = 0;
  private phase = 0;
  private lfo = 0;
  private freq = 50;
  private wave: Wave = WAVES[0];
  private wet = 1;
  private dry = 0;
  private wobbleRate = 0;
  private wobbleDepth = 0;
  constructor(private sr: number) {}
  setParams(p: Record<string, number>): void {
    this.freq = clamp(p.freq ?? 50, 1, 5000);
    this.wave = WAVES[Math.round(p.shape ?? 0)] ?? WAVES[0];
    const mix = clamp((p.mix ?? 100) / 100, 0, 1);
    this.wet = mix;
    this.dry = 1 - mix;
    this.wobbleRate = clamp(p.wobbleRate ?? 0, 0, 20);
    this.wobbleDepth = clamp((p.wobble ?? 0) / 100, 0, 1);
  }
  process(L: Float32Array, R: Float32Array, n: number): void {
    const { sr, freq, wave, wet, dry, wobbleDepth } = this;
    const lfoStep = this.wobbleRate / sr;
    let ph = this.phase;
    let lfo = this.lfo;
    for (let i = 0; i < n; i++) {
      const c = wave(ph);
      const m = c * wet + dry;
      L[i] *= m;
      R[i] *= m;
      const f = wobbleDepth ? freq * Math.pow(2, wobbleDepth * Math.sin(2 * Math.PI * lfo)) : freq;
      ph += f / sr;
      if (ph >= 1) ph -= Math.floor(ph);
      lfo += lfoStep;
      if (lfo >= 1) lfo -= 1;
    }
    this.phase = ph;
    this.lfo = lfo;
  }
  reset(): void {
    this.phase = 0;
    this.lfo = 0;
  }
}

/**
 * Chorus, flanger and vibrato in one: a short delay swept by a slow oscillator, mixed with the
 * dry voice. Chorus: 10–30 ms, several voices, no feedback (a choir, magic). Flanger: 1–5 ms with
 * feedback (the jet "whoosh", dreams, teleports). Vibrato: 100 % wet (a wavering, ghostly voice).
 * The left and right sweeps run a quarter turn apart for width.
 */
export class Chorus implements FxProcessor {
  readonly latency = 0;
  private bufL: Float32Array;
  private bufR: Float32Array;
  private pos = 0;
  private lfo = 0;
  private delay = 480;
  private depth = 0;
  private rate = 0.5;
  private fb = 0;
  private wet = 0.5;
  private dry = 1;
  private voices = 1;
  private spread = 0.25;
  private fbL = 0;
  private fbR = 0;
  constructor(private sr: number) {
    this.bufL = new Float32Array(Math.ceil(0.12 * sr));
    this.bufR = new Float32Array(this.bufL.length);
  }
  setParams(p: Record<string, number>): void {
    const sr = this.sr;
    this.delay = clamp(p.delay ?? 15, 0.3, 50) * sr / 1000;
    // depth: how far the sweep moves, as a share of the delay
    this.depth = this.delay * clamp((p.depth ?? 40) / 100, 0, 1) * 0.95;
    this.rate = clamp(p.rate ?? 0.5, 0.01, 10);
    this.fb = clamp((p.feedback ?? 0) / 100, -0.95, 0.95);
    const mix = clamp((p.mix ?? 50) / 100, 0, 1);
    this.dry = mix <= 0.5 ? 1 : 2 * (1 - mix);
    this.wet = mix <= 0.5 ? 2 * mix : 1;
    this.voices = clamp(Math.round(p.voices ?? 1), 1, 4);
    this.spread = clamp((p.width ?? 100) / 100, 0, 1) * 0.25;
  }
  process(L: Float32Array, R: Float32Array, n: number): void {
    const { bufL, bufR, delay, depth, fb, wet, dry, voices, spread } = this;
    const len = bufL.length;
    const step = this.rate / this.sr;
    const norm = 1 / Math.sqrt(voices);
    let pos = this.pos;
    let lfo = this.lfo;
    let fbL = this.fbL;
    let fbR = this.fbR;
    for (let i = 0; i < n; i++) {
      const l = L[i];
      const r = R[i];
      bufL[pos] = l + fbL * fb;
      bufR[pos] = r + fbR * fb;
      let wl = 0;
      let wr = 0;
      for (let v = 0; v < voices; v++) {
        const off = v / voices;
        const sl = Math.sin(2 * Math.PI * (lfo + off));
        const sr = Math.sin(2 * Math.PI * (lfo + off + spread));
        wl += readAt(bufL, pos, 1 + delay - depth * 0.5 * (1 - sl));
        wr += readAt(bufR, pos, 1 + delay - depth * 0.5 * (1 - sr));
      }
      wl *= norm;
      wr *= norm;
      fbL = Math.abs(wl) < 1e-25 ? 0 : wl;
      fbR = Math.abs(wr) < 1e-25 ? 0 : wr;
      L[i] = l * dry + wl * wet;
      R[i] = r * dry + wr * wet;
      lfo += step;
      if (lfo >= 1) lfo -= 1;
      if (++pos === len) pos = 0;
    }
    this.pos = pos;
    this.lfo = lfo;
    this.fbL = fbL;
    this.fbR = fbR;
  }
  reset(): void {
    this.bufL.fill(0);
    this.bufR.fill(0);
    this.pos = 0;
    this.lfo = 0;
    this.fbL = 0;
    this.fbR = 0;
  }
}
