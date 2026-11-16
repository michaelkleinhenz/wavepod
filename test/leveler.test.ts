import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFx } from '../src/core/fx/definitions';
import { factoryPresets } from '../src/core/fx/presets';
import { createProcessor } from '../src/core/fx/processors';
import { VoiceLeveler } from '../src/core/fx/leveler';
import { LoudnessMeter } from '../src/core/loudness';
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
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return (s / 2 ** 32) * 2 - 1;
  };
}

function run(x: Float32Array, params: Record<string, number> = {}): { y: Float32Array; p: VoiceLeveler } {
  const p = new VoiceLeveler(SR);
  p.setParams({ ...createFx('leveler').params, ...params });
  const L = Float32Array.from(x);
  const R = Float32Array.from(x);
  for (let i = 0; i < L.length; i += 480) {
    const n = Math.min(480, L.length - i);
    p.process(L.subarray(i, i + n), R.subarray(i, i + n), n);
  }
  return { y: L, p };
}

function lufs(x: Float32Array, from: number, to: number): number {
  const m = new LoudnessMeter(SR, 1);
  const part = x.slice(Math.round(from * SR), Math.round(to * SR));
  m.push([part], part.length);
  return m.integrated();
}

const rmsDb = (a: ArrayLike<number>, from: number, to: number) => {
  let s = 0;
  for (let i = Math.round(from * SR); i < Math.round(to * SR); i++) s += a[i] * a[i];
  return 10 * Math.log10(s / (Math.round(to * SR) - Math.round(from * SR)));
};

describe('Voice leveler', () => {
  // the same sentence three times: normal, 12 dB quieter (leaning back), 6 dB louder,
  // with a second of room noise between
  const sp = speech();
  const gap = SR;
  const rnd = lcg(5);
  const parts: Array<[number, number]> = [];
  const x = new Float32Array(sp.length * 3 + gap * 4);
  for (let i = 0; i < x.length; i++) x[i] = 0.001 * rnd();
  [0, -12, 6].forEach((g, k) => {
    const at = gap + k * (sp.length + gap);
    const lin = Math.pow(10, g / 20) * 0.5;
    for (let i = 0; i < sp.length; i++) x[at + i] += sp[i] * lin;
    parts.push([at / SR, (at + sp.length) / SR]);
  });

  it('brings quiet and loud passages close to the target', () => {
    const { y, p } = run(x, { target: -20, range: 12, speed: 2 });
    const shift = p.latency / SR;
    const before = parts.map(([a, b]) => lufs(x, a + 1, b));
    const after = parts.map(([a, b]) => lufs(y, a + 1 + shift, b + shift));
    expect(Math.max(...before) - Math.min(...before)).toBeGreaterThan(15);
    expect(Math.max(...after) - Math.min(...after)).toBeLessThan(6);
    for (const l of after) expect(Math.abs(l - -20)).toBeLessThan(4);
  });

  it('does not pump up the room noise in pauses', () => {
    const { y, p } = run(x, { target: -20, range: 12, speed: 2 });
    const shift = p.latency / SR;
    // the pause after the quiet sentence: gain is held, not raised further
    const [, end] = parts[1];
    const noiseIn = rmsDb(x, end + 0.4, end + 0.9);
    const noiseOut = rmsDb(y, end + 0.4 + shift, end + 0.9 + shift);
    expect(noiseOut - noiseIn).toBeLessThan(12.5);
  });

  it('never moves more than the range', () => {
    const { y, p } = run(x, { target: -12, range: 3, speed: 2 });
    const shift = p.latency / SR;
    const [a, b] = parts[1];
    expect(lufs(y, a + 1 + shift, b + shift) - lufs(x, a + 1, b)).toBeLessThan(3.2);
  });

  it('is a filter with presets', () => {
    expect(createProcessor('leveler', SR).latency).toBe(14400);
    expect(factoryPresets('leveler').map((e) => e.preset.name)).toContain('Remote guest');
  });
});
