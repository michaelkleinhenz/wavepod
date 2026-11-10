import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Automix } from '../src/core/automix';
import { Mixer, ReaderCache } from '../src/core/mixer';
import { addTrack, createProject, normalizeProject } from '../src/core/project';
import { writeWavFile } from '../src/core/wav';
import type { Clip, Fx, Project } from '../src/shared/types';
import { tmpDir } from './helpers';

const SR = 8000;
const clip = (id: string, file: string, length: number): Clip => ({ id, file, start: 0, offset: 0, length, gain: 0, fadeIn: 0, fadeOut: 0 });
const rmsDb = (x: Float32Array, a: number, b: number) => 10 * Math.log10(x.slice(a, b).reduce((s, v) => s + v * v, 0) / (b - a));
const tone = (f: number, amp: number) => (i: number) => amp * Math.sin((2 * Math.PI * f * i) / SR);

/** Two mics in one room: A speaks 0–2 s, B speaks 2–4 s, both 4–5 s; each mic hears the other 12 dB down. */
function room(): { dir: string; a: Float32Array; b: Float32Array; voiceA: (i: number) => number; voiceB: (i: number) => number } {
  const dir = tmpDir();
  const n = 5 * SR;
  const voiceA = (i: number) => (i < 2 * SR || i >= 4 * SR ? tone(300, 0.3)(i) : 0);
  const voiceB = (i: number) => (i >= 2 * SR ? tone(700, 0.3)(i) : 0);
  const bleed = 10 ** (-12 / 20);
  const a = new Float32Array(n).map((_, i) => voiceA(i) + bleed * voiceB(i));
  const b = new Float32Array(n).map((_, i) => voiceB(i) + bleed * voiceA(i));
  writeWavFile(path.join(dir, 'a.wav'), [a], SR, 32);
  writeWavFile(path.join(dir, 'b.wav'), [b], SR, 32);
  return { dir, a, b, voiceA, voiceB };
}

function project(automix: boolean): Project {
  let p = createProject('A', SR);
  p = addTrack(p, { name: 'A', automix: { enabled: automix, depth: 24 } });
  p = addTrack(p, { name: 'B', automix: { enabled: automix, depth: 24 } });
  p.tracks[0].clips.push(clip('a', 'a.wav', 5 * SR));
  p.tracks[1].clips.push(clip('b', 'b.wav', 5 * SR));
  return p;
}

function render(p: Project, dir: string, stems?: number[]): Float32Array {
  const readers = new ReaderCache(dir);
  const mixer = new Mixer(p, readers);
  const out = new Float32Array(5 * SR);
  for (let pos = 0; pos < 5 * SR; pos += 512) {
    const n = Math.min(512, 5 * SR - pos);
    const blk = [new Float32Array(n), new Float32Array(n)];
    if (stems) mixer.renderStems(p.tracks.filter((_, i) => stems.includes(i)), pos, n, blk);
    else mixer.render(pos, n, blk);
    out.set(blk[0], pos);
  }
  mixer.dispose();
  readers.closeAll();
  return out;
}

const rng = (seed: number) => {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
};

/** Speech-like noise in syllables and words from frame `from` on; `loud(word)` gives a word's extra level in dB. */
function voice(sr: number, n: number, seed: number, from: number, loud: (word: number) => number = () => 0): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(n);
  let i = 0;
  let lp = 0;
  for (let word = 0; i < n; word++) {
    const syllables = 2 + Math.floor((r() + 1) * 2);
    const boost = 10 ** (loud(word) / 20);
    for (let k = 0; k < syllables && i < n; k++) {
      const len = Math.floor(sr * (0.12 + (r() + 1) * 0.07));
      const amp = 0.25 * boost * 10 ** ((r() * 6) / 20);
      for (let j = 0; j < len && i < n; j++, i++) {
        lp += 0.3 * (r() - lp);
        out[i] = i >= from ? amp * Math.sqrt(Math.sin((Math.PI * j) / len)) * lp * 3 : 0;
      }
      i += Math.floor(sr * (0.02 + (r() + 1) * 0.03));
    }
    i += Math.floor(sr * (0.1 + (r() + 1) * 0.25));
  }
  return out;
}

