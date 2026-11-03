import { describe, expect, it } from 'vitest';
import { clipEdges, markerPositions, selectionSpan, stepTo } from '../src/core/navigation';
import { addMarker, addTrack, createProject } from '../src/core/project';

function project() {
  let p = createProject('N', 1000);
  p = addTrack(p, { name: 'A' });
  p = addTrack(p, { name: 'B' });
  const clip = (id: string, start: number, length: number) => ({ id, file: 'x.wav', start, offset: 0, length, gain: 0, fadeIn: 0, fadeOut: 0 });
  p.tracks[0].clips.push(clip('a1', 0, 1000), clip('a2', 1500, 500));
  p.tracks[1].clips.push(clip('b1', 1000, 2000));
  p = addMarker(p, 1200, 'chapter', 'C').project;
  p = addMarker(p, 2500, 'edit', 'E').project;
  return p;
}

describe('navigation', () => {
  it('collects clip edges across tracks without duplicates', () => {
    expect(clipEdges(project())).toEqual([0, 1000, 1500, 2000, 3000]);
  });

  it('collects marker positions, optionally by kind', () => {
    expect(markerPositions(project())).toEqual([1200, 2500]);
    expect(markerPositions(project(), 'edit')).toEqual([2500]);
  });

  it('steps to the next and previous position, with slack around the playhead', () => {
    const e = clipEdges(project());
    expect(stepTo(e, 1000, 1)).toBe(1500);
    expect(stepTo(e, 1000, -1)).toBe(0);
    expect(stepTo(e, 1498, 1, 5)).toBe(2000);
    expect(stepTo(e, 3000, 1)).toBeNull();
    expect(stepTo(e, 0, -1)).toBeNull();
  });

  it('zooms to a time range, or to the span of the selected clips', () => {
    const p = project();
    expect(selectionSpan(p, [100, 400], new Set())).toEqual([100, 400]);
    expect(selectionSpan(p, null, new Set(['a2', 'b1']))).toEqual([1000, 3000]);
    expect(selectionSpan(p, [5, 5], new Set())).toBeNull();
  });
});
