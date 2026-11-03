import { describe, expect, it } from 'vitest';
import { markersCrossed, pingTone } from '../src/core/markerPing';
import type { Marker } from '../src/shared/types';

const m = (id: string, position: number, kind: Marker['kind'] = 'chapter'): Marker => ({ id, kind, position, title: id });

describe('marker ping', () => {
  it('finds markers passed in a block, start inclusive, end exclusive', () => {
    const ms = [m('a', 100), m('b', 200), m('c', 300)];
    expect(markersCrossed(ms, 0, 100)).toEqual([]);
    expect(markersCrossed(ms, 100, 201).map((x) => x.id)).toEqual(['a', 'b']);
    expect(markersCrossed(ms, 300, 300)).toEqual([]);
    expect(markersCrossed(ms, 400, 100)).toEqual([]);
  });

  it('is short and quiet, and starts and ends silent', () => {
    const t = pingTone(48000);
    expect(t.length).toBe(3840);
    expect(Math.max(...t.map(Math.abs))).toBeLessThanOrEqual(0.25);
    expect(Math.abs(t[0])).toBeLessThan(1e-6);
    expect(Math.abs(t[t.length - 1])).toBeLessThan(1e-3);
  });
});
