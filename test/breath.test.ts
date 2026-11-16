import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFx } from '../src/core/fx/definitions';
import { factoryPresets } from '../src/core/fx/presets';
import { createProcessor } from '../src/core/fx/processors';
import { BreathControl } from '../src/core/fx/breath';
import { Resampler } from '../src/core/opus';
import { readWavFile } from '../src/core/wav';

const SR = 48000;

function lcg(seed: number) {
  let s = seed;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return (s / 2 ** 32) * 2 - 1;
  };
}

function run(x: Float32Array, params: Record<string, number> = {}): { y: Float32Array; p: BreathControl } {
  const p = new BreathControl(SR);
  p.setParams({ ...createFx('breath').params, ...params });
  const L = Float32Array.from(x);
  const R = Float32Array.from(x);
  for (let i = 0; i < L.length; i += 480) {
    const n = Math.min(480, L.length - i);
    p.process(L.subarray(i, i + n), R.subarray(i, i + n), n);
  }
  return { y: L, p };
}

/** Gain (dB) the filter applied between two times, from input and (delayed) output energy. */
function gainDb(x: Float32Array, y: Float32Array, lat: number, t0: number, t1: number): number {
  let ex = 0;
  let ey = 0;
  for (let i = Math.round(t0 * SR); i < Math.round(t1 * SR); i++) {
    ex += x[i] ** 2;
    ey += y[i + lat] ** 2;
  }
  return 10 * Math.log10(ey / ex);
}

/**
 * Phrases of a voiced "speaker" (harmonics of 120 Hz with syllable rhythm, around −14 dBFS), with an
 * inhale (band-limited noise, around −34 dBFS) in each pause, over room noise at about −60 dBFS.
 */
function speakerWithBreaths(): { x: Float32Array; breaths: Array<[number, number]>; phrases: Array<[number, number]> } {
  const rnd = lcg(3);
  const n = SR * 12;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.0015 * rnd();
  const breaths: Array<[number, number]> = [];
  const phrases: Array<[number, number]> = [];
  let t = 0.5;
  let lp = 0;
  let hp = 0;
  while (t < 11) {
    const len = 2;
    phrases.push([t, t + len]);
    for (let i = Math.round(t * SR); i < Math.round((t + len) * SR); i++) {
      const tt = i / SR - t;
      const syl = Math.max(0, Math.sin(Math.PI * 4 * tt)) ** 0.5;
      let v = 0;
      for (let h = 1; h <= 25; h++) v += Math.sin((2 * Math.PI * 120 * h * i) / SR) / h;
      x[i] += 0.12 * syl * v;
    }
    t += len + 0.2;
    // inhale: 0.45 s of noise between ~500 Hz and ~3 kHz, rising and falling
    const b0 = t;
    const bl = 0.45;
    breaths.push([b0, b0 + bl]);
    for (let i = Math.round(b0 * SR); i < Math.round((b0 + bl) * SR); i++) {
      const env = Math.sin((Math.PI * (i / SR - b0)) / bl);
      const w = rnd();
      lp += 0.3 * (w - lp);
      hp += 0.06 * (lp - hp);
      x[i] += 0.08 * env * (lp - hp);
    }
    t += bl + 0.25;
  }
  return { x, breaths, phrases };
}

describe('Breath control', () => {
  it('turns breaths down by about the reduction and leaves the speech alone', () => {
    const { x, breaths, phrases } = speakerWithBreaths();
    const { y, p } = run(x, { reduction: -15 });
    // skip the first breath while the speech level is learned
    for (const [a, b] of breaths.slice(1)) expect(gainDb(x, y, p.latency, a + 0.05, b - 0.05)).toBeLessThan(-10);
    for (const [a, b] of phrases.slice(1)) expect(Math.abs(gainDb(x, y, p.latency, a + 0.05, b - 0.05))).toBeLessThan(0.5);
  });

  it('plays only the breaths in Breaths only mode', () => {
    const { x, breaths, phrases } = speakerWithBreaths();
    const { y, p } = run(x, { output: 1, reduction: -40 });
    for (const [a, b] of breaths.slice(1)) expect(gainDb(x, y, p.latency, a + 0.08, b - 0.08)).toBeGreaterThan(-1.5);
    for (const [a, b] of phrases.slice(1)) expect(gainDb(x, y, p.latency, a + 0.05, b - 0.05)).toBeLessThan(-30);
  });

  it('hardly touches real speech with room noise in the pauses', () => {
    const { info, channels } = readWavFile(path.join(__dirname, 'fixtures/jfk-speech.wav'));
    const x = new Resampler(info.sampleRate, SR, 1).process([channels[0]], channels[0].length)[0];
    const { y, p } = run(x, { reduction: -20 });
    // words (frames louder than −25 dBFS) keep their level
    let changed = 0;
    let words = 0;
    const hop = 480;
    for (let i = 0; i + hop < x.length - p.latency; i += hop) {
      let e = 0;
      let ey = 0;
      for (let j = i; j < i + hop; j++) {
        e += x[j] ** 2;
        ey += y[j + p.latency] ** 2;
      }
      if (10 * Math.log10(e / hop) > -25) {
        words++;
        if (Math.abs(10 * Math.log10(ey / e)) > 1) changed++;
      }
    }
    expect(words).toBeGreaterThan(150);
    expect(changed / words).toBeLessThan(0.02);
  });

  it('is a filter with presets and a fixed latency', () => {
    const p = createProcessor('breath', SR);
    expect(p.latency / SR).toBeGreaterThan(0.1);
    expect(p.latency / SR).toBeLessThan(0.2);
    expect(factoryPresets('breath').map((e) => e.preset.name)).toContain('Natural');
  });
});
