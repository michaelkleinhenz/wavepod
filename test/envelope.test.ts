import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENV_MIN_DB, addPoint, envelopeAmpAt, envelopeDbAt, fillEnvelope, muteRange, muteSelection, setClipEnvelope } from '../src/core/envelope';
import { Mixer, ReaderCache } from '../src/core/mixer';
import { addTrack, createProject, moveClip, normalizeProject, rippleDelete, splitAt } from '../src/core/project';
import type { Clip } from '../src/shared/types';
import { snap, snapTargets } from '../src/core/snap';
import { writeWavFile } from '../src/core/wav';
import { tmpDir } from './helpers';

describe('volume envelope', () => {
  it('is unity without points and holds the first/last value outside them', () => {
    expect(envelopeAmpAt(undefined, 5)).toBe(1);
    const pts = [
      { pos: 100, db: -6 },
      { pos: 200, db: 0 },
    ];
    expect(envelopeDbAt(pts, 0)).toBeCloseTo(-6, 5);
    expect(envelopeDbAt(pts, 500)).toBeCloseTo(0, 5);
  });

  it('interpolates in dB between points, with steps at shared positions', () => {
    const pts = [
      { pos: 0, db: 0 },
      { pos: 100, db: -20 },
      { pos: 100, db: 0 },
    ];
    expect(envelopeDbAt(pts, 50)).toBeCloseTo(-10, 5);
    expect(envelopeAmpAt(pts, 50)).toBeCloseTo(Math.pow(10, -0.5), 5);
    expect(envelopeAmpAt(pts, 100)).toBe(1);
    const out = new Float32Array(3);
    fillEnvelope(pts, 49, 3, out);
    expect(out[1]).toBeCloseTo(Math.pow(10, -0.5), 5);
    expect(envelopeAmpAt([{ pos: 0, db: ENV_MIN_DB }], 0)).toBe(0);
  });

  it('adds points in order', () => {
    const { points, index } = addPoint([{ pos: 0, db: 0 }, { pos: 100, db: -3 }], 50, -1);
    expect(index).toBe(1);
    expect(points.map((p) => p.pos)).toEqual([0, 50, 100]);
  });

  it('mutes a range with ramps and keeps the line outside it (Ctrl+Y)', () => {
    const pts = muteRange([{ pos: 0, db: -3 }], 1000, 2000, 10);
    expect(pts).toEqual([
      { pos: 0, db: -3 },
      { pos: 990, db: expect.closeTo(-3, 5) },
      { pos: 1000, db: ENV_MIN_DB },
      { pos: 2000, db: ENV_MIN_DB },
      { pos: 2010, db: expect.closeTo(-3, 5) },
    ]);
    expect(envelopeAmpAt(pts, 1500)).toBe(0);
    expect(envelopeDbAt(pts, 3000)).toBeCloseTo(-3, 5);
    // only clips on the selected tracks change, in source frames, and their lines become visible
    let p = addTrack(addTrack(createProject('E', 48000)), {});
    const clip = (id: string, start: number, offset: number): Clip => ({ id, file: 'f', start, offset, length: 48000, gain: 0, fadeIn: 0, fadeOut: 0 });
    p.tracks[0].clips.push(clip('a', 0, 0));
    p.tracks[1].clips.push(clip('b', 40000, 1000), clip('c', 200000, 0));
    p = muteSelection(p, [p.tracks[1].id], 48000, 60000);
    expect(p.tracks[0].clips[0].envelope).toBeUndefined();
    const b = p.tracks[1].clips[0];
    expect(b.showEnvelope).toBe(true);
    expect(envelopeAmpAt(b.envelope, 1000 + 10000)).toBe(0); // timeline 50000
    expect(envelopeAmpAt(b.envelope, 1000 + 1000)).toBe(1);
    expect(p.tracks[1].clips[1].envelope).toBeUndefined();
  });

  it('stays with the audio through splits, trims and ripple cuts', () => {
    let p = addTrack(createProject('E', 48000));
    p.tracks[0].clips.push({ id: 'a', file: 'f', start: 10000, offset: 0, length: 40000, gain: 0, fadeIn: 0, fadeOut: 0 });
    p = setClipEnvelope(p, 'a', [{ pos: 20000, db: -12 }, { pos: 20000, db: 0 }]);
    p = rippleDelete(p, 0, 5000);
    p = splitAt(p, 20000);
    const [l, r] = p.tracks[0].clips;
    // source frame 20000 is timeline 25000 now; the right half starts at source 15000
    expect(envelopeDbAt(l.envelope, l.offset + 5000)).toBeCloseTo(-12, 5);
    expect(envelopeDbAt(r.envelope, r.offset + 10000)).toBeCloseTo(0, 5);
    expect(normalizeProject(JSON.parse(JSON.stringify(p))).tracks[0].clips[0].envelope).toEqual(l.envelope);
  });

  it('turns an old per-track line into clip lines', () => {
    const raw = JSON.parse(JSON.stringify(addTrack(createProject('E', 48000))));
    raw.tracks[0].clips.push({ id: 'a', file: 'f', start: 1000, offset: 500, length: 2000, gain: 0, fadeIn: 0, fadeOut: 0 });
    raw.tracks[0].envelope = [{ pos: 2000, db: -6 }];
    raw.tracks[0].showEnvelope = true;
    const c = normalizeProject(raw).tracks[0].clips[0];
    expect(c.showEnvelope).toBe(true);
    expect(envelopeDbAt(c.envelope, 500)).toBeCloseTo(-6, 5);
    expect('envelope' in normalizeProject(raw).tracks[0]).toBe(false);
  });

  it('scales the clip in the mixer', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'media'));
    writeWavFile(path.join(dir, 'media/dc.wav'), [new Float32Array(48000).fill(0.5)], 48000);
    let p = addTrack(createProject('M', 48000), { name: 'Host', pan: 0 });
    p.tracks[0].clips.push({ id: 'c', file: 'media/dc.wav', start: 0, offset: 0, length: 48000, gain: 0, fadeIn: 0, fadeOut: 0 });
    const readers = new ReaderCache(dir);
    const ref = new Mixer(p, readers).render(0, 48000, [new Float32Array(48000), new Float32Array(48000)])[0][1000];
    p = muteSelection(p, [p.tracks[0].id], 10000, 20000);
    p = setClipEnvelope(p, 'c', [...p.tracks[0].clips[0].envelope!, { pos: 30000, db: 0 }, { pos: 30000, db: -6 }]);
    const out = new Mixer(p, readers).render(0, 48000, [new Float32Array(48000), new Float32Array(48000)]);
    readers.closeAll();
    expect(out[0][5000]).toBeCloseTo(ref, 5);
    expect(out[0][15000]).toBe(0);
    expect(out[0][40000]).toBeCloseTo(ref / 2, 2);
  });
});

