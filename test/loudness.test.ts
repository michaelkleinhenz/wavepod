import { describe, expect, it } from 'vitest';
import { LoudnessMeter, normalizationGain } from '../src/core/loudness';
import { sine } from './helpers';

describe('loudness (EBU R128)', () => {
  it('reads a stereo 1 kHz sine at -23 dBFS as -23 LUFS', () => {
    const amp = Math.pow(10, -23 / 20);
    const s = sine(1000, 5, 48000, amp);
    const m = new LoudnessMeter(48000, 2);
    m.push([s, s]);
    expect(m.integrated()).toBeCloseTo(-23, 0);
    expect(m.peakDb()).toBeCloseTo(-23, 1);
  });

  it('works at 44.1 kHz', () => {
    const amp = Math.pow(10, -20 / 20);
    const s = sine(1000, 5, 44100, amp);
    const m = new LoudnessMeter(44100, 2);
    for (let i = 0; i < s.length; i += 1000) {
      const chunk = s.subarray(i, i + 1000);
      m.push([chunk, chunk], chunk.length);
    }
    expect(m.integrated()).toBeCloseTo(-20, 0);
  });

  it('gates silence', () => {
    const m = new LoudnessMeter(48000, 2);
    const z = new Float32Array(48000 * 2);
    m.push([z, z]);
    expect(m.integrated()).toBe(-Infinity);
  });

  it('limits normalisation gain by the peak ceiling', () => {
    expect(normalizationGain(-23, -10, -16, -1)).toBeCloseTo(7);
    expect(normalizationGain(-23, -3, -16, -1)).toBeCloseTo(2);
    expect(normalizationGain(-Infinity, -Infinity, -16, -1)).toBe(0);
  });
});
