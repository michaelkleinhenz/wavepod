import { describe, expect, it } from 'vitest';
import { PeakBuilder, decodePeaks, deinterleave, encodePeaks, fadeGain, interleave, interleavedPeaks, panGains, toDb } from '../src/core/dsp';

describe('dsp', () => {
  it('deinterleaves and interleaves', () => {
    const inter = Float32Array.from([1, 2, 3, 4, 5, 6]);
    const planar = deinterleave(inter, 3);
    expect(Array.from(planar[0])).toEqual([1, 4]);
    expect(Array.from(planar[2])).toEqual([3, 6]);
    const out = interleave([planar[0], planar[1]], 2, 4, 1);
    expect(Array.from(out)).toEqual([0, 1, 2, 0, 0, 4, 5, 0]);
  });

  it('measures interleaved peaks per channel', () => {
    const p = interleavedPeaks(Float32Array.from([0.1, -0.9, -0.5, 0.2]), 2);
    expect(p[0]).toBeCloseTo(0.5);
    expect(p[1]).toBeCloseTo(0.9);
  });

  it('builds and serialises waveform peaks', () => {
    const pb = new PeakBuilder(4);
    pb.push([Float32Array.from([0, 0.5, -0.5, 0.25, 1, 1])]);
    const peaks = pb.finish();
    expect(peaks.length).toBe(6);
    expect(Array.from(peaks.data)).toEqual([-63, 64, 127, 127]);
    const back = decodePeaks(encodePeaks(peaks));
    expect(back.samplesPerPeak).toBe(4);
    expect(back.length).toBe(6);
    expect(Array.from(back.data)).toEqual(Array.from(peaks.data));
  });

  it('computes fades and pan', () => {
    expect(fadeGain(0, 100, 10, 10)).toBe(0);
    expect(fadeGain(5, 100, 10, 10)).toBeCloseTo(0.5);
    expect(fadeGain(50, 100, 10, 10)).toBe(1);
    expect(fadeGain(95, 100, 10, 10)).toBeCloseTo(0.5);
    const [l, r] = panGains(0);
    expect(l).toBeCloseTo(1);
    expect(r).toBeCloseTo(1);
    expect(panGains(-1)[1]).toBeCloseTo(0);
    expect(toDb(1)).toBe(0);
    expect(toDb(0)).toBe(-90);
  });
});
