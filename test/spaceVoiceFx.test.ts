import { describe, expect, it } from 'vitest';
import { createFx } from '../src/core/fx/definitions';
import { createProcessor } from '../src/core/fx/processors';
import { factoryPresets } from '../src/core/fx/presets';
import { distanceGainDb, distanceHighCut } from '../src/core/fx/space';
import { VOICE_EFFECTS } from '../src/core/fx/voiceEffects';
import type { FxType } from '../src/shared/types';

const SR = 48000;
const rms = (a: Float32Array, from = 0, to = a.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / (to - from));
};
const db = (v: number) => 20 * Math.log10(v);
const sine = (f: number, amp: number, n = SR) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / SR));

function run(type: FxType, params: Record<string, number>, L: Float32Array, R = Float32Array.from(L)) {
  const p = createProcessor(type, SR);
  p.setParams({ ...createFx(type).params, ...params });
  for (let i = 0; i < L.length; i += 480) {
    const n = Math.min(480, L.length - i);
    p.process(L.subarray(i, i + n), R.subarray(i, i + n), n);
  }
  return { L, R, latency: p.latency };
}

/** Frequency with the most energy (coarse DFT scan). */
function dominant(y: Float32Array, from: number, lo: number, hi: number, step = 5): number {
  let best = 0;
  let bestF = 0;
  for (let f = lo; f <= hi; f += step) {
    let c = 0;
    let s = 0;
    for (let i = from; i < y.length; i++) {
      const w = (2 * Math.PI * f * i) / SR;
      c += y[i] * Math.cos(w);
      s += y[i] * Math.sin(w);
    }
    const m = c * c + s * s;
    if (m > best) {
      best = m;
      bestF = f;
    }
  }
  return bestF;
}

describe('Room & distance', () => {
  const dry = { size: 40, damping: 50, early: 0, room: 0, predelay: 0 };

  it('leaves a voice at 1 m with no room alone', () => {
    const x = sine(1000, 0.2);
    const { L } = run('space', { ...dry, distance: 1 }, Float32Array.from(x));
    expect(Math.abs(db(rms(L, SR / 2) / rms(x, SR / 2)))).toBeLessThan(0.3);
  });

  it('distance turns the voice down and takes away highs', () => {
    expect(distanceGainDb(1)).toBe(0);
    expect(distanceGainDb(10)).toBeCloseTo(-15, 5);
    expect(distanceHighCut(1)).toBe(0);
    expect(distanceHighCut(20)).toBeLessThan(4000);
    const at = (d: number, f: number) => {
      const x = sine(f, 0.2);
      return db(rms(run('space', { ...dry, distance: d }, Float32Array.from(x)).L, SR / 2) / rms(x, SR / 2));
    };
    expect(at(10, 1000)).toBeLessThan(-12);
    // highs fall off more than mids far away
    expect(at(20, 8000)).toBeLessThan(at(20, 1000) - 10);
  });

  it('the room stays while the direct sound falls, so far voices are mostly room', () => {
    const imp = () => {
      const a = new Float32Array(SR);
      a[0] = 1;
      return a;
    };
    const room = { size: 60, damping: 40, early: 50, room: 40, predelay: 10 };
    const ratio = (d: number) => {
      const { L } = run('space', { ...room, distance: d }, imp(), imp());
      const direct = Math.abs(L[0]) + Math.abs(L[1]) + Math.abs(L[2]);
      return rms(L, 200, SR) / direct;
    };
    expect(ratio(15)).toBeGreaterThan(ratio(1) * 3);
  });

  it('every place preset sounds and stays finite', () => {
    for (const { preset } of factoryPresets('space')) {
      const x = sine(500, 0.2);
      const { L } = run('space', preset.params, x);
      expect(L.every(Number.isFinite), preset.name).toBe(true);
      expect(db(rms(L, SR / 2)), preset.name).toBeGreaterThan(-45);
      expect(db(rms(L, SR / 2)), preset.name).toBeLessThan(0);
    }
  });

  it('offers the places as one-click effects', () => {
    const places = VOICE_EFFECTS.filter((e) => e.group === 'place');
    expect(places.map((e) => e.name)).toEqual(expect.arrayContaining(['Small kitchen', 'Church', 'Forest', 'Car']));
    for (const p of places) expect(p.chain).toEqual([['space', p.name]]);
  });
});

