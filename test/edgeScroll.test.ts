import { describe, expect, it } from 'vitest';
import { EDGE_ZONE_PX, edgeScrollSpeed } from '../src/core/edgeScroll';

describe('edgeScrollSpeed', () => {
  it('does not scroll away from the edges', () => {
    expect(edgeScrollSpeed(EDGE_ZONE_PX, 800)).toBe(0);
    expect(edgeScrollSpeed(400, 800)).toBe(0);
    expect(edgeScrollSpeed(800 - EDGE_ZONE_PX, 800)).toBe(0);
  });

  it('scrolls towards the edge the mouse is near', () => {
    expect(edgeScrollSpeed(5, 800)).toBeLessThan(0);
    expect(edgeScrollSpeed(795, 800)).toBeGreaterThan(0);
  });

  it('scrolls faster the further past the edge the mouse is, up to a limit', () => {
    const near = edgeScrollSpeed(10, 800);
    const out = edgeScrollSpeed(-50, 800);
    const far = edgeScrollSpeed(-5000, 800);
    expect(out).toBeLessThan(near);
    expect(far).toBeLessThanOrEqual(out);
    expect(edgeScrollSpeed(-10000, 800)).toBe(far);
    expect(edgeScrollSpeed(850, 800)).toBe(-out);
  });

  it('keeps a usable middle in a small view', () => {
    expect(edgeScrollSpeed(30, 60)).toBe(0);
    expect(edgeScrollSpeed(2, 60)).toBeLessThan(0);
  });
});
