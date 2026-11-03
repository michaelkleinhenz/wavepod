import { describe, expect, it } from 'vitest';
import { createFx } from '../src/core/fx/definitions';
import { createProcessor } from '../src/core/fx/processors';
import type { FxType } from '../src/shared/types';

const SR = 48000;
const rms = (a: Float32Array, from = 0, to = a.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / (to - from));
};
const db = (v: number) => 20 * Math.log10(v);

function run(type: FxType, params: Record<string, number>, L: Float32Array, R = Float32Array.from(L)): [Float32Array, Float32Array] {
  const p = createProcessor(type, SR);
  p.setParams({ ...createFx(type).params, ...params });
  for (let i = 0; i < L.length; i += 480) {
    const n = Math.min(480, L.length - i);
    p.process(L.subarray(i, i + n), R.subarray(i, i + n), n);
  }
  return [L, R];
}

/** Deterministic white noise. */
function noise(n: number, amp: number, seed = 1): Float32Array {
  let s = seed;
  return Float32Array.from({ length: n }, () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return ((s / 0x7fffffff) * 2 - 1) * amp;
  });
}

describe('Noise reduction', () => {
  it('turns steady noise down by about the reduction and keeps a tone above it', () => {
    const n = SR * 6;
    const hiss = noise(n, 0.01);
    const x = Float32Array.from(hiss);
    // a 1 kHz "voice" from 3 s to 5 s
    for (let i = 3 * SR; i < 5 * SR; i++) x[i] += 0.2 * Math.sin((2 * Math.PI * 1000 * i) / SR);
    const [y] = run('denoise', { reduction: 12, threshold: 6 }, Float32Array.from(x));
    const lat = 1024;
    // noise only, after the estimate has settled
    const before = rms(x, SR * 1.5, SR * 2.5);
    const after = rms(y, SR * 1.5 + lat, SR * 2.5 + lat);
    expect(db(after / before)).toBeLessThan(-8);
    expect(db(after / before)).toBeGreaterThan(-14);
    // the tone passes nearly unchanged (delayed by the latency)
    const tIn = rms(x, SR * 3.5, SR * 4.5);
    const tOut = rms(y, SR * 3.5 + lat, SR * 4.5 + lat);
    expect(Math.abs(db(tOut / tIn))).toBeLessThan(1);
  });

  it('is transparent with no reduction, apart from the delay', () => {
    const x = noise(SR, 0.2, 7);
    const [y] = run('denoise', { reduction: 0 }, Float32Array.from(x));
    let err = 0;
    for (let i = 1024; i < SR; i++) err = Math.max(err, Math.abs(y[i] - x[i - 1024]));
    expect(err).toBeLessThan(1e-4);
  });
});

describe('Reverb', () => {
  it('leaves a tail after an impulse and keeps the dry signal', () => {
    const L = new Float32Array(SR * 2);
    L[0] = 1;
    const [y] = run('reverb', { mix: 30, size: 60 }, L);
    expect(y[0]).toBeGreaterThan(0.5);
    const tail = rms(y, SR * 0.1, SR * 0.6);
    expect(tail).toBeGreaterThan(1e-4);
    // and decays
    expect(rms(y, SR * 1.5, SR * 2)).toBeLessThan(tail);
    expect(Math.max(...y.map(Math.abs))).toBeLessThan(1.5);
  });

  it('is dry at 0 % mix', () => {
    const x = noise(SR / 2, 0.3);
    const [y] = run('reverb', { mix: 0 }, Float32Array.from(x));
    for (let i = 0; i < x.length; i += 997) expect(y[i]).toBeCloseTo(x[i], 6);
  });
});

describe('filter cost', () => {
  it('noise reduction runs far faster than real time', () => {
    const x = noise(SR * 20, 0.1);
    const t = performance.now();
    run('denoise', {}, Float32Array.from(x));
    const secs = (performance.now() - t) / 1000;
    expect(secs).toBeLessThan(4); // 20 s of stereo audio
  });
});
