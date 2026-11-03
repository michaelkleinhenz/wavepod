// Small DSP helpers: (de)interleaving, peak metering, fades. Waveform peaks live in peaks.ts.

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

import type { FadeShape } from '../shared/types';
export type { FadeShape };

export const FADE_SHAPES: Array<{ id: FadeShape; label: string }> = [
  { id: 'linear', label: 'Linear' },
  { id: 'equalPower', label: 'Equal power' },
  { id: 'sCurve', label: 'S-curve' },
];

/** Gain of a fade-in at progress t (0..1); a fade-out uses 1 - t. */
export function fadeCurve(t: number, shape: FadeShape = 'linear'): number {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  if (shape === 'equalPower') return Math.sin((x * Math.PI) / 2);
  if (shape === 'sCurve') return (1 - Math.cos(x * Math.PI)) / 2;
  return x;
}

/** Gain of a clip's fade envelope at clip-relative position `pos`. */
export function fadeGain(
  pos: number,
  length: number,
  fadeIn: number,
  fadeOut: number,
  inShape: FadeShape = 'linear',
  outShape: FadeShape = 'linear',
): number {
  let g = 1;
  if (fadeIn > 0 && pos < fadeIn) g *= fadeCurve(pos / fadeIn, inShape);
  if (fadeOut > 0 && pos > length - fadeOut) g *= fadeCurve((length - pos) / fadeOut, outShape);
  return g;
}

/** Equal-power pan law. Returns [left, right] gains for pan -1..1. */
export function panGains(pan: number): [number, number] {
  const p = Math.max(-1, Math.min(1, pan));
  const angle = ((p + 1) * Math.PI) / 4;
  return [Math.cos(angle) * Math.SQRT2, Math.sin(angle) * Math.SQRT2];
}
