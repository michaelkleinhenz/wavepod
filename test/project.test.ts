import { describe, expect, it } from 'vitest';
import {
  History,
  addClip,
  addMarker,
  addTrack,
  chaptersToMarkers,
  createProject,
  insertSilence,
  markersToChapters,
  moveClip,
  normalizeProject,
  prepareForEditing,
  rippleDelete,
  splitAt,
} from '../src/core/project';
import type { Clip, Project } from '../src/shared/types';

function clip(id: string, start: number, length: number, offset = 0): Clip {
  return { id, file: 'media/a.wav', start, offset, length, gain: 0, fadeIn: 0, fadeOut: 0 };
}

function setup(): Project {
  let p = createProject('Test', 1000);
  p = addTrack(p, { name: 'Host' });
  p = addTrack(p, { name: 'Guest' });
  p = addClip(p, p.tracks[0].id, clip('a', 0, 1000));
  p = addClip(p, p.tracks[1].id, clip('b', 500, 1000));
  return p;
}

describe('project editing', () => {
  it('splits clips at a position', () => {
    const p = splitAt(setup(), 700);
    expect(p.tracks[0].clips).toHaveLength(2);
    const [l, r] = p.tracks[0].clips;
    expect(l.length).toBe(700);
    expect(r.start).toBe(700);
    expect(r.offset).toBe(700);
    expect(r.length).toBe(300);
    expect(p.tracks[1].clips).toHaveLength(2);
  });

  it('ripple-deletes a range across tracks and markers', () => {
    let p = setup();
    p = addMarker(p, 300, 'chapter', 'A').project;
    p = addMarker(p, 900, 'chapter', 'B').project;
    p = addMarker(p, 1400, 'chapter', 'C').project;
    const out = rippleDelete(p, 600, 1000);
    // track 0: [0,600)
    expect(out.tracks[0].clips.map((c) => [c.start, c.length])).toEqual([[0, 600]]);
    // track 1: [500,600) then [600, 1100) from offset 500
    expect(out.tracks[1].clips.map((c) => [c.start, c.offset, c.length])).toEqual([
      [500, 0, 100],
      [600, 500, 500],
    ]);
    expect(out.markers.map((m) => [m.title, m.position])).toEqual([
      ['A', 300],
      ['C', 1000],
    ]);
    // input untouched
    expect(p.tracks[0].clips).toHaveLength(1);
  });

  it('inserts silence', () => {
    const p = insertSilence(setup(), 200, 50);
    expect(p.tracks[0].clips.map((c) => c.start)).toEqual([0, 250]);
    expect(p.tracks[1].clips[0].start).toBe(550);
  });

  it('moves clips between tracks', () => {
    const p = setup();
    const out = moveClip(p, 'a', 2000, p.tracks[1].id);
    expect(out.tracks[0].clips).toHaveLength(0);
    expect(out.tracks[1].clips.map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('converts markers to chapters and back', () => {
    let p = setup();
    p = addMarker(p, 2500, 'chapter', 'Second').project;
    p = addMarker(p, 500, 'chapter', 'First').project;
    p = addMarker(p, 700, 'edit').project;
    const ch = markersToChapters(p);
    expect(ch).toEqual([
      { start: 0.5, title: 'First' },
      { start: 2.5, title: 'Second' },
    ]);
    const q = chaptersToMarkers(p, [{ start: 1, title: 'Only' }]);
    expect(q.markers.filter((m) => m.kind === 'chapter').map((m) => m.position)).toEqual([1000]);
    expect(q.markers.filter((m) => m.kind === 'edit')).toHaveLength(1);
  });

  it('undoes and redoes', () => {
    const h = new History();
    const a = setup();
    h.push(a);
    const b = splitAt(a, 100);
    const undone = h.undo(b)!;
    expect(undone.tracks[0].clips).toHaveLength(1);
    const redone = h.redo(undone)!;
    expect(redone.tracks[0].clips).toHaveLength(2);
  });

  it('normalises partial project files', () => {
    const p = normalizeProject({ name: 'X', tracks: [{ name: 'T', clips: [{ id: 'c', file: 'f', start: 0, length: 5 }] }] } as never);
    expect(p.tracks[0].id).toBeTruthy();
    expect(p.tracks[0].clips[0].gain).toBe(0);
    expect(p.metadata.title).toBe('X');
  });
});

describe('prepare for editing', () => {
  it('unarms every track and keeps everything else', () => {
    let p = setup();
    p = { ...p, tracks: p.tracks.map((t, i) => ({ ...t, armed: true, mute: i === 1 })) };
    const q = prepareForEditing(p);
    expect(q.tracks.map((t) => t.armed)).toEqual([false, false]);
    expect(q.tracks.map((t) => t.mute)).toEqual([false, true]);
    expect(q.tracks[0].clips).toEqual(p.tracks[0].clips);
    expect(p.tracks[0].armed).toBe(true); // input not mutated
  });

  it('returns the same project when nothing is armed', () => {
    const p = setup();
    expect(prepareForEditing(p)).toBe(p);
  });
});