describe('automix', () => {
  it('turns down the mic that only hears crosstalk, and keeps both up when both speak', () => {
    const { dir } = room();
    const p = project(true);
    // B's stem alone: while only A speaks it carries just bleed, which the automix removes
    const stemB = render(p, dir, [1]);
    const bleedOff = render(project(false), dir, [1]);
    expect(rmsDb(bleedOff, 0.5 * SR, 1.9 * SR) - rmsDb(stemB, 0.5 * SR, 1.9 * SR)).toBeGreaterThan(15);
    // while B speaks, B's stem is untouched
    expect(Math.abs(rmsDb(bleedOff, 2.5 * SR, 3.9 * SR) - rmsDb(stemB, 2.5 * SR, 3.9 * SR))).toBeLessThan(0.5);
    // both talking: both stay up
    expect(Math.abs(rmsDb(bleedOff, 4.3 * SR, 5 * SR) - rmsDb(stemB, 4.3 * SR, 5 * SR))).toBeLessThan(1);
    const stemA = render(p, dir, [0]);
    const aOff = render(project(false), dir, [0]);
    expect(aOff.length).toBe(stemA.length);
    expect(rmsDb(aOff, 2.5 * SR, 3.9 * SR) - rmsDb(stemA, 2.5 * SR, 3.9 * SR)).toBeGreaterThan(15);
  });

  it('mix equals the sum of the automixed stems', () => {
    const { dir } = room();
    const p = project(true);
    const mix = render(p, dir);
    const sum = render(p, dir, [0]);
    const b = render(p, dir, [1]);
    let maxDiff = 0;
    for (let i = 0; i < mix.length; i++) maxDiff = Math.max(maxDiff, Math.abs(mix[i] - (sum[i] + b[i])));
    expect(maxDiff).toBeLessThan(1e-5);
  });

  it('does nothing with only one automixed track', () => {
    const { dir } = room();
    const p = project(false);
    p.tracks[0].automix = { enabled: true, depth: 24 };
    const off = render(project(false), dir);
    const on = render(p, dir);
    expect(on).toEqual(off);
  });

  it('keeps the setting through save and load', () => {
    let p = createProject('A', SR);
    p = addTrack(p, { name: 'A', automix: { enabled: true, depth: -24 } });
    const q = normalizeProject(JSON.parse(JSON.stringify(p)));
    expect(q.tracks[0].automix).toEqual({ enabled: true, depth: 24 });
  });

  it('keeps crosstalk down when a word bleeds in louder than usual', () => {
    // speech-like noise in syllables and words; A talks alone for 20 s, then both talk for 10 s.
    // B's mic hears A 9 dB down, but every quarter second that varies by up to ±4 dB (head turns,
    // loud words): the old automix opened B fully for a word whenever the bleed came within 3 dB.
    const sr = 8000;
    const n = 30 * sr;
    const A = voice(sr, n, 1, 0);
    const B = voice(sr, n, 7, 20 * sr);
    const vary = rng(99);
    const seg = sr / 4;
    const kA = Array.from({ length: n / seg + 1 }, () => 10 ** ((-9 + 4 * vary()) / 20));
    const kB = Array.from({ length: n / seg + 1 }, () => 10 ** ((-9 + 4 * vary()) / 20));
    const d = Math.round(0.003 * sr);
    const ma = new Float32Array(n).map((_, i) => A[i] + kB[Math.floor(i / seg)] * (i >= d ? B[i - d] : 0));
    const mb = new Float32Array(n).map((_, i) => B[i] + kA[Math.floor(i / seg)] * (i >= d ? A[i - d] : 0));
    const am = new Automix(sr);
    const ga = new Float32Array(n);
    const gb = new Float32Array(n);
    for (let p = 0; p < n; p += 512) {
      const f = Math.min(512, n - p);
      const a = ma.subarray(p, p + f);
      const b = mb.subarray(p, p + f);
      am.process(['a', 'b'], [[a, a], [b, b]], [24, 24], f, [ga.subarray(p, p + f), gb.subarray(p, p + f)]);
    }
    // while only A talks, B never opens up (above −6 dB) for 30 ms or longer
    let opens = 0;
    let run = 0;
    for (let i = sr; i < 19.5 * sr; i++) {
      run = gb[i] > 0.5 ? run + 1 : 0;
      if (run === Math.round(0.03 * sr)) opens++;
    }
    expect(opens).toBe(0);
    const energy = (x: Float32Array, g: Float32Array | null, a: number, b: number) => {
      let e = 0;
      for (let i = a; i < b; i++) e += (x[i] * (g ? g[i] : 1)) ** 2;
      return e;
    };
    const cut = (x: Float32Array, g: Float32Array, a: number, b: number) => 10 * Math.log10(energy(x, null, a, b) / energy(x, g, a, b));
    // B's bleed is well down, A itself untouched
    expect(cut(mb, gb, sr, 19.5 * sr)).toBeGreaterThan(9);
    expect(cut(ma, ga, sr, 19.5 * sr)).toBeLessThan(0.1);
    // both talking: both stay up
    expect(cut(ma, ga, 20.5 * sr, n)).toBeLessThan(1.5);
    expect(cut(mb, gb, 20.5 * sr, n)).toBeLessThan(1.5);
  });

  it('judges who speaks before the track filters, so compressors and levelers don\'t open the bleed', () => {
    // A talks alone, every fourth word 10 dB louder; B's mic hears A 9 dB down. Both tracks run a
    // compressor or a leveler, which holds A's loud words back but leaves the quiet bleed on B alone,
    // so after the filters the bleed came within 3 dB of A for whole words.
    const sr = 16000;
    const n = 12 * sr;
    const A = voice(sr, n, 3, 0, (w) => (w % 4 === 3 ? 10 : 0));
    const bleed = 10 ** (-9 / 20);
    const d = Math.round(0.003 * sr);
    const ma = new Float32Array(A);
    const mb = new Float32Array(n).map((_, i) => (i >= d ? bleed * A[i - d] : 0));
    const fxs: Record<string, Fx> = {
      compressor: { id: 'c', type: 'compressor', enabled: true, params: { threshold: -36, ratio: 6, attack: 5, release: 150, knee: 6, makeup: 0 } },
      dynamics: { id: 'd', type: 'dynamics', enabled: true, params: { target: -20, noiseFloor: -60, noiseGate: 30 } },
    };
    for (const [name, fx] of Object.entries(fxs)) {
      const dir = tmpDir();
      writeWavFile(path.join(dir, 'a.wav'), [ma], sr, 32);
      writeWavFile(path.join(dir, 'b.wav'), [mb], sr, 32);
      const make = (on: boolean) => {
        let p = createProject('A', sr);
        p = addTrack(p, { name: 'A', automix: { enabled: on, depth: 24 }, fx: [{ ...fx, id: 'fa' }] });
        p = addTrack(p, { name: 'B', automix: { enabled: on, depth: 24 }, fx: [{ ...fx, id: 'fb' }] });
        p.tracks[0].clips.push(clip('a', 'a.wav', n));
        p.tracks[1].clips.push(clip('b', 'b.wav', n));
        return p;
      };
      const stem = (p: Project) => {
        const readers = new ReaderCache(dir);
        const mixer = new Mixer(p, readers);
        const out = new Float32Array(n);
        for (let pos = 0; pos < n; pos += 512) {
          const f = Math.min(512, n - pos);
          const blk = [new Float32Array(f), new Float32Array(f)];
          mixer.renderStems([p.tracks[1]], pos, f, blk);
          out.set(blk[0], pos);
        }
        mixer.dispose();
        readers.closeAll();
        return out;
      };
      const on = stem(make(true));
      const off = stem(make(false));
      // 30 ms windows of B where the bleed is clearly there but less than 6 dB is taken off
      const w = Math.round(0.03 * sr);
      let leaks = 0;
      for (let i = sr; i + w <= n; i += w) {
        const eOff = rmsDb(off, i, i + w);
        if (eOff > -50 && eOff - rmsDb(on, i, i + w) < 6) leaks++;
      }
      expect(leaks, name).toBe(0);
    }
  });
});