describe('Pitch shift', () => {
  it.each([
    [12, 400, 800],
    [-12, 400, 200],
    [7, 300, 300 * Math.pow(2, 7 / 12)],
  ])('%i semitones moves %i Hz to about %f Hz, at the same level', (semitones, f, expected) => {
    const x = sine(f, 0.2, SR / 2);
    const { L, latency } = run('pitch', { semitones, window: 50 }, Float32Array.from(x));
    expect(latency).toBe(1200);
    expect(Math.abs(dominant(L, 4000, 100, 1000) - expected)).toBeLessThan(10);
    expect(Math.abs(db(rms(L, 4000) / rms(x, 4000)))).toBeLessThan(3);
  });

  it('at 0 semitones only delays the signal by its latency', () => {
    const x = sine(300, 0.2, SR / 2);
    const { L, latency } = run('pitch', { semitones: 0, window: 40 }, Float32Array.from(x));
    let err = 0;
    for (let i = 5000; i < x.length; i++) err = Math.max(err, Math.abs(L[i] - x[i - latency - 1]));
    expect(err).toBeLessThan(1e-5);
  });
});

describe('Ring modulator', () => {
  it('replaces a tone with the sum and difference frequencies', () => {
    const x = sine(500, 0.2, SR / 2);
    const { L } = run('ringmod', { freq: 100, shape: 0, mix: 100, wobble: 0 }, Float32Array.from(x));
    const f = dominant(L, 0, 300, 700);
    expect([400, 600]).toContain(f);
    // nothing left at 500 Hz
    let c = 0;
    let s = 0;
    for (let i = 0; i < L.length; i++) {
      const w = (2 * Math.PI * 500 * i) / SR;
      c += L[i] * Math.cos(w);
      s += L[i] * Math.sin(w);
    }
    expect(Math.hypot(c, s) / (L.length / 2)).toBeLessThan(0.005);
  });

  it('mix 0 leaves the voice alone', () => {
    const x = sine(500, 0.2, SR / 4);
    const { L } = run('ringmod', { freq: 40, mix: 0 }, Float32Array.from(x));
    for (let i = 0; i < x.length; i++) expect(Math.abs(L[i] - x[i])).toBeLessThan(1e-6);
  });
});

describe('Chorus / flanger', () => {
  it('keeps the level about the same and spreads a mono voice to stereo', () => {
    const x = sine(700, 0.2);
    const { L, R } = run('chorus', { delay: 15, depth: 50, rate: 1, voices: 2, mix: 50, width: 100 }, Float32Array.from(x), Float32Array.from(x));
    expect(Math.abs(db(rms(L, SR / 2) / rms(x, SR / 2)))).toBeLessThan(6);
    let diff = 0;
    for (let i = SR / 2; i < SR; i++) diff += (L[i] - R[i]) ** 2;
    expect(Math.sqrt(diff / (SR / 2))).toBeGreaterThan(0.01);
  });

  it('stays stable at maximum feedback', () => {
    const x = sine(300, 0.3);
    const { L } = run('chorus', { delay: 1, depth: 100, rate: 0.2, feedback: 95, voices: 1, mix: 50 }, x);
    expect(L.every(Number.isFinite)).toBe(true);
    expect(Math.max(...Array.from(L).map(Math.abs))).toBeLessThan(10);
  });

  it('vibrato (100 % wet) bends the pitch back and forth', () => {
    const x = sine(1000, 0.2);
    const { L } = run('chorus', { delay: 5, depth: 60, rate: 5, feedback: 0, voices: 1, mix: 100 }, Float32Array.from(x));
    // a pure 1 kHz tone would put all energy at 1 kHz; vibrato spreads it into side bands
    let c = 0;
    let s = 0;
    for (let i = 4800; i < L.length; i++) {
      const w = (2 * Math.PI * 1000 * i) / SR;
      c += L[i] * Math.cos(w);
      s += L[i] * Math.sin(w);
    }
    const at1k = Math.hypot(c, s) / ((L.length - 4800) / 2);
    expect(at1k).toBeLessThan(rms(L, 4800) * Math.SQRT2 * 0.8);
  });
});
