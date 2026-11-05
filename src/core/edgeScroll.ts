// Edge autoscroll while dragging on the timeline, as in Reaper: when the mouse comes near an edge of
// the view (or leaves it), the view scrolls that way, faster the further out the mouse is, so a clip
// can be carried to any point of the episode in one drag.

/** Distance from the edge, inside the view, where scrolling starts (the mouse can't leave a maximised window). */
export const EDGE_ZONE_PX = 24;
/** Slowest scroll speed, in pixels per second, right at the start of the zone. */
const MIN_SPEED = 120;
/** Speed added per pixel the mouse is further into the zone or past the edge. */
const SPEED_PER_PX = 40;
/** Fastest scroll speed, in pixels per second. */
const MAX_SPEED = 6000;

/**
 * Scroll speed in pixels per second for a mouse at `pos` in a view `size` pixels long (both along
 * one axis): negative towards the start, positive towards the end, 0 when not near an edge.
 */
export function edgeScrollSpeed(pos: number, size: number, zone = EDGE_ZONE_PX): number {
  if (size <= zone * 3) zone = Math.max(1, size / 4);
  const into = pos < zone ? zone - pos : pos > size - zone ? pos - (size - zone) : 0;
  if (into <= 0) return 0;
  const speed = Math.min(MAX_SPEED, MIN_SPEED + into * SPEED_PER_PX);
  return pos < zone ? -speed : speed;
}
