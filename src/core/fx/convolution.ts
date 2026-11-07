// Convolution reverb: puts a sound into a real room by convolving it with an impulse response (IR),
// a recording of how that room answers a single click. Uniformly partitioned overlap-save FFT
// convolution, so even a several-second IR runs in real time; it adds one partition of latency,
// which the mixer compensates.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FxProcessor } from './processors';
import type { ImpulseRef } from '../../shared/types';
import { fft } from '../fft';
import { Biquad } from './biquad';
import { readWavFile } from '../wav';
import { Resampler } from '../opus';

/** Partition size in frames: the filter's latency. */
export const CONVOLUTION_BLOCK = 1024;
/** Longest impulse response used, in seconds (longer files are cut). */
export const MAX_IR_SECONDS = 12;

let impulseDir = '';

/** The folder impulse responses are referenced from (Documents/WavePod/Impulse responses). */
export function setImpulseDir(dir: string): void {
  impulseDir = dir;
}

export function impulseDirectory(): string {
  return impulseDir;
}

/** Absolute path of an IR reference: a file name in the IR folder, or an absolute path. */
export function impulsePath(ref: Pick<ImpulseRef, 'file'>): string {
  return path.isAbsolute(ref.file) ? ref.file : path.join(impulseDir, ref.file);
}

interface LoadedIr {
  key: string;
  /** One or two channels at the episode rate, normalised to unit energy per channel. */
  channels: Float32Array[];
}

const cache = new Map<string, LoadedIr>();

/**
 * Reads an IR at `sampleRate` (cached by path, modification time and rate). Mono or stereo; more
 * channels are cut to two. Each channel is scaled to unit energy, so 0 dB wet sounds about as loud
 * as the dry signal whatever level the file was recorded at. Null if the file is missing or unreadable.
 */
export function loadImpulse(file: string, sampleRate: number): Float32Array[] | null {
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const key = `${file}|${mtime}|${sampleRate}`;
  const hit = cache.get(file);
  if (hit?.key === key) return hit.channels;
  try {
    const { info, channels: raw } = readWavFile(file);
    let channels = raw.slice(0, 2);
    if (info.sampleRate !== sampleRate) {
      const rs = new Resampler(info.sampleRate, sampleRate, channels.length);
      const expected = Math.round((channels[0].length * sampleRate) / info.sampleRate);
      const a = rs.process(channels, channels[0].length);
      const b = rs.process(channels.map(() => new Float32Array(32)), 32);
      channels = a.map((c, i) => {
        const out = new Float32Array(expected);
        out.set(c.subarray(0, Math.min(c.length, expected)));
        if (c.length < expected) out.set(b[i].subarray(0, expected - c.length), c.length);
        return out;
      });
    }
    const max = Math.round(MAX_IR_SECONDS * sampleRate);
    channels = channels.map((c) => c.slice(0, Math.min(c.length, max)));
    let energy = 0;
    for (const c of channels) for (let i = 0; i < c.length; i++) energy += c[i] * c[i];
    energy /= channels.length;
    if (!(energy > 1e-12)) return null;
    const g = 1 / Math.sqrt(energy);
    for (const c of channels) for (let i = 0; i < c.length; i++) c[i] *= g;
    cache.set(file, { key, channels });
    return channels;
  } catch {
    return null;
  }
}

/** Length in seconds and channel count of an IR file, for lists. Null if it is not a usable WAV. */
export function describeImpulse(file: string): { seconds: number; channels: number; sampleRate: number } | null {
  try {
    const { info, channels } = readWavFile(file);
    return { seconds: channels[0].length / info.sampleRate, channels: info.channels, sampleRate: info.sampleRate };
  } catch {
    return null;
  }
}

export class Convolution implements FxProcessor {
  readonly latency = CONVOLUTION_BLOCK;
  private readonly B = CONVOLUTION_BLOCK;
  private readonly N = CONVOLUTION_BLOCK * 2;
  /** The IR at the episode rate (null: missing, the filter passes the dry signal only). */
  private ir: Float32Array[] | null;
  /** IR partition spectra, bins 0..B, per channel. */
  private hRe: Float64Array[][] = [[], []];
  private hIm: Float64Array[][] = [[], []];
  /** Frequency-domain delay line of input spectra (bins 0..B), per channel, as a ring. */
  private xRe: Float64Array[][] = [[], []];
  private xIm: Float64Array[][] = [[], []];
  private ring = 0;
  private parts = 0;
  /** Time-domain input: previous and current partition, per channel. */
  private inL: Float32Array;
  private inR: Float32Array;
  private prevL: Float32Array;
  private prevR: Float32Array;
  private outL: Float32Array;
  private outR: Float32Array;
  private pos = 0;
  private re: Float64Array;
  private im: Float64Array;
  private aR = new Float64Array(CONVOLUTION_BLOCK + 1);
  private aI = new Float64Array(CONVOLUTION_BLOCK + 1);
  private bR = new Float64Array(CONVOLUTION_BLOCK + 1);
  private bI = new Float64Array(CONVOLUTION_BLOCK + 1);
  private dry = 1;
  private wet = 0.25;
  private width = 1;
  private lowCut: Biquad[] = [];
  private highCut: Biquad[] = [];
  private irKey = '';

