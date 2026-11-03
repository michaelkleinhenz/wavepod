import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { LoudnessMeter, normalizationGain, normalizedClipGain } from '../src/core/loudness';
import { analyseClips, analyseProject, measureClip } from '../src/core/analysis';
import { addClip, addTrack, createProject } from '../src/core/project';
import { writeWavFile } from '../src/core/wav';
import type { Clip } from '../src/shared/types';
import { sine, tmpDir } from './helpers';

const dbAmp = (db: number) => Math.pow(10, db / 20);
function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

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

describe('loudness categories (EBU Tech 3341 / 3342)', () => {
  it('reads momentary, short-term and integrated of a steady −23 dBFS sine as −23 LUFS', () => {
    const s = sine(1000, 20, 48000, dbAmp(-23));
    const m = new LoudnessMeter(48000, 2);
    m.push([s, s]);
    const st = m.stats();
    expect(st.integrated).toBeCloseTo(-23, 1);
    expect(st.momentaryMax).toBeCloseTo(-23, 1);
    expect(st.shortTermMax).toBeCloseTo(-23, 1);
    expect(st.range).toBeLessThan(0.2);
    expect(st.duration).toBeCloseTo(20, 3);
    expect(st.history.length).toBeGreaterThan(100);
    expect(st.history[10]).toBeCloseTo(-23, 1);
  });

  it('measures a loudness range of 10 LU for 20 s at −20 then 20 s at −30 dBFS (Tech 3342 case 1)', () => {
    const s = concat(sine(1000, 20, 48000, dbAmp(-20)), sine(1000, 20, 48000, dbAmp(-30)));
    const m = new LoudnessMeter(48000, 2);
    m.push([s, s]);
    expect(m.range()).toBeCloseTo(10, 0);
  });

  it('catches a short burst in momentary but not in short-term loudness', () => {
    const s = concat(sine(1000, 5, 48000, dbAmp(-30)), sine(1000, 0.5, 48000, dbAmp(-10)), sine(1000, 5, 48000, dbAmp(-30)));
    const m = new LoudnessMeter(48000, 2);
    m.push([s, s]);
    const st = m.stats();
    expect(st.momentaryMax).toBeCloseTo(-10, 0);
    expect(st.shortTermMax).toBeLessThan(-17);
    expect(st.shortTermMax).toBeGreaterThan(-25);
  });

  it('finds the true peak between samples', () => {
    // fs/4 sine at 45° phase: every sample sits at ±0.707 of the real peak
    const n = 48000;
    const s = new Float32Array(n);
    for (let i = 0; i < n; i++) s[i] = 0.5 * Math.sin((Math.PI / 2) * i + Math.PI / 4);
    const m = new LoudnessMeter(48000, 1);
    m.push([s]);
    expect(m.peakDb()).toBeCloseTo(20 * Math.log10(0.5 * Math.SQRT1_2), 1);
    expect(m.truePeakDb()).toBeCloseTo(20 * Math.log10(0.5), 0);
    expect(Math.abs(m.truePeakDb() - 20 * Math.log10(0.5))).toBeLessThan(0.3);
  });

  it('never reads a true peak below the sample peak', () => {
    const s = sine(997, 2, 44100, 0.8);
    const m = new LoudnessMeter(44100, 2);
    m.push([s, s]);
    expect(m.truePeakDb()).toBeGreaterThanOrEqual(m.peakDb());
    expect(m.truePeakDb()).toBeLessThan(m.peakDb() + 0.1);
  });
});

describe('clip loudness and normalisation', () => {
  const SR = 48000;
  const setup = () => {
    const dir = tmpDir();
    const mono = sine(1000, 6, SR, dbAmp(-30));
    writeWavFile(path.join(dir, 'mono.wav'), [mono], SR, 24);
    const loud = sine(1000, 6, SR, dbAmp(-6));
    writeWavFile(path.join(dir, 'loud.wav'), [loud, loud], SR, 24);
    let p = addTrack(createProject('t', SR), { name: 'Host' });
    const trackId = p.tracks[0].id;
    const clip = (id: string, file: string, gain = 0): Clip => ({ id, file, start: 0, offset: 0, length: 6 * SR, gain, fadeIn: 0, fadeOut: 0 });
    p = addClip(p, trackId, clip('a', 'mono.wav'));
    p = addClip(p, trackId, { ...clip('b', 'loud.wav', -3), start: 7 * SR });
    return { dir, p };
  };

  it('measures a mono clip on both channels and includes the clip gain', () => {
    const { dir, p } = setup();
    const a = measureClip(dir, p.tracks[0].clips.find((c) => c.id === 'a')!);
    expect(a.integrated).toBeCloseTo(-30, 0);
    const b = measureClip(dir, p.tracks[0].clips.find((c) => c.id === 'b')!);
    expect(b.integrated).toBeCloseTo(-9, 0);
    expect(b.truePeak).toBeCloseTo(-9, 0);
  });

  it('computes the clip gain for the target, held back by the true-peak ceiling', () => {
    const { dir, p } = setup();
    const [a, b] = analyseClips(p, dir, ['a', 'b', 'gone']).map((r) => r.stats);
    const clips = p.tracks[0].clips;
    const ca = clips.find((c) => c.id === 'a')!;
    const cb = clips.find((c) => c.id === 'b')!;
    // −30 → −16: +14 dB; the peak (−30 dBFS) stays far below −1 dBTP
    expect(normalizedClipGain(ca, a, { lufs: -16, ceiling: -1 })).toBeCloseTo(14, 0);
    // −9 LUFS at −3 dB clip gain with a −9 dBTP peak: −16 needs −7 dB more → −10 dB
    expect(normalizedClipGain(cb, b, { lufs: -16, ceiling: -1 })).toBeCloseTo(-10, 0);
    // a quiet sine at −19 target and −20 ceiling: the peak limits it
    const g = normalizedClipGain(ca, a, { lufs: -10, ceiling: -20 })!;
    expect(g).toBeLessThanOrEqual(10);
    expect(g).toBeGreaterThan(9.5);
    expect(normalizedClipGain(ca, { ...a, integrated: -Infinity }, { lufs: -16, ceiling: -1 })).toBeNull();
  });

  it('analyses the mix and each track', () => {
    const { dir, p } = setup();
    const reports = analyseProject(p, dir);
    expect(reports.map((r) => r.kind)).toEqual(['mix', 'track']);
    expect(reports[0].stats.truePeak).toBeCloseTo(-9, 0);
    expect(Number.isFinite(reports[1].stats.integrated)).toBe(true);
  });
});
