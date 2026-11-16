import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFx } from '../src/core/fx/definitions';
import { factoryPresets } from '../src/core/fx/presets';
import { createProcessor } from '../src/core/fx/processors';
import { DeClip, findClipped } from '../src/core/fx/declip';
import { Resampler } from '../src/core/opus';
import { readWavFile } from '../src/core/wav';

const SR = 48000;

function speech(): Float32Array {
  const { info, channels } = readWavFile(path.join(__dirname, 'fixtures/jfk-speech.wav'));
  return new Resampler(info.sampleRate, SR, 1).process([channels[0]], channels[0].length)[0];
}

function run(x: Float32Array, params: Record<string, number> = {}): { y: Float32Array; p: DeClip } {
  const p = new DeClip(SR);
  p.setParams({ ...createFx('declip').params, gain: 0, ...params });
  const L = Float32Array.from(x);
  const R = Float32Array.from(x);
  for (let i = 0; i < L.length; i += 480) {
    const n = Math.min(480, L.length - i);
    p.process(L.subarray(i, i + n), R.subarray(i, i + n), n);
  }
  return { y: L, p };
}

describe('De-clip', () => {
  const clean = speech();
  let peak = 0;
  for (const v of clean) peak = Math.max(peak, Math.abs(v));
  // 3.5 dB too loud: the top of the loudest words is cut off at 0.6
  const level = 0.6;
  const hot = clean.map((v) => (v / peak) * level * 1.5);
  const clipped = hot.map((v) => Math.max(-level, Math.min(level, v)));

  it('finds runs of samples stuck at the clip level', () => {
    const runs = findClipped(clipped, 0, clipped.length, level, 3);
    expect(runs.length).toBeGreaterThan(20);
    for (const [a, b] of runs) for (let i = a; i < b; i++) expect(Math.abs(clipped[i])).toBeCloseTo(level, 3);
    expect(findClipped(hot, 0, hot.length, level * 1.5, 3).length).toBeLessThan(3);
  });

  it('rebuilds clipped peaks much closer to the original', () => {
    const { y, p } = run(clipped);
    expect(p.repaired).toBeGreaterThan(20);
    let before = 0;
    let after = 0;
    for (let i = 0; i < clipped.length - p.latency; i++) {
      if (Math.abs(clipped[i]) < level - 1e-6) continue;
      before += (clipped[i] - hot[i]) ** 2;
      after += (y[i + p.latency] - hot[i]) ** 2;
    }
    expect(10 * Math.log10(after / before)).toBeLessThan(-9);
    // and leaves everything else bit for bit
    for (let i = 2000; i < clipped.length - p.latency; i += 7) {
      if (Math.abs(clipped[i]) < level * 0.5) expect(y[i + p.latency]).toBe(clipped[i]);
    }
  });

  it('does nothing to audio that is not clipped', () => {
    const { y, p } = run(hot);
    expect(p.repaired).toBeLessThan(3);
    let err = 0;
    for (let i = 0; i < hot.length - p.latency; i++) err = Math.max(err, Math.abs(y[i + p.latency] - hot[i]));
    expect(err).toBeLessThan(1e-3);
  });

  it('turns the output down by the output gain and plays only the rebuilt part on request', () => {
    const { y, p } = run(clipped, { gain: -6 });
    let mx = 0;
    for (const v of y) mx = Math.max(mx, Math.abs(v));
    expect(mx).toBeLessThan(level * 1.6 * 0.51);
    const only = run(clipped, { output: 1 });
    for (let i = 2000; i < clipped.length - p.latency; i += 7) if (Math.abs(clipped[i]) < level * 0.5) expect(only.y[i + p.latency]).toBe(0);
  });

  it('is a filter with presets', () => {
    expect(createProcessor('declip', SR).latency / SR).toBeLessThan(0.02);
    expect(factoryPresets('declip').map((e) => e.preset.name)).toContain('Heavy clipping');
  });
});