  constructor(private sr: number, ref?: ImpulseRef) {
    this.ir = ref?.file ? loadImpulse(impulsePath(ref), sr) : null;
    const B = this.B;
    this.inL = new Float32Array(B);
    this.inR = new Float32Array(B);
    this.prevL = new Float32Array(B);
    this.prevR = new Float32Array(B);
    this.outL = new Float32Array(B);
    this.outR = new Float32Array(B);
    this.re = new Float64Array(this.N);
    this.im = new Float64Array(this.N);
  }

  /** True when the filter has an impulse response to work with. */
  get loaded(): boolean {
    return !!this.ir;
  }

  setParams(p: Record<string, number>): void {
    const dbToLin = (db: number) => (db <= -60 ? 0 : Math.pow(10, db / 20));
    this.dry = dbToLin(p.dry ?? 0);
    this.wet = dbToLin(p.wet ?? -12);
    this.width = (p.width ?? 100) / 100;
    const low = p.lowCut ?? 20;
    const high = p.highCut ?? 20000;
    if (low > 20) {
      if (this.lowCut.length) for (const f of this.lowCut) f.set('highpass', low, this.sr, Math.SQRT1_2);
      else this.lowCut = [new Biquad('highpass', low, this.sr, Math.SQRT1_2)];
    } else this.lowCut = [];
    if (high < 20000 && high < this.sr / 2 - 100) {
      if (this.highCut.length) for (const f of this.highCut) f.set('lowpass', high, this.sr, Math.SQRT1_2);
      else this.highCut = [new Biquad('lowpass', high, this.sr, Math.SQRT1_2)];
    } else this.highCut = [];
    const key = `${p.predelay ?? 0}|${p.length ?? 100}`;
    if (key !== this.irKey) {
      this.irKey = key;
      this.buildPartitions(p.predelay ?? 0, p.length ?? 100);
    }
  }

  /** Splits the IR (shifted by the pre-delay, cut to `lengthPct` with a short fade) into partition spectra. */
  private buildPartitions(predelayMs: number, lengthPct: number): void {
    const { B, N } = this;
    if (!this.ir) {
      this.parts = 0;
      return;
    }
    const pre = Math.max(0, Math.round((predelayMs / 1000) * this.sr));
    const full = this.ir[0].length;
    const keep = Math.max(1, Math.round((full * Math.min(100, Math.max(1, lengthPct))) / 100));
    const fade = Math.min(keep, Math.round(0.05 * this.sr), Math.max(1, Math.round(keep * 0.2)));
    const total = pre + keep;
    const parts = Math.max(1, Math.ceil(total / B));
    const chans = [this.ir[0], this.ir[1] ?? this.ir[0]];
    for (let c = 0; c < 2; c++) {
      const src = chans[c];
      this.hRe[c] = [];
      this.hIm[c] = [];
      for (let k = 0; k < parts; k++) {
        const re = new Float64Array(N);
        const im = new Float64Array(N);
        for (let i = 0; i < B; i++) {
          const t = k * B + i - pre;
          if (t < 0 || t >= keep) continue;
          const g = lengthPct < 100 && t >= keep - fade ? (keep - t) / fade : 1;
          re[i] = src[t] * g;
        }
        fft(re, im);
        this.hRe[c].push(re.slice(0, B + 1));
        this.hIm[c].push(im.slice(0, B + 1));
      }
    }
    if (parts !== this.parts) {
      this.parts = parts;
      for (let c = 0; c < 2; c++) {
        this.xRe[c] = Array.from({ length: parts }, () => new Float64Array(B + 1));
        this.xIm[c] = Array.from({ length: parts }, () => new Float64Array(B + 1));
      }
      this.ring = 0;
    }
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    const { B } = this;
    const { inL, inR, prevL, prevR, outL, outR } = this;
    const wet = this.parts ? this.wet : 0;
    const w1 = wet * (0.5 + this.width / 2);
    const w2 = wet * (0.5 - this.width / 2);
    for (let i = 0; i < n; i++) {
      const p = this.pos;
      inL[p] = L[i];
      inR[p] = R[i];
      // the dry signal is delayed by one partition too, to line up with the wet one
      const dl = prevL[p];
      const dr = prevR[p];
      const wl = outL[p];
      const wr = outR[p];
      L[i] = dl * this.dry + wl * w1 + wr * w2;
      R[i] = dr * this.dry + wr * w1 + wl * w2;
      if (++this.pos === B) {
        this.pos = 0;
        this.block();
      }
    }
  }

