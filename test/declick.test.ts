import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFx } from '../src/core/fx/definitions';
import { factoryPresets } from '../src/core/fx/presets';
import { createProcessor } from '../src/core/fx/processors';
import { MouthDeclick } from '../src/core/fx/declick';
import { interpolateGap } from '../src/core/fx/lpc';
import { Resampler } from '../src/core/opus';
import { readWavFile } from '../src/core/wav';

const SR = 48000;

function speech(): Float32Array {
  const { info, channels } = readWavFile(path.join(__dirname, 'fixtures/jfk-speech.wav'));
  return new Resampler(info.sampleRate, SR, 1).process([channels[0]], channels[0].length)[0];
}

function lcg(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) >>> 0;
    return (s / 2 ** 32) * 2 - 1;
  };
}

function run(x: Float32Array, params: Record<string, number> = {}): { y: Float32Array; p: MouthDeclick } {
  const p = new MouthDeclick(SR);
  p.setParams({ ...createFx('declick').params, ...params });
  const L = Float32Array.from(x);
  const R = Float32Array.from(x);
  for (let i = 0; i < L.length; i += 480) {
    const n = Math.min(480, L.length - i);
    p.process(L.subarray(i, i + n), R.subarray(i, i + n), n);
  }
  return { y: L, p };
}

/** Energy of the third difference (the highs, where a click is heard) of a minus b around the clicks. */
function clickEnergy(a: Float32Array, shift: number, b: Float32Array, at: number[]): number {
  const hp = (x: Float32Array, i: number) => x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3];
  let e = 0;
  for (const q of at) for (let j = -50; j < 100; j++) e += (hp(a, q + j + shift) - hp(b, q + j)) ** 2;
  return e;
}

describe('Linear prediction gap fill', () => {
  it('restores a gap in a steady signal almost exactly', () => {
    const x = Float32Array.from({ length: 2000 }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 220 * i) / SR) + 0.1 * Math.sin((2 * Math.PI * 1500 * i) / SR));
    const y = Float32Array.from(x);
    y.fill(0.5, 1000, 1060);
    interpolateGap(y, 990, 1070, 384);
    let err = 0;
    for (let i = 990; i < 1070; i++) err = Math.max(err, Math.abs(y[i] - x[i]));
    expect(err).toBeLessThan(1e-3);
  });
});

describe('Mouth de-click', () => {
  const rnd = lcg(7);
  const clean = speech();
  for (let i = 0; i < clean.length; i++) clean[i] += 0.002 * rnd();
  const clicky = Float32Array.from(clean);
  const at: number[] = [];
  for (let t = 0.3; t < 4.6; t += 0.37) {
    const q = Math.round(t * SR);
    at.push(q);
    const amp = 0.03 + (0.05 * ((at.length * 7) % 5)) / 5;
    const len = Math.round(0.0008 * SR);
    for (let j = 0; j < len; j++) clicky[q + j] += amp * rnd() * Math.exp(-j / (len / 3));
  }

  it('finds and removes short clicks in speech', () => {
    const { y, p } = run(clicky);
    expect(p.clicks).toBeGreaterThanOrEqual(at.length - 3);
    expect(p.clicks).toBeLessThanOrEqual(at.length);
    const before = clickEnergy(clicky, 0, clean, at);
    const after = clickEnergy(y, p.latency, clean, at);
    expect(10 * Math.log10(after / before)).toBeLessThan(-10);
  });

  it('leaves clean speech, sibilants and consonant bursts alone at the default sensitivity', () => {
    const x = Float32Array.from(clean);
    let prev = 0;
    for (let k = 0; k < 4; k++) {
      const s = Math.round((0.5 + k) * SR);
      const len = 0.15 * SR;
      for (let j = 0; j < len; j++) {
        const env = Math.min(1, j / (0.02 * SR), (len - j) / (0.02 * SR));
        const w = rnd();
        x[s + j] += 0.15 * env * (w - prev); // an "s"
        prev = w;
      }
      const t = s + Math.round(0.3 * SR);
      for (let j = 0; j < 0.015 * SR; j++) x[t + j] += 0.2 * rnd() * Math.min(1, j / (0.001 * SR)) * Math.exp(-j / (0.005 * SR)); // a "t"
    }
    const { y, p } = run(x);
    expect(p.clicks).toBe(0);
    for (let i = 0; i < x.length - p.latency; i++) expect(y[i + p.latency]).toBe(x[i]);
  });

  it('plays only what it removes in Clicks only mode', () => {
    const { y, p } = run(clicky, { output: 1 });
    expect(p.clicks).toBeGreaterThan(0);
    let inClicks = 0;
    let elsewhere = 0;
    for (let i = 0; i < clicky.length - p.latency; i++) {
      const near = at.some((q) => i >= q - 100 && i < q + 150);
      if (near) inClicks += y[i + p.latency] ** 2;
      else elsewhere += y[i + p.latency] ** 2;
    }
    expect(elsewhere).toBe(0);
    expect(inClicks).toBeGreaterThan(0);
  });

  it('is a filter with presets and a fixed latency', () => {
    const p = createProcessor('declick', SR);
    expect(p.latency).toBeGreaterThan(0);
    expect(p.latency / SR).toBeLessThan(0.04);
    const names = factoryPresets('declick').map((e) => e.preset.name);
    expect(names).toContain('Dry mouth');
    expect(names).toContain('Find the clicks');
  });
});
