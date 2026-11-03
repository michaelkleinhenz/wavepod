// EBU R128 / ITU-R BS.1770-4 integrated loudness meter (gated), plus sample peak.

interface Biquad {
  b0: number; b1: number; b2: number; a1: number; a2: number;
}

/** K-weighting filter coefficients for an arbitrary sample rate (BS.1770 derivation). */
export function kWeighting(sampleRate: number): [Biquad, Biquad] {
  // Stage 1: high-shelf
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / sampleRate);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf: Biquad = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  // Stage 2: high-pass (RLB)
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / sampleRate);
  a0 = 1 + K / Q + K * K;
  const hp: Biquad = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  return [shelf, hp];
}

class BiquadState {
  x1 = 0; x2 = 0; y1 = 0; y2 = 0;
  constructor(private c: Biquad) {}
  process(x: number): number {
    const { b0, b1, b2, a1, a2 } = this.c;
    const y = b0 * x + b1 * this.x1 + b2 * this.x2 - a1 * this.y1 - a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

/**
 * Streaming loudness meter. Push planar blocks; call `integrated()` at the end.
 * Per BS.1770 a mono signal is a single channel with weight 1.0, so it reads
 * 3 LU lower than the same signal on both channels of a stereo file.
 */
export class LoudnessMeter {
  private filters: Array<[BiquadState, BiquadState]>;
  private blockSize: number;
  private hop: number;
  private ring: Float64Array; // per-100ms sub-block energy (sum over channels)
  private subCount = 0;
  private subFill = 0;
  private subAcc = 0;
  private blockEnergies: number[] = [];
  private peak = 0;

  constructor(readonly sampleRate: number, readonly channels: number) {
    const [shelf, hp] = kWeighting(sampleRate);
    this.filters = Array.from({ length: channels }, () => [new BiquadState(shelf), new BiquadState(hp)]);
    this.hop = Math.round(sampleRate * 0.1);
    this.blockSize = this.hop * 4;
    this.ring = new Float64Array(4);
  }

  push(planar: Float32Array[], frames = planar[0]?.length ?? 0): void {
    const n = this.channels;
    for (let i = 0; i < frames; i++) {
      let e = 0;
      for (let c = 0; c < n; c++) {
        const x = planar[c][i];
        const ax = Math.abs(x);
        if (ax > this.peak) this.peak = ax;
        const [f1, f2] = this.filters[c];
        const y = f2.process(f1.process(x));
        e += y * y; // channel weights are 1.0 for L/R/C
      }
      this.subAcc += e;
      if (++this.subFill === this.hop) {
        this.ring[this.subCount % 4] = this.subAcc;
        this.subCount++;
        this.subAcc = 0;
        this.subFill = 0;
        if (this.subCount >= 4) {
          const total = this.ring[0] + this.ring[1] + this.ring[2] + this.ring[3];
          this.blockEnergies.push(total / this.blockSize);
        }
      }
    }
  }

  /** Integrated loudness in LUFS (−Infinity for silence / too short). */
  integrated(): number {
    const abs = this.blockEnergies.filter((z) => z > 0 && energyToLufs(z) > -70);
    if (abs.length === 0) return -Infinity;
    const relGate = energyToLufs(mean(abs)) - 10;
    const rel = abs.filter((z) => energyToLufs(z) > relGate);
    if (rel.length === 0) return -Infinity;
    return energyToLufs(mean(rel));
  }

  /** Sample peak in dBFS. */
  peakDb(): number {
    return this.peak > 0 ? 20 * Math.log10(this.peak) : -Infinity;
  }
}

function energyToLufs(z: number): number {
  return -0.691 + 10 * Math.log10(z);
}

function mean(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/**
 * Gain (dB) to reach `target` LUFS without the sample peak exceeding
 * `ceiling` dBFS.
 */
export function normalizationGain(measured: number, peakDb: number, target: number, ceiling: number): number {
  if (!Number.isFinite(measured)) return 0;
  let gain = target - measured;
  if (Number.isFinite(peakDb) && peakDb + gain > ceiling) gain = ceiling - peakDb;
  return gain;
}
