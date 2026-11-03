import { describe, expect, it } from 'vitest';
import { copyClips, copyRange, pasteClipboard } from '../src/core/clipboard';
import { addMarker, addTrack, createProject } from '../src/core/project';
import type { Clip } from '../src/shared/types';

const clip = (id: string, start: number, length: number, extra: Partial<Clip> = {}): Clip => ({
  id, file: `${id}.wav`, start, offset: 0, length, gain: 0, fadeIn: 0, fadeOut: 0, ...extra,
});

function project() {
  let p = createProject('C', 1000);
  p = addTrack(p, { name: 'A' });
  p = addTrack(p, { name: 'B' });
  p.tracks[0].clips.push(clip('a1', 0, 1000, { fadeIn: 100, fadeOut: 100 }), clip('a2', 2000, 500));
  p.tracks[1].clips.push(clip('b1', 500, 2000));
  p.tracks[1].muteRegions = [[800, 900]];
  p = addMarker(p, 2200, 'chapter', 'Later').project;
  return p;
}

describe('clipboard', () => {
  it('copies a range as slices with offsets, keeping only real clip edges’ fades', () => {
    const p = project();
    const d = copyRange(p, 800, 2100, p.tracks.map((t) => t.id))!;
    expect(d.length).toBe(1300);
    const byId = Object.fromEntries(d.items.map((i) => [i.clip.id, i.clip]));
    expect(byId.a1).toMatchObject({ start: 0, offset: 800, length: 200, fadeIn: 0, fadeOut: 100 });
    expect(byId.a2).toMatchObject({ start: 1200, offset: 0, length: 100, fadeIn: 0 });
    expect(byId.b1).toMatchObject({ start: 0, offset: 300, length: 1300 });
    expect(d.muteRegions).toEqual([{ trackId: p.tracks[1].id, trackIndex: 1, region: [0, 100] }]);
  });

  it('copies only the chosen tracks', () => {
    const p = project();
    const d = copyRange(p, 0, 3000, [p.tracks[1].id])!;
    expect(d.items.map((i) => i.clip.id)).toEqual(['b1']);
  });

  it('copies whole clips relative to the first one', () => {
    const p = project();
    const d = copyClips(p, new Set(['a2', 'b1']))!;
    expect(d.length).toBe(2000);
    expect(d.items.map((i) => [i.clip.id, i.clip.start])).toEqual([['a2', 1500], ['b1', 0]]);
  });

  it('pastes on top at the playhead with new ids', () => {
    const p = project();
    const d = copyClips(p, new Set(['a2']))!;
    const r = pasteClipboard(p, d, 5000, false);
    expect(r.clipIds).toHaveLength(1);
    const pasted = r.project.tracks[0].clips.find((c) => c.id === r.clipIds[0])!;
    expect(pasted).toMatchObject({ start: 5000, file: 'a2.wav', length: 500 });
    // everything else stays put
    expect(r.project.tracks[0].clips.find((c) => c.id === 'a2')!.start).toBe(2000);
    expect(r.project.markers[0].position).toBe(2200);
  });

  it('ripple-pastes: later material and markers move right by the copied length', () => {
    const p = project();
    const d = copyRange(p, 0, 300, p.tracks.map((t) => t.id))!;
    const r = pasteClipboard(p, d, 1500, true);
    expect(r.project.tracks[0].clips.find((c) => c.id === 'a2')!.start).toBe(2300);
    expect(r.project.markers[0].position).toBe(2500);
    // the clip that spanned the paste point was split around the gap
    const b = r.project.tracks[1].clips.filter((c) => c.file === 'b1.wav' && !r.clipIds.includes(c.id));
    expect(b.map((c) => [c.start, c.length])).toEqual([[500, 1000], [1800, 1000]]);
  });

  it('falls back to the track at the same position when the original track is gone', () => {
    const p = project();
    const d = copyClips(p, new Set(['b1']))!;
    const q = { ...p, tracks: [p.tracks[0], { ...p.tracks[1], id: 'other' }] };
    const r = pasteClipboard(q, d, 0, false);
    expect(r.project.tracks[1].clips.some((c) => c.id === r.clipIds[0])).toBe(true);
  });
});
