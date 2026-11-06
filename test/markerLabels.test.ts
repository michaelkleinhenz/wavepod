import { describe, expect, it } from 'vitest';
import { ELLIPSIS, fitText, layoutMarkerLabels } from '../src/core/markerLabels';

// every character is 6px wide
const measure = (s: string) => [...s].length * 6;

describe('fitText', () => {
  it('keeps text that fits', () => {
    expect(fitText('Intro', 30, measure)).toBe('Intro');
  });
  it('cuts with an ellipsis', () => {
    expect(fitText('Interview with guest', 36, measure)).toBe(`Inter${ELLIPSIS}`);
  });
  it('drops trailing spaces before the ellipsis', () => {
    expect(fitText('Big news today', 30, measure)).toBe(`Big${ELLIPSIS}`);
  });
  it('gives nothing when not even one letter fits', () => {
    expect(fitText('Intro', 8, measure)).toBe('');
  });
});

describe('layoutMarkerLabels', () => {
  const opts = { offset: 11, gap: 4 };
  it('stops each label before the next marker', () => {
    const out = layoutMarkerLabels(
      [
        { id: 'b', x: 100, title: 'Second chapter with a long name' },
        { id: 'a', x: 0, title: 'First chapter with a long name' },
        { id: 'c', x: 400, title: 'Last' },
      ],
      measure,
      opts,
    );
    expect(out.map((l) => l.id)).toEqual(['a', 'b', 'c']);
    for (let i = 0; i < out.length - 1; i++) expect(out[i].x + out[i].width).toBeLessThanOrEqual(out[i + 1].x - opts.offset - opts.gap);
    expect(out[0].truncated).toBe(true);
    expect(out[0].text.endsWith(ELLIPSIS)).toBe(true);
    expect(out[1].text).toBe('Second chapter with a long name');
    expect(out[2]).toMatchObject({ text: 'Last', truncated: false, x: 411 });
  });
  it('hides labels of markers on top of each other', () => {
    const out = layoutMarkerLabels(
      [
        { id: 'a', x: 50, title: 'One' },
        { id: 'b', x: 52, title: 'Two' },
      ],
      measure,
      opts,
    );
    expect(out[0]).toMatchObject({ text: '', truncated: true });
    expect(out[1].text).toBe('Two');
  });
  it('cuts the last label at the limit', () => {
    const [l] = layoutMarkerLabels([{ id: 'a', x: 0, title: 'A rather long title' }], measure, { ...opts, limit: 60 });
    expect(l.x + l.width).toBeLessThanOrEqual(56);
    expect(l.truncated).toBe(true);
  });
});
