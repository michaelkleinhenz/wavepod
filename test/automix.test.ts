import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Mixer, ReaderCache } from '../src/core/mixer';
import { addTrack, createProject, normalizeProject } from '../src/core/project';
import { writeWavFile } from '../src/core/wav';
import type { Clip, Project } from '../src/shared/types';
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
});
