import { describe, expect, it } from 'vitest';
import { LoudnessMeter } from '../src/core/loudness';
import { TruePeakLimiter } from '../src/core/truePeakLimiter';
import { sine } from './helpers';

function run(lim: TruePeakLimiter, l: Float32Array, r: Float32Array): [Float32Array, Float32Array] {
  const n = l.length;
  const oL = new Float32Array(n + lim.latency);
  const oR = new Float32Array(n + lim.latency);
  const B = 1000;
  const tl = new Float32Array(B);
  const tr = new Float32Array(B);
  for (let p = 0; p < n; p += B) {
    const k = Math.min(B, n - p);
    lim.process(l.subarray(p, p + k), r.subarray(p, p + k), k, tl, tr);
    oL.set(tl.subarray(0, k), p);
    oR.set(tr.subarray(0, k), p);
  }
  lim.flush(oL.subarray(n), oR.subarray(n));
  return [oL.subarray(lim.latency), oR.subarray(lim.latency)];
}

describe('TruePeakLimiter', () => {
  it('passes audio under the ceiling unchanged, only delayed', () => {
    const sr = 48000;
    const x = sine(440, 1, sr, 0.3);
    const lim = new TruePeakLimiter(sr, 0.5);
    const [l] = run(lim, x, x);
    for (let i = 0; i < x.length; i += 97) expect(l[i]).toBeCloseTo(x[i], 6);
    expect(lim.maxReductionDb).toBe(0);
  });

  it('holds true peaks, including those between samples, at the ceiling', () => {
    const sr = 48000;
    // a tone near a quarter of the sample rate peaks between the samples
    const x = sine(11990, 1, sr, 0.9);
    const y = sine(300, 1, sr, 1.4);
    const ceiling = Math.pow(10, -1 / 20);
    const lim = new TruePeakLimiter(sr, ceiling);
    const [l, r] = run(lim, x, y);
    const m = new LoudnessMeter(sr, 2);
    m.push([l, r]);
    expect(m.truePeakDb()).toBeLessThanOrEqual(-1 + 0.05);
    expect(lim.maxReductionDb).toBeLessThan(-3);
  });
});