  /** One partition: FFT of [previous, current] input, multiply-accumulate over the IR, keep the last half. */
  private block(): void {
    const { B, N, re, im, inL, inR, prevL, prevR } = this;
    if (this.parts) {
      // both channels in one complex FFT: left in the real part, right in the imaginary part
      for (let i = 0; i < B; i++) {
        re[i] = prevL[i];
        im[i] = prevR[i];
        re[B + i] = inL[i];
        im[B + i] = inR[i];
      }
      fft(re, im);
      const slot = this.ring;
      const xLr = this.xRe[0][slot];
      const xLi = this.xIm[0][slot];
      const xRr = this.xRe[1][slot];
      const xRi = this.xIm[1][slot];
      for (let k = 0; k <= B; k++) {
        const j = (N - k) % N;
        // split the packed spectrum: XL = (X[k] + conj X[N-k]) / 2, XR = (X[k] - conj X[N-k]) / 2i
        xLr[k] = (re[k] + re[j]) / 2;
        xLi[k] = (im[k] - im[j]) / 2;
        xRr[k] = (im[k] + im[j]) / 2;
        xRi[k] = (re[j] - re[k]) / 2;
      }
      re.fill(0);
      im.fill(0);
      // accumulate A = XL·HL and Bc = XR·HR over all partitions
      const { aR, aI, bR, bI } = this;
      aR.fill(0);
      aI.fill(0);
      bR.fill(0);
      bI.fill(0);
      for (let p = 0; p < this.parts; p++) {
        const s = (slot - p + this.parts) % this.parts;
        const hLr = this.hRe[0][p];
        const hLi = this.hIm[0][p];
        const hRr = this.hRe[1][p];
        const hRi = this.hIm[1][p];
        const lr = this.xRe[0][s];
        const li = this.xIm[0][s];
        const rr = this.xRe[1][s];
        const ri = this.xIm[1][s];
        for (let k = 0; k <= B; k++) {
          aR[k] += lr[k] * hLr[k] - li[k] * hLi[k];
          aI[k] += lr[k] * hLi[k] + li[k] * hLr[k];
          bR[k] += rr[k] * hRr[k] - ri[k] * hRi[k];
          bI[k] += rr[k] * hRi[k] + ri[k] * hRr[k];
        }
      }
      // Y = A + i·Bc for the left half; the right half from Hermitian symmetry of A and Bc
      for (let k = 0; k <= B; k++) {
        re[k] = aR[k] - bI[k];
        im[k] = aI[k] + bR[k];
        if (k > 0 && k < B) {
          re[N - k] = aR[k] + bI[k];
          im[N - k] = -aI[k] + bR[k];
        }
      }
      fft(re, im, true);
      for (let i = 0; i < B; i++) {
        this.outL[i] = re[B + i];
        this.outR[i] = im[B + i];
      }
      for (const f of this.lowCut) {
        f.process(this.outL, B, 0);
        f.process(this.outR, B, 1);
      }
      for (const f of this.highCut) {
        f.process(this.outL, B, 0);
        f.process(this.outR, B, 1);
      }
      this.ring = (slot + 1) % this.parts;
    } else {
      this.outL.fill(0);
      this.outR.fill(0);
    }
    prevL.set(inL);
    prevR.set(inR);
  }

  reset(): void {
    this.inL.fill(0);
    this.inR.fill(0);
    this.prevL.fill(0);
    this.prevR.fill(0);
    this.outL.fill(0);
    this.outR.fill(0);
    for (let c = 0; c < 2; c++) {
      for (const a of this.xRe[c]) a.fill(0);
      for (const a of this.xIm[c]) a.fill(0);
    }
    this.pos = 0;
    this.ring = 0;
    for (const f of [...this.lowCut, ...this.highCut]) f.reset();
  }
}
