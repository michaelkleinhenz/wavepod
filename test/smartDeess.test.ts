import { describe, expect, it } from 'vitest';
import { createFx } from '../src/core/fx/definitions';
import { factoryPresets } from '../src/core/fx/presets';
import { createProcessor } from '../src/core/fx/processors';
import { SmartDeesser } from '../src/core/fx/smartDeess';
import { Biquad } from '../src/core/fx/biquad';

const SR = 48000;

function lcg(seed: number) {
  let s = seed;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return (s / 2 ** 32) * 2 - 1;
  };
}

function run(x: Float32Array, params: Record<string, number> = {}): { y: Float32Array; p: SmartDeesser } {
  const p = new SmartDeesser(SR);
  p.setParams({ ...createFx('smartdeess').params, ...params });
  const L = Float32Array.from(x);
  const R = Float32Array.from(x);
  for (let i = 0; i < L.length; i += 480) {
    const n = Math.min(480, L.length - i);
    p.process(L.subarray(i, i + n), R.subarray(i, i + n), n);
  }
  return { y: L, p };
}

/** Energy (dB) of x in a band, from t0 to t1 seconds, shifted by `lat` frames. */
function bandDb(x: Float32Array, kind: 'highpass' | 'lowpass', f: number, t0: number, t1: number, lat = 0): number {
  const b = new Biquad(kind, f, SR);
  const c = new Biquad(kind, f, SR);
  let e = 0;
  const a = Math.round(t0 * SR) + lat;
  const z = Math.round(t1 * SR) + lat;
  for (let i = a - 2400; i < z; i++) {
    const v = c.tick(b.tick(x[i], 0), 0);
    if (i >= a) e += v * v;
  }
  return 10 * Math.log10(e / (z - a));
}

/** A voice-like vowel (harmonics of `f0`, falling 6 dB/oct) from t0 to t1. */
function vowel(x: Float32Array, t0: number, t1: number, f0: number, amp: number): void {
  for (let i = Math.round(t0 * SR); i < Math.round(t1 * SR); i++) {
    let v = 0;
    for (let h = 1; h * f0 < 4000; h++) v += Math.sin((2 * Math.PI * f0 * h * i) / SR) / h;
    x[i] += amp * v;
  }
}

function sibilant(x: Float32Array, t0: number, t1: number, amp: number, rnd: () => number): void {
  const hp = new Biquad('highpass', 5000, SR);
  for (let i = Math.round(t0 * SR); i < Math.round(t1 * SR); i++) x[i] += amp * hp.tick(rnd(), 0);
}

function pop(x: Float32Array, t0: number, amp: number): void {
  // a low thump: 40 ms of a falling 60 Hz half-wave burst
  for (let j = 0; j < 0.04 * SR; j++) x[Math.round(t0 * SR) + j] += amp * Math.sin((2 * Math.PI * 60 * j) / SR) * Math.exp(-j / (0.012 * SR));
}

describe('Smart de-esser & de-plosive', () => {
  const rnd = lcg(11);
  const x = new Float32Array(SR * 2);
  vowel(x, 0.1, 0.6, 120, 0.1); // male vowel, full of energy below 150 Hz
  sibilant(x, 0.6, 0.8, 0.25, rnd); // a loud "s"
  vowel(x, 0.8, 1.3, 220, 0.05); // quieter female vowel
  pop(x, 1.4, 0.7); // a "p" pop
  vowel(x, 1.45, 1.9, 120, 0.1);

  it('turns down the highs of an "s" and the lows of a pop, nothing else', () => {
    const { y, p } = run(x);
    const lat = p.latency;
    expect(bandDb(y, 'highpass', 5000, 0.62, 0.78, lat) - bandDb(x, 'highpass', 5000, 0.62, 0.78)).toBeLessThan(-5);
    expect(bandDb(y, 'lowpass', 150, 1.4, 1.43, lat) - bandDb(x, 'lowpass', 150, 1.4, 1.43)).toBeLessThan(-6);
    // vowels pass bit-exactly (male fundamental below the pop frequency included)
    for (let i = Math.round(0.15 * SR); i < Math.round(0.55 * SR); i++) expect(y[i + lat]).toBe(x[i]);
    // after an s or a pop the band comes back quickly (a natural release)
    expect(Math.abs(bandDb(y, 'highpass', 3000, 0.95, 1.25, lat) - bandDb(x, 'highpass', 3000, 0.95, 1.25))).toBeLessThan(0.5);
    expect(Math.abs(bandDb(y, 'lowpass', 150, 1.6, 1.85, lat) - bandDb(x, 'lowpass', 150, 1.6, 1.85))).toBeLessThan(0.5);
  });

  it('works the same at a much lower recording level', () => {
    const quiet = x.map((v) => v * 0.05);
    const { y, p } = run(quiet);
    expect(bandDb(y, 'highpass', 5000, 0.62, 0.78, p.latency) - bandDb(quiet, 'highpass', 5000, 0.62, 0.78)).toBeLessThan(-5);
  });

  it('respects the maximum amounts and can switch either part off', () => {
    const { y, p } = run(x, { deess: 3, deplosive: 0 });
    const d = bandDb(y, 'highpass', 5000, 0.62, 0.78, p.latency) - bandDb(x, 'highpass', 5000, 0.62, 0.78);
    expect(d).toBeGreaterThan(-3.5);
    expect(d).toBeLessThan(-1);
    expect(p.popFrames).toBe(0);
    const off = run(x, { deess: 0, deplosive: 0 });
    for (let i = 0; i < x.length - off.p.latency; i++) expect(off.y[i + off.p.latency]).toBe(x[i]);
  });

  it('plays what it removes in "What is removed" mode', () => {
    const { y, p } = run(x, { output: 1 });
    let e = 0;
    for (let i = Math.round(0.15 * SR); i < Math.round(0.55 * SR); i++) e += y[i + p.latency] ** 2;
    expect(e).toBe(0);
    expect(bandDb(y, 'highpass', 5000, 0.62, 0.78, p.latency)).toBeGreaterThan(-40);
  });

  it('is a filter with presets', () => {
    expect(createProcessor('smartdeess', SR).latency).toBe(144);
    expect(factoryPresets('smartdeess').map((e) => e.preset.name)).toContain('Female voice');
  });
});
