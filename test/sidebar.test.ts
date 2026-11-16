import { describe, expect, it } from 'vitest';
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH, TIMELINE_MIN_WIDTH, clampSidebarWidth, sidebarMaxWidth } from '../src/renderer/sidebar';

describe('sidebar width', () => {
  it('keeps the dragged width between the minimum and what leaves the timeline room', () => {
    expect(clampSidebarWidth(500, 1440)).toBe(500);
    expect(clampSidebarWidth(100, 1440)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(5000, 1440)).toBe(1440 - TIMELINE_MIN_WIDTH);
    expect(clampSidebarWidth(412.6, 1440)).toBe(413);
  });

  it('falls back to the default for a broken remembered width', () => {
    expect(clampSidebarWidth(Number('abc'), 1440)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it('never goes below the minimum in a small window', () => {
    expect(sidebarMaxWidth(500)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(400, 500)).toBe(SIDEBAR_MIN_WIDTH);
  });
});