describe('snapping', () => {
  it('snaps the closest candidate within the threshold', () => {
    expect(snap([100, 200], [195, 500], 10)).toEqual({ delta: -5, target: 195 });
    expect(snap([100, 200], [130], 10)).toBeNull();
    expect(snap([100], [104, 97], 10)).toEqual({ delta: -3, target: 97 });
  });

  it('collects clip edges and markers but not the excluded clips', () => {
    let p = addTrack(addTrack(createProject()), {});
    p.tracks[0].clips.push({ id: 'a', file: 'x', start: 100, offset: 0, length: 50, gain: 0, fadeIn: 0, fadeOut: 0 });
    p.tracks[1].clips.push({ id: 'b', file: 'y', start: 400, offset: 0, length: 100, gain: 0, fadeIn: 0, fadeOut: 0 });
    p.markers.push({ id: 'm', kind: 'chapter', position: 900, title: '' });
    expect(snapTargets(p, new Set(['a']), [7]).sort((x, y) => x - y)).toEqual([7, 400, 500, 900]);
  });
});

describe('moving clips between tracks', () => {
  it('keeps every moved clip', () => {
    let p = addTrack(addTrack(addTrack(createProject())));
    const clip = (id: string, start: number) => ({ id, file: 'f', start, offset: 0, length: 10, gain: 0, fadeIn: 0, fadeOut: 0 });
    p.tracks[0].clips.push(clip('a', 0), clip('b', 100));
    p.tracks[1].clips.push(clip('c', 50));
    // move a and c down by one track, the way the timeline does it for a multi-selection
    for (const id of ['a', 'c']) {
      const ti = p.tracks.findIndex((t) => t.clips.some((c) => c.id === id));
      p = moveClip(p, id, 500, p.tracks[ti + 1].id);
    }
    expect(p.tracks.map((t) => t.clips.map((c) => c.id))).toEqual([['b'], ['a'], ['c']]);
  });
});
