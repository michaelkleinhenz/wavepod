import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DECLICK_SECONDS, fadesAt, overlapSpans, trackFades } from '../src/core/crossfade';
import { fadeCurve, fadeGain } from '../src/core/dsp';
import { Mixer, ReaderCache } from '../src/core/mixer';
import { addTrack, createProject, rippleDelete, splitAt } from '../src/core/project';
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

describe('declicking hard cuts', () => {
  const sr = 48000;
  const n = sr * 2;
  // a 220 Hz tone: any cut lands somewhere on the wave, not at a zero crossing
  const tone = new Float32Array(n).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 220 * i) / sr));
  const largestStep = (x: Float32Array, a: number, b: number) => {
    let m = 0;
    for (let i = a + 1; i < b; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
    return m;
  };
  const renderCut = (cutFrom: number, cutTo: number) => {
    const dir = tmpDir();
    writeWavFile(path.join(dir, 'tone.wav'), [tone], sr, 32);
    let p = createProject('X', sr);
    p = addTrack(p, { name: 'T', pan: 0 });
    p.tracks[0].clips.push(clip('a', 0, n, { file: 'tone.wav' }));
    // what deleting a transcript word does
    p = rippleDelete(p, cutFrom, cutTo);
    const readers = new ReaderCache(dir);
    const mixer = new Mixer(p, readers);
    const out = [new Float32Array(sr), new Float32Array(sr)];
    // render in playback-sized blocks, so block edges are covered too
    for (let pos = 0; pos < sr; pos += 512) {
      const m = Math.min(512, sr - pos);
      const blk = [new Float32Array(m), new Float32Array(m)];
      mixer.render(pos, m, blk);
      out[0].set(blk[0], pos);
    }
    mixer.dispose();
    readers.closeAll();
    fs.rmSync(dir, { recursive: true, force: true });
    return out[0];
  };

  it('leaves no step in the waveform where a word was cut out', () => {
    // cut at a quarter period in (wave at its top) to a point half a period later (wave at its bottom)
    const from = 24000 + Math.round(sr / 220 / 4);
    const out = renderCut(from, from + 4321 + Math.round(sr / 220 / 2));
    const normal = largestStep(out, 1000, 20000);
    // without the declick the joint jumps by ~1.0 (top to bottom of the wave); now it stays as smooth as the tone
    expect(largestStep(out, from - 2000, from + 2000)).toBeLessThan(normal * 1.6);
  });

  it('crossfades a butt joint instead of dipping to silence', () => {
    const from = 24000 + 37;
    const out = renderCut(from, from + 9000);
    const d = Math.round(DECLICK_SECONDS * sr);
    const rms = (a: number, b: number) => Math.sqrt(out.slice(a, b).reduce((s, v) => s + v * v, 0) / (b - a));
    // the level across the joint stays within 1.5 dB of the tone
    expect(Math.abs(20 * Math.log10(rms(from, from + d) / rms(1000, 1000 + d)))).toBeLessThan(1.5);
  });

  it('does not touch a split that simply continues the same audio', () => {
    let p = createProject('X', sr);
    p = addTrack(p, { name: 'T', pan: 0 });
    p.tracks[0].clips.push(clip('a', 0, n));
    p = splitAt(p, 12345);
    const f = trackFades(p.tracks[0], 240);
    const [a, b] = p.tracks[0].clips;
    // the start of the file was never cut, so it stays as it is
    expect(f.get(a.id)).toMatchObject({ declickOut: 0, tail: 0, declickIn: 0 });
    expect(f.get(b.id)).toMatchObject({ declickIn: 0, declickOut: 240, tail: 0 });
    // and the drawn fades stay what the user set
    expect(f.get(a.id)).toMatchObject({ fadeIn: 0, fadeOut: 0 });
  });

  it('keeps clips with their own fades and crossfades as they are', () => {
    const f = trackFades(track([clip('a', 0, 1000, { fadeOut: 50 }), clip('b', 800, 1000), clip('c', 1800, 500, { offset: 7000 })]), 240);
    expect(f.get('a')).toMatchObject({ declickOut: 0, tail: 0 });
    expect(f.get('b')).toMatchObject({ declickIn: 0, tail: 240, declickOut: 0 });
    expect(f.get('c')).toMatchObject({ declickIn: 240 });
  });
});

describe('overlap spans', () => {
  it('finds where clips play at once, for drawing them see-through', () => {
    const spans = overlapSpans([clip('a', 0, 1000), clip('b', 800, 1000), clip('c', 3000, 100)]);
    expect(spans).toEqual([{ from: 800, to: 1000, clips: [0, 1] }]);
  });

  it('splits spans where the set of clips changes and ignores clips that only touch', () => {
    const spans = overlapSpans([clip('a', 0, 1000), clip('b', 500, 1000), clip('c', 700, 100), clip('d', 1500, 200)]);
    expect(spans).toEqual([
      { from: 500, to: 700, clips: [0, 1] },
      { from: 700, to: 800, clips: [0, 1, 2] },
      { from: 800, to: 1000, clips: [0, 1] },
    ]);
  });
});
