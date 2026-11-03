import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fadesAt, trackFades } from '../src/core/crossfade';
import { fadeCurve, fadeGain } from '../src/core/dsp';
import { Mixer, ReaderCache } from '../src/core/mixer';
import { addTrack, createProject } from '../src/core/project';
import { writeWavFile } from '../src/core/wav';
import type { Clip, Track } from '../src/shared/types';
import { tmpDir } from './helpers';

const clip = (id: string, start: number, length: number, extra: Partial<Clip> = {}): Clip => ({
  id, file: 'one.wav', start, offset: 0, length, gain: 0, fadeIn: 0, fadeOut: 0, ...extra,
});
const track = (clips: Clip[]): Track => ({ id: 't', name: 'T', color: '#fff', inputChannels: [], armed: false, mute: false, solo: false, gain: 0, pan: 0, clips });

describe('fade shapes', () => {
  it('runs from 0 to 1 for every shape, equal power keeps the summed power at 1', () => {
    for (const s of ['linear', 'equalPower', 'sCurve'] as const) {
      expect(fadeCurve(0, s)).toBeCloseTo(0);
      expect(fadeCurve(1, s)).toBeCloseTo(1);
      expect(fadeCurve(0.5, s)).toBeGreaterThan(0.45);
    }
    for (const t of [0.1, 0.3, 0.5, 0.8]) expect(fadeCurve(t, 'equalPower') ** 2 + fadeCurve(1 - t, 'equalPower') ** 2).toBeCloseTo(1);
    expect(fadeCurve(0.25, 'sCurve')).toBeLessThan(0.25);
    // the default stays linear, as before
    expect(fadeGain(25, 1000, 100, 0)).toBeCloseTo(0.25);
    expect(fadeGain(25, 1000, 100, 0, 'equalPower')).toBeCloseTo(Math.sin(Math.PI / 8));
  });
});

describe('automatic crossfades', () => {
  it('fades both clips over their overlap', () => {
    const f = trackFades(track([clip('a', 0, 1000, { fadeOut: 50 }), clip('b', 800, 1000)]));
    expect(f.get('a')).toMatchObject({ fadeOut: 200, outShape: 'equalPower', autoOut: true });
    expect(f.get('b')).toMatchObject({ fadeIn: 200, inShape: 'equalPower', autoIn: true });
  });

  it('keeps a longer fade the user drew and leaves clips that don’t overlap alone', () => {
    const f = trackFades(track([clip('a', 0, 1000, { fadeOut: 300, fadeOutShape: 'sCurve' }), clip('b', 900, 500), clip('c', 2000, 100)]));
    expect(f.get('a')).toMatchObject({ fadeOut: 300, outShape: 'sCurve', autoOut: false });
    expect(f.get('b')).toMatchObject({ fadeIn: 100, autoIn: true });
    expect(f.get('c')).toMatchObject({ fadeIn: 0, fadeOut: 0, autoIn: false });
  });

  it('does not crossfade a clip that lies inside another one', () => {
    const f = trackFades(track([clip('a', 0, 1000), clip('b', 200, 100)]));
    expect(f.get('a')!.fadeOut).toBe(0);
    expect(f.get('b')!.fadeIn).toBe(0);
  });

  it('keeps a constant level across a crossfade of the same material in the mix', () => {
    const dir = tmpDir();
    const sr = 1000;
    // two unrelated noise-like signals: an equal-power crossfade keeps their power
    const n = 4000;
    const noiseA = new Float32Array(n).map((_, i) => Math.sin(i * 12.9898) * 0.5);
    const noiseB = new Float32Array(n).map((_, i) => Math.sin(i * 78.233 + 1) * 0.5);
    writeWavFile(path.join(dir, 'a.wav'), [noiseA], sr, 32);
    writeWavFile(path.join(dir, 'b.wav'), [noiseB], sr, 32);
    let p = createProject('X', sr);
    p = addTrack(p, { name: 'T', pan: 0 });
    p.tracks[0].clips.push(clip('a', 0, 2000, { file: 'a.wav' }), clip('b', 1000, 2000, { file: 'b.wav' }));
    const readers = new ReaderCache(dir);
    const mixer = new Mixer(p, readers);
    const out = [new Float32Array(3000), new Float32Array(3000)];
    mixer.render(0, 3000, out);
    const rms = (a: number, b: number) => Math.sqrt(out[0].slice(a, b).reduce((s, v) => s + v * v, 0) / (b - a));
    const before = rms(200, 900);
    const during = rms(1100, 1900);
    const after = rms(2100, 2900);
    // equal power: about the same loudness all the way through (within 1.5 dB)
    expect(Math.abs(20 * Math.log10(during / before))).toBeLessThan(1.5);
    expect(Math.abs(20 * Math.log10(after / before))).toBeLessThan(1.5);
    // and the joint is a real crossfade: at its middle both clips play at ~0.707
    const f = trackFades(p.tracks[0]);
    expect(fadesAt(f.get('a')!, 2000, 1500)).toBeCloseTo(Math.SQRT1_2, 2);
    mixer.dispose();
    readers.closeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
