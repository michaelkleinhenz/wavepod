import { describe, expect, it } from 'vitest';
import {
  addClipFades,
  canSplitAt,
  clipMenuTargets,
  clipsOnSameTrack,
  colorClips,
  duplicateClips,
  removeClipFades,
  resetClipEnvelopes,
  setClipGain,
  showClipEnvelopes,
  splitClipsAt,
  targetClips,
} from '../src/core/clipOps';
import { addTrack, createProject } from '../src/core/project';
import type { Clip } from '../src/shared/types';

const clip = (id: string, start: number, length: number, extra: Partial<Clip> = {}): Clip => ({
  id, file: `${id}.wav`, start, offset: 0, length, gain: 0, fadeIn: 0, fadeOut: 0, ...extra,
});

function project() {
  let p = createProject('C', 1000);
  p = addTrack(p, { name: 'A' });
  p = addTrack(p, { name: 'B' });
  p.tracks[0].clips.push(clip('a1', 0, 1000, { fadeIn: 100, fadeOut: 100 }), clip('a2', 2000, 500));
  p.tracks[1].clips.push(clip('b1', 500, 2000, { envelope: [{ pos: 10, db: -6 }], color: '#fff176' }));
  return p;
}

const all = (p: ReturnType<typeof project>) => p.tracks.flatMap((t) => t.clips);

describe('clip menu targets', () => {
  it('uses the selection when the clicked clip is in it, else the clicked clip alone', () => {
    expect([...clipMenuTargets(new Set(['a1', 'b1']), 'b1')].sort()).toEqual(['a1', 'b1']);
    expect([...clipMenuTargets(new Set(['a1', 'b1']), 'a2')]).toEqual(['a2']);
    expect([...clipMenuTargets(new Set(), 'a2')]).toEqual(['a2']);
  });

  it('lists target clips in timeline order', () => {
    expect(targetClips(project(), new Set(['a2', 'b1', 'a1'])).map((c) => c.id)).toEqual(['a1', 'b1', 'a2']);
  });

  it('selects every clip of a track', () => {
    expect([...clipsOnSameTrack(project(), 'a2')].sort()).toEqual(['a1', 'a2']);
  });
});

describe('split clips', () => {
  it('splits only the targeted clips and returns both halves', () => {
    const p = project();
    const r = splitClipsAt(p, new Set(['a1']), 700);
    const a = r.project.tracks[0].clips;
    expect(a).toHaveLength(3);
    expect(a[0]).toMatchObject({ id: 'a1', length: 700, fadeIn: 100, fadeOut: 0 });
    expect(a[1]).toMatchObject({ start: 700, offset: 700, length: 300, fadeIn: 0, fadeOut: 100 });
    expect(r.clipIds).toEqual(['a1', a[1].id]);
    // b1 spans 700 too, but wasn't targeted
    expect(r.project.tracks[1].clips).toHaveLength(1);
  });

  it('knows when a position is outside every clip', () => {
    const p = project();
    expect(canSplitAt(p, new Set(['a1']), 1500)).toBe(false);
    expect(canSplitAt(p, new Set(['a1', 'b1']), 1500)).toBe(true);
    expect(canSplitAt(p, new Set(['a1']), 0)).toBe(false);
    expect(splitClipsAt(p, new Set(['a1']), 1500).project).toBe(p);
  });
});

describe('duplicate clips', () => {
  it('places copies right after the group, on the same tracks', () => {
    const p = project();
    const r = duplicateClips(p, new Set(['a1', 'b1']));
    expect(r.clipIds).toHaveLength(2);
    const copies = all(r.project).filter((c) => r.clipIds.includes(c.id));
    const byFile = Object.fromEntries(copies.map((c) => [c.file, c]));
    // group spans 0..2500, so the copy starts at 2500 and keeps the offsets between clips
    expect(byFile['a1.wav'].start).toBe(2500);
    expect(byFile['b1.wav'].start).toBe(3000);
    expect(r.project.tracks[1].clips.map((c) => c.file)).toEqual(['b1.wav', 'b1.wav']);
    expect(all(p)).toHaveLength(3);
  });
});

describe('clip properties', () => {
  it('sets and clamps clip gain', () => {
    const p = setClipGain(project(), new Set(['a1', 'a2']), -3.04);
    expect(p.tracks[0].clips.map((c) => c.gain)).toEqual([-3, -3]);
    expect(setClipGain(project(), new Set(['a1']), 99).tracks[0].clips[0].gain).toBe(24);
  });

  it('adds and removes fades', () => {
    const ids = new Set(['a2']);
    const p = addClipFades(project(), ids, 300);
    expect(p.tracks[0].clips[1]).toMatchObject({ fadeIn: 250, fadeOut: 250 });
    expect(removeClipFades(project(), new Set(['a1'])).tracks[0].clips[0]).toMatchObject({ fadeIn: 0, fadeOut: 0 });
  });

  it('shows and resets volume lines', () => {
    const ids = new Set(['b1']);
    expect(showClipEnvelopes(project(), ids, true).tracks[1].clips[0].showEnvelope).toBe(true);
    expect(resetClipEnvelopes(project(), ids).tracks[1].clips[0].envelope).toBeUndefined();
  });

  it('colours clips and takes the colour off', () => {
    const p = colorClips(project(), new Set(['a1', 'b1']), '#81c784');
    expect([p.tracks[0].clips[0].color, p.tracks[1].clips[0].color]).toEqual(['#81c784', '#81c784']);
    expect('color' in colorClips(project(), new Set(['b1']), undefined).tracks[1].clips[0]).toBe(false);
  });

  it('leaves the original project untouched', () => {
    const p = project();
    const before = JSON.stringify(p);
    colorClips(p, new Set(['a1']), '#000');
    resetClipEnvelopes(p, new Set(['b1']));
    setClipGain(p, new Set(['a1']), 5);
    expect(JSON.stringify(p)).toBe(before);
  });
});
