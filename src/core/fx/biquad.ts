// RBJ "Audio EQ Cookbook" biquads, transposed direct form II, one state per channel.

export type BiquadKind = 'highpass' | 'lowpass' | 'peaking' | 'lowshelf' | 'highshelf';

export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1 = [0, 0];
  private z2 = [0, 0];

  constructor(kind: BiquadKind, freq: number, sampleRate: number, q = Math.SQRT1_2, gainDb = 0) {
    this.set(kind, freq, sampleRate, q, gainDb);
  }

  set(kind: BiquadKind, freq: number, sampleRate: number, q = Math.SQRT1_2, gainDb = 0): void {
    const f = Math.min(Math.max(freq, 10), sampleRate * 0.49);
    const w0 = (2 * Math.PI * f) / sampleRate;
    const cos = Math.cos(w0);
    const sin = Math.sin(w0);
    const alpha = sin / (2 * Math.max(q, 0.05));
    const A = Math.pow(10, gainDb / 40);
    let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
    switch (kind) {
      case 'highpass':
        b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2;
        a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
        break;
      case 'lowpass':
        b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2;
        a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
        break;
      case 'peaking':
        b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A;
        a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A;
        break;
      case 'lowshelf': {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * (A + 1 - (A - 1) * cos + s); b1 = 2 * A * (A - 1 - (A + 1) * cos); b2 = A * (A + 1 - (A - 1) * cos - s);
        a0 = A + 1 + (A - 1) * cos + s; a1 = -2 * (A - 1 + (A + 1) * cos); a2 = A + 1 + (A - 1) * cos - s;
        break;
      }
      case 'highshelf': {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * (A + 1 + (A - 1) * cos + s); b1 = -2 * A * (A - 1 + (A + 1) * cos); b2 = A * (A + 1 + (A - 1) * cos - s);
        a0 = A + 1 - (A - 1) * cos + s; a1 = 2 * (A - 1 - (A + 1) * cos); a2 = A + 1 - (A - 1) * cos - s;
        break;
      }
    }
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
  }

  /** Filters one sample of channel `ch` (0 or 1). */
  tick(x: number, ch: number): number {
    const y = this.b0 * x + this.z1[ch];
    this.z1[ch] = this.b1 * x - this.a1 * y + this.z2[ch];
    this.z2[ch] = this.b2 * x - this.a2 * y;
    return y;
  }

  /** Filters `n` samples of channel `ch` in place. */
  process(buf: Float32Array, n: number, ch: number): void {
    const { b0, b1, b2, a1, a2 } = this;
    let z1 = this.z1[ch];
    let z2 = this.z2[ch];
    for (let i = 0; i < n; i++) {
      const x = buf[i];
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      buf[i] = y;
    }
    // flush denormals
    this.z1[ch] = Math.abs(z1) < 1e-25 ? 0 : z1;
    this.z2[ch] = Math.abs(z2) < 1e-25 ? 0 : z2;
  }

  reset(): void {
    this.z1 = [0, 0];
    this.z2 = [0, 0];
  }
}
