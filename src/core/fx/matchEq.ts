// Voice match (match EQ): learns the tonal difference between a voice and a reference (another
// speaker's mic, or the original take a retake should sound like) and applies it as a smooth EQ.
// Learning measures the long-term spectrum of the speech in both, in third-octave bands; the
// filter is a bank of bell filters fitted to that curve. Level is not matched, only tone.
import type { MatchCurve } from '../../shared/types';
import type { FxProcessor } from './processors';
import { Biquad } from './biquad';
import { fft } from '../fft';

/** Third-octave band centres, 31.5 Hz to 16 kHz. */
export const MATCH_BANDS: number[] = Array.from({ length: 28 }, (_, i) => 1000 * Math.pow(2, (i - 15) / 3));

/** The most a band is raised or lowered, in dB. */
export const MATCH_MAX_DB = 12;

export const MATCH_FRAME = 4096;
const FRAME = MATCH_FRAME;

/** Collects third-octave band powers of speech frames of a signal. */
export class SpectrumCollector {
  private frames: Float32Array[] = [];
  private energies: number[] = [];
  private buf = new Float32Array(FRAME);
  private fill = 0;
  private readonly win = Float64Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME));
  private readonly bandOf: Int16Array;

  constructor(readonly sampleRate: number) {
    // FFT bin -> band index (bands meet halfway between centres on a log scale)
    this.bandOf = new Int16Array(FRAME / 2).fill(-1);
    for (let k = 1; k < FRAME / 2; k++) {
      const f = (k * sampleRate) / FRAME;
      const b = Math.round(3 * Math.log2(f / 1000)) + 15;
      if (b >= 0 && b < MATCH_BANDS.length) this.bandOf[k] = b;
    }
  }

  /** Adds mono samples. */
  push(x: Float32Array, n = x.length): void {
    let i = 0;
    while (i < n) {
      const take = Math.min(n - i, FRAME - this.fill);
      this.buf.set(x.subarray(i, i + take), this.fill);
      this.fill += take;
      i += take;
      if (this.fill === FRAME) {
        this.frame();
        // half overlap
        this.buf.copyWithin(0, FRAME / 2);
        this.fill = FRAME / 2;
      }
    }
  }

  private frame(): void {
    const re = new Float64Array(FRAME);
    const im = new Float64Array(FRAME);
    let e = 0;
    for (let i = 0; i < FRAME; i++) {
      re[i] = this.buf[i] * this.win[i];
      e += this.buf[i] * this.buf[i];
    }
    fft(re, im);
    const bands = new Float32Array(MATCH_BANDS.length);
    for (let k = 1; k < FRAME / 2; k++) {
      const b = this.bandOf[k];
      if (b >= 0) bands[b] += re[k] * re[k] + im[k] * im[k];
    }
    this.frames.push(bands);
    this.energies.push(e / FRAME);
  }

  /** Frames of speech so far: the loud ones (within 20 dB of the 90th percentile). */
  get speechFrames(): number {
    return this.selected().length;
  }

  private selected(): Float32Array[] {
    if (!this.energies.length) return [];
    const sorted = [...this.energies].sort((a, b) => a - b);
    const p90 = sorted[Math.floor(sorted.length * 0.9)];
    const floor = Math.max(p90 / 100, 1e-9);
    return this.frames.filter((_, i) => this.energies[i] >= floor);
  }

  /** Average power per band over the speech frames. */
  result(): number[] {
    const sel = this.selected();
    const out = new Array<number>(MATCH_BANDS.length).fill(0);
    for (const f of sel) for (let b = 0; b < out.length; b++) out[b] += f[b];
    return out.map((v) => (sel.length ? v / sel.length : 0));
  }
}

/**
 * The EQ curve (dB per band) that makes `source` sound like `reference`, without changing its
 * loudness: band ratios, centred on the speech range, limited to ±MATCH_MAX_DB. Bands where either
 * side has (almost) nothing, such as above a phone's bandwidth, are left flat.
 */
