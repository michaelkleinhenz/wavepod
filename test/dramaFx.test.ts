import { describe, expect, it } from 'vitest';
import { createFx } from '../src/core/fx/definitions';
import { createProcessor } from '../src/core/fx/processors';
import { presetEdited } from '../src/core/fx/presets';
import { MASTER, fxList } from '../src/core/fx/stack';
import { VOICE_EFFECTS, addVoiceEffect, findVoiceEffect, voiceEffectFilters } from '../src/core/fx/voiceEffects';
import type { FxType, Project } from '../src/shared/types';

const SR = 48000;
const rms = (a: Float32Array, from = 0, to = a.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / (to - from));
};
const db = (v: number) => 20 * Math.log10(v);
const sine = (f: number, amp: number, n = SR) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / SR));

function run(type: FxType, params: Record<string, number>, L: Float32Array, R = Float32Array.from(L)): [Float32Array, Float32Array] {
  const p = createProcessor(type, SR);
  p.setParams({ ...createFx(type).params, ...params });
  for (let i = 0; i < L.length; i += 480) {
    const n = Math.min(480, L.length - i);
    p.process(L.subarray(i, i + n), R.subarray(i, i + n), n);
  }
  return [L, R];
}

/** Gain in dB of a sine through a filter, measured after it settled. */
function gainAt(type: FxType, params: Record<string, number>, f: number): number {
  const x = sine(f, 0.1);
  const [y] = run(type, params, Float32Array.from(x));
  return db(rms(y, SR / 2) / rms(x, SR / 2));
}

describe('Band-pass', () => {
  it('passes the telephone band and cuts below and above it', () => {
    const tel = { lowCut: 300, highCut: 3400, slope: 24, gain: 0 };
    expect(Math.abs(gainAt('bandpass', tel, 1000))).toBeLessThan(0.5);
    expect(gainAt('bandpass', tel, 80)).toBeLessThan(-40);
    expect(gainAt('bandpass', tel, 10000)).toBeLessThan(-30);
    // 12 dB/oct is gentler
    expect(gainAt('bandpass', { ...tel, slope: 12 }, 10000)).toBeGreaterThan(gainAt('bandpass', tel, 10000) + 10);
  });

  it('works as a pure low-pass with the low cut at its minimum, and applies the output gain', () => {
    const wall = { lowCut: 20, highCut: 700, slope: 24, gain: 6 };
    expect(gainAt('bandpass', wall, 60)).toBeCloseTo(6, 0);
    expect(gainAt('bandpass', wall, 4000)).toBeLessThan(-40);
  });
});

describe('Distortion', () => {
  /** Share of a 1 kHz sine's output that is not the 1 kHz sine (harmonics, noise). */
  function distortionShare(y: Float32Array, from: number): number {
    let c = 0;
    let s = 0;
    for (let i = from; i < y.length; i++) {
      const w = (2 * Math.PI * 1000 * i) / SR;
      c += y[i] * Math.cos(w);
      s += y[i] * Math.sin(w);
    }
    const n = y.length - from;
    const a = (2 / n) * c;
    const b = (2 / n) * s;
    let res = 0;
    for (let i = from; i < y.length; i++) {
      const w = (2 * Math.PI * 1000 * i) / SR;
      res += (y[i] - a * Math.cos(w) - b * Math.sin(w)) ** 2;
    }
    return Math.sqrt(res / n) / rms(y, from);
  }

  it.each([0, 1, 2])('character %i adds harmonics but keeps speech level about the same', (mode) => {
    const x = sine(1000, 0.15);
    const [y] = run('distortion', { drive: 24, mode, tone: 20000 }, Float32Array.from(x));
    expect(distortionShare(y, SR / 2)).toBeGreaterThan(0.1);
    expect(Math.abs(db(rms(y, SR / 2) / rms(x, SR / 2)))).toBeLessThan(6);
  });

  it('is clean at no drive, full bit depth and full rate', () => {
    const x = sine(1000, 0.15);
    const [y] = run('distortion', { drive: 0, mode: 1, tone: 20000 }, Float32Array.from(x));
    expect(distortionShare(y, SR / 2)).toBeLessThan(0.01);
  });

  it('crushes bits and sample rate', () => {
    const x = sine(1000, 0.15);
    const [y] = run('distortion', { drive: 0, bits: 4, rate: 6000, tone: 20000 }, Float32Array.from(x));
    expect(distortionShare(y, SR / 2)).toBeGreaterThan(0.1);
  });

  it('mix 0 leaves the signal alone', () => {
    const x = sine(440, 0.3);
    const [y] = run('distortion', { drive: 30, mode: 2, mix: 0 }, Float32Array.from(x));
    let err = 0;
    for (let i = 0; i < x.length; i++) err = Math.max(err, Math.abs(y[i] - x[i]));
    expect(err).toBeLessThan(1e-6);
  });
});

