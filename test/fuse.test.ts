import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyRenderedFuse, checkFuse, fuseSeamless, fuseTargets, fuseTranscript, isSeamlessFuse } from '../src/core/fuse';
import { renderFused } from '../src/core/fuseRender';
import { Mixer, ReaderCache } from '../src/core/mixer';
import { envelopeDbAt } from '../src/core/envelope';
import { setClipReverse } from '../src/core/clipSound';
import { createFx } from '../src/core/fx/definitions';
import { createProject, splitAt } from '../src/core/project';
import { readWavFile, writeWavFile } from '../src/core/wav';
import type { Clip, FileTranscript, Project, Track } from '../src/shared/types';
import { tmpDir } from './helpers';

const clip = (id: string, file: string, start: number, length: number, extra: Partial<Clip> = {}): Clip => ({
  id, file, start, offset: 0, length, gain: 0, fadeIn: 0, fadeOut: 0, ...extra,
});
const track = (clips: Clip[], extra: Partial<Track> = {}): Track => ({ id: 't', name: 'T', color: '#fff', inputChannels: [], armed: false, mute: false, solo: false, gain: 0, pan: 0, clips, ...extra });
const project = (...tracks: Track[]): Project => ({ ...createProject('Fuse', 48000), tracks });

function noise(n: number, seed: number): Float32Array {
  let s = seed;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = (s / 2 ** 32 - 0.5) * 0.8;
  }
  return out;
}

/** The track's clips as they sound (left channel), before track gain and pan. */
function renderTrack(p: Project, dir: string, from: number, n: number): Float32Array[] {
  const readers = new ReaderCache(dir);
  const mixer = new Mixer(p, readers);
  const out = [new Float32Array(n), new Float32Array(n)];
  mixer.renderTrackInto(p.tracks[0], from, n, out);
  mixer.dispose();
  readers.closeAll();
  return out;
}

describe('which clips can be fused', () => {
  const p = project(track([clip('a', 'a.wav', 0, 100), clip('b', 'b.wav', 100, 100), clip('c', 'c.wav', 300, 50)]), { ...track([clip('x', 'x.wav', 0, 10)]), id: 't2' });

  it('needs two or more clips of one track without another clip between them', () => {
    expect(checkFuse(p, ['a', 'b'])).toMatchObject({ ok: true, start: 0, end: 200 });
    // a gap is fine: it becomes silence
    expect(checkFuse(p, ['b', 'c'])).toMatchObject({ ok: true, start: 100, end: 350 });
    expect(checkFuse(p, ['a'])).toMatchObject({ ok: false });
    expect(checkFuse(p, ['a', 'x'])).toMatchObject({ ok: false, reason: expect.stringMatching(/one track/) });
    expect(checkFuse(p, ['a', 'c'])).toMatchObject({ ok: false, reason: expect.stringMatching(/between/) });
  });

  it('fuses a single clip with the next one on its track', () => {
    expect(fuseTargets(p, ['a'])).toEqual(['a', 'b']);
    expect(fuseTargets(p, ['b'])).toEqual(['b', 'c']);
    expect(fuseTargets(p, ['c'])).toEqual(['c']);
    expect(fuseTargets(p, ['a', 'c'])).toEqual(['a', 'c']);
  });
});

describe('seamless fuse', () => {
  it('undoes a split without new audio, keeping fades, names and the volume line', () => {
    const orig = clip('a', 'a.wav', 1000, 9000, { offset: 500, fadeIn: 100, fadeOut: 200, name: 'Intro', envelope: [{ pos: 2000, db: -6 }] });
    let p = project(track([orig]));
    p = splitAt(splitAt(p, 4000), 7000);
    const ids = p.tracks[0].clips.map((c) => c.id);
    expect(ids).toHaveLength(3);
    expect(isSeamlessFuse(p.tracks[0].clips)).toBe(true);
    const r = fuseSeamless(p, ids)!;
    const [fused] = r.project.tracks[0].clips;
    expect(r.project.tracks[0].clips).toHaveLength(1);
    expect(fused).toMatchObject({ id: r.clipId, file: 'a.wav', start: 1000, offset: 500, length: 9000, fadeIn: 100, fadeOut: 200, name: 'Intro' });
    // the volume line plays the same everywhere
    for (const pos of [500, 1999, 2000, 3500, 6500, 9499]) expect(envelopeDbAt(fused.envelope, pos)).toBeCloseTo(envelopeDbAt(orig.envelope, pos));
  });

  it('is not seamless across a gain step, a fade, another file or a jump in the file', () => {
    const a = clip('a', 'a.wav', 0, 100);
    expect(isSeamlessFuse([a, clip('b', 'a.wav', 100, 100, { offset: 100 })])).toBe(true);
    expect(isSeamlessFuse([a, clip('b', 'a.wav', 100, 100, { offset: 100, gain: -2 })])).toBe(false);
    expect(isSeamlessFuse([a, clip('b', 'a.wav', 100, 100, { offset: 100, fadeIn: 10 })])).toBe(false);
    expect(isSeamlessFuse([a, clip('b', 'b.wav', 100, 100, { offset: 100 })])).toBe(false);
    expect(isSeamlessFuse([a, clip('b', 'a.wav', 100, 100, { offset: 300 })])).toBe(false);
  });
});

