// Small DSP helpers: (de)interleaving, peak metering, waveform peaks, fades.
import type { WaveformPeaks } from '../shared/types';

/** Splits an interleaved Float32 buffer into planar channels. */
export function deinterleave(interleaved: Float32Array, channels: number, out?: Float32Array[]): Float32Array[] {
  const frames = Math.floor(interleaved.length / channels);
  const result =
    out && out.length === channels && out[0].length === frames
      ? out
      : Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0, o = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) result[c][i] = interleaved[o++];
  }
  return result;
}

/** Interleaves planar channels into `channels` total output channels starting at `firstChannel`. */
export function interleave(
  planar: Float32Array[],
  frames: number,
  totalChannels: number,
  firstChannel = 0,
  out?: Float32Array,
): Float32Array {
  const result = out && out.length === frames * totalChannels ? out : new Float32Array(frames * totalChannels);
  result.fill(0);
  for (let c = 0; c < planar.length; c++) {
    const dst = firstChannel + c;
    if (dst >= totalChannels) break;
    const src = planar[c];
    for (let i = 0; i < frames; i++) result[i * totalChannels + dst] = src[i];
  }
  return result;
}

/** Views a Node Buffer of float32 samples as a Float32Array (copying if unaligned). */
export function bufferToFloat32(buf: Buffer): Float32Array {
  if (buf.byteOffset % 4 === 0) return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const copy = new Float32Array(buf.byteLength / 4);
  Buffer.from(copy.buffer).set(buf);
  return copy;
}

export function float32ToBuffer(data: Float32Array): Buffer {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/** Absolute peak per channel of an interleaved buffer. */
export function interleavedPeaks(interleaved: Float32Array, channels: number, into?: number[]): number[] {
  const peaks = into ?? new Array<number>(channels).fill(0);
  for (let i = 0; i < interleaved.length; i++) {
    const c = i % channels;
    const v = Math.abs(interleaved[i]);
    if (v > peaks[c]) peaks[c] = v;
  }
  return peaks;
}

export function peakOf(data: Float32Array, frames = data.length): number {
  let p = 0;
  for (let i = 0; i < frames; i++) {
    const v = Math.abs(data[i]);
    if (v > p) p = v;
  }
  return p;
}

/** Linear 0..1+ to dBFS, clamped at `floor`. */
export function toDb(linear: number, floor = -90): number {
  if (linear <= 0) return floor;
  return Math.max(floor, 20 * Math.log10(linear));
}

/**
 * Accumulates min/max pairs for waveform display. Feed planar chunks; stereo
 * input is summed to mono.
 */
export class PeakBuilder {
  private data: number[] = [];
  private min = Infinity;
  private max = -Infinity;
  private count = 0;
  private total = 0;

  constructor(readonly samplesPerPeak = 256) {}

  push(channels: Float32Array[], frames = channels[0]?.length ?? 0): void {
    const n = channels.length;
    for (let i = 0; i < frames; i++) {
      let v = 0;
      for (let c = 0; c < n; c++) v += channels[c][i];
      if (n > 1) v /= n;
      if (v < this.min) this.min = v;
      if (v > this.max) this.max = v;
      if (++this.count === this.samplesPerPeak) this.emit();
    }
    this.total += frames;
  }

  /** Number of finished min/max buckets so far. */
  get bucketCount(): number {
    return this.data.length / 2;
  }

  /** Finished buckets from `fromBucket` on, as interleaved min,max values (-127..127). */
  bucketsFrom(fromBucket: number): number[] {
    return this.data.slice(fromBucket * 2);
  }

  private emit(): void {
    this.data.push(quantize(this.min), quantize(this.max));
    this.min = Infinity;
    this.max = -Infinity;
    this.count = 0;
  }

  finish(): WaveformPeaks {
    if (this.count > 0) this.emit();
    return { samplesPerPeak: this.samplesPerPeak, data: Int8Array.from(this.data), length: this.total };
  }
}

function quantize(v: number): number {
  return Math.max(-127, Math.min(127, Math.round(v * 127))) || 0; // no -0
}

/** Serialises peaks: 4 bytes samplesPerPeak, 8 bytes length (float64), then int8 data. */
export function encodePeaks(p: WaveformPeaks): Buffer {
  const head = Buffer.alloc(12);
  head.writeUInt32LE(p.samplesPerPeak, 0);
  head.writeDoubleLE(p.length, 4);
  return Buffer.concat([head, Buffer.from(p.data.buffer, p.data.byteOffset, p.data.byteLength)]);
}

export function decodePeaks(buf: Buffer): WaveformPeaks {
  const samplesPerPeak = buf.readUInt32LE(0);
  const length = buf.readDoubleLE(4);
  const data = new Int8Array(buf.length - 12);
  data.set(new Int8Array(buf.buffer, buf.byteOffset + 12, buf.length - 12));
  return { samplesPerPeak, length, data };
}

/** Gain of a clip's fade envelope at clip-relative position `pos`. */
export function fadeGain(pos: number, length: number, fadeIn: number, fadeOut: number): number {
  let g = 1;
  if (fadeIn > 0 && pos < fadeIn) g *= Math.max(0, pos / fadeIn);
  if (fadeOut > 0 && pos > length - fadeOut) g *= Math.max(0, (length - pos) / fadeOut);
  return g;
}

/** Equal-power pan law. Returns [left, right] gains for pan -1..1. */
export function panGains(pan: number): [number, number] {
  const p = Math.max(-1, Math.min(1, pan));
  const angle = ((p + 1) * Math.PI) / 4;
  return [Math.cos(angle) * Math.SQRT2, Math.sin(angle) * Math.SQRT2];
}