describe('Echo', () => {
  const impulse = (n = SR) => {
    const a = new Float32Array(n);
    a[100] = 1;
    return a;
  };
  const peakNear = (a: Float32Array, at: number) => Math.max(...Array.from(a.subarray(at - 2, at + 40)).map(Math.abs));

  it('repeats after the delay time, each repeat quieter', () => {
    const d = Math.round(0.2 * SR);
    const [L] = run('echo', { time: 200, feedback: 50, mix: 50, highCut: 20000, spread: 0 }, impulse());
    expect(L[100]).toBeCloseTo(1, 5);
    const first = peakNear(L, 100 + d);
    const second = peakNear(L, 100 + 2 * d);
    expect(first).toBeGreaterThan(0.5);
    expect(second).toBeGreaterThan(0.2);
    expect(second).toBeLessThan(first);
    // silence in between
    expect(Math.max(...Array.from(L.subarray(200, 100 + d - 10)).map(Math.abs))).toBeLessThan(1e-6);
  });

  it('ping-pong alternates the repeats between the sides', () => {
    const d = Math.round(0.1 * SR);
    const [L, R] = run('echo', { time: 100, feedback: 60, mix: 100, highCut: 20000, spread: 100 }, impulse(), impulse());
    expect(peakNear(L, 100 + d)).toBeGreaterThan(0.5);
    expect(peakNear(R, 100 + d)).toBeLessThan(1e-6);
    expect(peakNear(R, 100 + 2 * d)).toBeGreaterThan(0.3);
    expect(peakNear(L, 100 + 2 * d)).toBeLessThan(1e-6);
  });
});

describe('Voice effects', () => {
  const project = (): Project => ({ tracks: [{ id: 't1', name: 'Caller', fx: [] }], masterFx: [] }) as unknown as Project;

  it.each(VOICE_EFFECTS.map((e) => [e.name, e] as const))('%s builds from factory presets and sounds', (_name, effect) => {
    const filters = voiceEffectFilters(effect);
    expect(filters.map((f) => f.type)).toEqual(effect.chain.map(([t]) => t));
    for (const [i, fx] of filters.entries()) {
      expect(fx.preset?.name).toBe(effect.chain[i][1]);
      expect(presetEdited(fx)).toBe(false);
    }
    // a noisy "voice" through the whole chain stays finite and audible
    let s = 3;
    const L = Float32Array.from({ length: SR }, (_, i) => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return 0.2 * Math.sin((2 * Math.PI * 800 * i) / SR) + 0.05 * ((s / 0x7fffffff) * 2 - 1);
    });
    const R = Float32Array.from(L);
    const procs = filters.map((fx) => {
      const p = createProcessor(fx.type, SR, fx);
      p.setParams(fx.params);
      return p;
    });
    for (let i = 0; i < SR; i += 480) for (const p of procs) p.process(L.subarray(i, i + 480), R.subarray(i, i + 480), 480);
    expect(L.every(Number.isFinite)).toBe(true);
    const out = db(rms(L, SR / 2));
    expect(out).toBeGreaterThan(-40);
    expect(out).toBeLessThan(0);
  });

  it('appends an effect to a track and finds effects by id or name', () => {
    const effect = findVoiceEffect('Telephone')!;
    expect(findVoiceEffect('telephone')).toBe(effect);
    expect(findVoiceEffect('nope')).toBeNull();
    const { project: p } = addVoiceEffect(project(), 't1', effect);
    expect(fxList(p, 't1').map((f) => f.type)).toEqual(['bandpass', 'distortion', 'compressor']);
    expect(fxList(p, MASTER)).toEqual([]);
  });
});