describe('rendered fuse', () => {
  it('sounds exactly like the clips it replaces', () => {
    const dir = tmpDir();
    const sr = 48000;
    writeWavFile(path.join(dir, 'a.wav'), [noise(20000, 1)], sr, 32);
    writeWavFile(path.join(dir, 'b.wav'), [noise(20000, 2)], sr, 32);
    const clips = [
      clip('a', 'a.wav', 1000, 6000, { offset: 3000, gain: -3, fadeIn: 400, envelope: [{ pos: 5000, db: -10 }, { pos: 6000, db: 0 }] }),
      // overlaps a: a crossfade
      clip('b', 'b.wav', 6500, 5000, { offset: 100, gain: 2 }),
      // butt joint after b, played backwards, with a gap before c
      setClipReverse(clip('r', 'a.wav', 11500, 3000), true),
      clip('c', 'b.wav', 15000, 3000, { offset: 9000, fadeOut: 500 }),
    ];
    const p = project(track(clips));
    const ids = clips.map((c) => c.id);
    const r = renderFused(p, dir, ids, path.join(dir, 'fused.wav'));
    expect(r).toEqual({ frames: 17000, channels: 1 });
    const fused = applyRenderedFuse(p, ids, 'fused.wav')!;
    const [f] = fused.project.tracks[0].clips;
    // mixed gains are rendered in; the outer fades stay editable
    expect(f).toMatchObject({ file: 'fused.wav', start: 1000, offset: 0, length: 17000, gain: 0, fadeIn: 400, fadeOut: 500 });
    expect(f.envelope).toBeUndefined();
    const before = renderTrack(p, dir, 0, 20000)[0];
    const after = renderTrack(fused.project, dir, 0, 20000)[0];
    let worst = 0;
    for (let i = 0; i < before.length; i++) worst = Math.max(worst, Math.abs(before[i] - after[i]));
    expect(worst).toBeLessThan(1e-5);
    expect(Math.max(...before.map(Math.abs))).toBeGreaterThan(0.1);
  });

  it('keeps a shared clip gain and shared clip filters on the fused clip, and stays stereo', () => {
    const dir = tmpDir();
    const sr = 48000;
    writeWavFile(path.join(dir, 'm.wav'), [noise(4000, 3)], sr, 32);
    writeWavFile(path.join(dir, 's.wav'), [noise(4000, 4), noise(4000, 5)], sr, 32);
    const gate = createFx('gate');
    const clips = [clip('m', 'm.wav', 0, 2000, { gain: -4, fx: [gate] }), clip('s', 's.wav', 2000, 2000, { gain: -4, fx: [{ ...gate, id: 'other' }] })];
    const p = project(track(clips));
    const r = renderFused(p, dir, ['m', 's'], path.join(dir, 'f.wav'));
    expect(r.channels).toBe(2);
    const { channels } = readWavFile(path.join(dir, 'f.wav'));
    // gain stays on the clip, so the file holds the clips at 0 dB
    expect(channels[0][10]).toBeCloseTo(noise(4000, 3)[10], 5);
    expect(channels[1][2500]).toBeCloseTo(noise(4000, 5)[500], 5);
    const [f] = applyRenderedFuse(p, ['m', 's'], 'f.wav')!.project.tracks[0].clips;
    expect(f.gain).toBe(-4);
    expect(f.fx).toHaveLength(1);
    expect(f.fx![0]).toMatchObject({ type: 'gate', enabled: true });
  });
});

describe('fused transcript', () => {
  const t = (file: string, words: Array<[string, number, number]>, extra: Partial<FileTranscript> = {}): FileTranscript => ({
    version: 1, file, sampleRate: 48000, language: 'en', model: 'scribe', created: '', words: words.map(([text, start, end]) => ({ text, start, end })), ...extra,
  });

  it('puts each clip’s words where it plays in the fused file', () => {
    const files: Record<string, FileTranscript> = {
      'a.wav': t('a.wav', [['cut', 100, 200], ['hello', 1100, 1300], ['there', 1400, 1800], ['gone', 2500, 2600]]),
      'b.wav': t('b.wav', [['world', 5100, 5400]]),
    };
    const clips = [clip('a', 'a.wav', 0, 1000, { offset: 1000 }), clip('b', 'b.wav', 1500, 1000, { offset: 5000 })];
    const out = fuseTranscript(clips, 0, 2500, 'media/f.wav', 48000, (f) => files[f])!;
    expect(out.words.map((w) => [w.text, w.start, w.end])).toEqual([
      ['hello', 100, 300],
      ['there', 400, 800],
      ['world', 1600, 1900],
    ]);
    expect(out.file).toBe('media/f.wav');
    expect(out.spans).toBeUndefined();
  });

  it('marks parts without a transcript as not transcribed, and is null without any', () => {
    const files: Record<string, FileTranscript> = { 'a.wav': t('a.wav', [['hi', 10, 50]]) };
    const clips = [clip('a', 'a.wav', 0, 1000), clip('b', 'b.wav', 1000, 500)];
    expect(fuseTranscript(clips, 0, 1500, 'f.wav', 48000, (f) => files[f])!.spans).toEqual([[0, 1000]]);
    expect(fuseTranscript(clips, 0, 1500, 'f.wav', 48000, () => null)).toBeNull();
  });
});
