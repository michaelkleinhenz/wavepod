import { describe, expect, it } from 'vitest';
import { addMarker, createProject, moveChapterContent } from '../src/core/project';
import type { Project } from '../src/shared/types';

function setup(): { p: Project; ids: string[] } {
  let p = createProject('Ep', 48000);
  const ids: string[] = [];
  for (const [sec, title] of [[0, 'A'], [10, 'B'], [20, 'C'], [30, 'D']] as const) {
    const r = addMarker(p, sec * 48000, 'chapter', title);
    p = r.project;
    ids.push(r.marker.id);
  }
  p = addMarker(p, 15 * 48000, 'edit', 'cough').project;
  p.markers.find((m) => m.title === 'A')!.url = 'https://a.example';
  p.markers.find((m) => m.title === 'C')!.image = 'images/c.png';
  return { p, ids };
}

const content = (p: Project) =>
  p.markers.filter((m) => m.kind === 'chapter').map((m) => ({ pos: m.position / 48000, title: m.title, url: m.url, image: m.image }));

describe('moveChapterContent', () => {
  it('moves content down and shifts the rest up, times unchanged', () => {
    const { p, ids } = setup();
    const out = moveChapterContent(p, ids[0], ids[2]);
    expect(content(out)).toEqual([
      { pos: 0, title: 'B', url: undefined, image: undefined },
      { pos: 10, title: 'C', url: undefined, image: 'images/c.png' },
      { pos: 20, title: 'A', url: 'https://a.example', image: undefined },
      { pos: 30, title: 'D', url: undefined, image: undefined },
    ]);
    expect(out.markers.find((m) => m.kind === 'chapter' && m.position === 0)).not.toHaveProperty('url');
    // edit markers untouched, ids stay with their positions
    expect(out.markers.find((m) => m.kind === 'edit')!.title).toBe('cough');
    expect(out.markers.filter((m) => m.kind === 'chapter').map((m) => m.id)).toEqual(ids);
  });

  it('moves content up (adjacent swap)', () => {
    const { p, ids } = setup();
    const out = moveChapterContent(p, ids[3], ids[2]);
    expect(content(out).map((c) => c.title)).toEqual(['A', 'B', 'D', 'C']);
    expect(content(out)[3].image).toBe('images/c.png');
  });

  it('does not change the original project and ignores unknown ids', () => {
    const { p, ids } = setup();
    moveChapterContent(p, ids[0], ids[3]);
    expect(content(p).map((c) => c.title)).toEqual(['A', 'B', 'C', 'D']);
    expect(content(moveChapterContent(p, 'nope', ids[1])).map((c) => c.title)).toEqual(['A', 'B', 'C', 'D']);
  });
});