export function matchGains(reference: number[], source: number[]): number[] {
  const maxR = Math.max(...reference);
  const maxS = Math.max(...source);
  const raw = MATCH_BANDS.map((_, b) => {
    const r = reference[b];
    const s = source[b];
    if (!(r > maxR * 1e-6) || !(s > maxS * 1e-6)) return null;
    return 10 * Math.log10(r / s);
  });
  // level: centre the curve on the speech range (200 Hz–4 kHz), weighted by the source's energy
  let num = 0;
  let den = 0;
  MATCH_BANDS.forEach((f, b) => {
    const g = raw[b];
    if (g === null || f < 200 || f > 4000) return;
    num += g * source[b];
    den += source[b];
  });
  const centre = den > 0 ? num / den : 0;
  return raw.map((g) => (g === null ? 0 : Math.max(-MATCH_MAX_DB, Math.min(MATCH_MAX_DB, g - centre))));
}

/** The curve smoothed for a level of detail (0 broad, 1 medium, 2 fine) and scaled by amount (0..1). */
export function shapeCurve(gains: number[], detail: number, amount: number): number[] {
  const kernels = [[1, 2, 3, 2, 1], [1, 2, 1], [1]];
  const k = kernels[Math.max(0, Math.min(2, Math.round(detail)))];
  const h = (k.length - 1) / 2;
  return gains.map((_, i) => {
    let s = 0;
    let w = 0;
    for (let j = -h; j <= h; j++) {
      const g = gains[i + j];
      if (g === undefined) continue;
      s += g * k[j + h];
      w += k[j + h];
    }
    // the very low and very high ends are measured least reliably: go easy there
    const f = MATCH_BANDS[i];
    const edge = f < 60 || f > 12000 ? 0.5 : 1;
    return (s / w) * amount * edge;
  });
}

const Q = 4.318; // one third of an octave

/** Response in dB of one bell filter (RBJ peaking) at frequency f. */
function bellDb(fc: number, gainDb: number, f: number, sr: number): number {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * fc) / sr;
  const alpha = Math.sin(w0) / (2 * Q);
  const cos = Math.cos(w0);
  const b = [1 + alpha * A, -2 * cos, 1 - alpha * A];
  const a = [1 + alpha / A, -2 * cos, 1 - alpha / A];
  const w = (2 * Math.PI * f) / sr;
  const mag = (c: number[]) => {
    const re = c[0] + c[1] * Math.cos(w) + c[2] * Math.cos(2 * w);
    const im = -(c[1] * Math.sin(w) + c[2] * Math.sin(2 * w));
    return re * re + im * im;
  };
  return 10 * Math.log10(mag(b) / mag(a));
}

/**
 * Bell gains so that the bank of overlapping bells hits the wanted curve at every band centre
 * (overlapping bells add up, so the gains are corrected a few times).
 */
export function fitBells(target: number[], sr: number): number[] {
  const n = MATCH_BANDS.findIndex((f) => f > sr * 0.45);
  const used = n < 0 ? MATCH_BANDS.length : n;
  const g = target.slice(0, used);
  for (let it = 0; it < 30; it++) {
    for (let j = 0; j < used; j++) {
      let resp = 0;
      for (let i = 0; i < used; i++) resp += bellDb(MATCH_BANDS[i], g[i], MATCH_BANDS[j], sr);
      g[j] += 0.6 * (target[j] - resp);
      g[j] = Math.max(-2 * MATCH_MAX_DB, Math.min(2 * MATCH_MAX_DB, g[j]));
    }
  }
  return g;
}

export class MatchEq implements FxProcessor {
  readonly latency = 0;
  private bells: Biquad[] = [];
  private key = '';

  constructor(
    private sr: number,
    private curve?: MatchCurve,
  ) {}

  setParams(p: Record<string, number>): void {
    const key = `${p.amount}|${p.detail}`;
    if (key === this.key) return;
    this.key = key;
    if (!this.curve) {
      this.bells = [];
      return;
    }
    const shaped = shapeCurve(this.curve.gains, p.detail ?? 1, Math.max(0, (p.amount ?? 100) / 100));
    const gains = fitBells(shaped, this.sr);
    const next: Biquad[] = [];
    gains.forEach((g, i) => {
      if (Math.abs(g) >= 0.05) next.push(new Biquad('peaking', MATCH_BANDS[i], this.sr, Q, g));
    });
    this.bells = next;
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    for (const b of this.bells) {
      b.process(L, n, 0);
      b.process(R, n, 1);
    }
  }

  reset(): void {
    for (const b of this.bells) b.reset();
  }
}
