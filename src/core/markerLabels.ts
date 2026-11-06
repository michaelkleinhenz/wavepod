// Timeline marker labels: each label gets the room up to the next marker and is cut with an ellipsis when it doesn't fit.

export interface LabelInput {
  id: string;
  /** Marker x on screen, in px. */
  x: number;
  title: string;
}

export interface LabelLayout {
  id: string;
  /** Where the label text starts. */
  x: number;
  /** The text to draw: the title, shortened, or '' when there is no room. */
  text: string;
  /** Drawn width of `text`. */
  width: number;
  truncated: boolean;
  /** Space the label may use, in px (Infinity for the last one without a limit). */
  room: number;
}

export const ELLIPSIS = '…';

/** Longest prefix of `text` plus an ellipsis that fits in `maxWidth`, or the whole text when it fits. '' when not even one letter fits. */
export function fitText(text: string, maxWidth: number, measure: (s: string) => number): string {
  if (measure(text) <= maxWidth) return text;
  if (measure(ELLIPSIS) > maxWidth) return '';
  // binary search the longest prefix that fits with the ellipsis
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(text.slice(0, mid).trimEnd() + ELLIPSIS) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  if (lo === 0) return '';
  return text.slice(0, lo).trimEnd() + ELLIPSIS;
}

/**
 * Lays out marker labels so they never run into the next marker. `offset` is the gap from the marker line to its
 * text (past the flag), `gap` the space kept free before the next marker, `limit` the right edge for the last label.
 */
export function layoutMarkerLabels(
  markers: LabelInput[],
  measure: (s: string) => number,
  opts: { offset: number; gap: number; limit?: number },
): LabelLayout[] {
  const sorted = [...markers].sort((a, b) => a.x - b.x);
  return sorted.map((m, i) => {
    const x = m.x + opts.offset;
    const next = i + 1 < sorted.length ? sorted[i + 1].x : (opts.limit ?? Infinity);
    const room = next - x - opts.gap;
    const text = room > 0 ? fitText(m.title, room, measure) : '';
    return { id: m.id, x, text, width: text ? measure(text) : 0, truncated: text !== m.title, room };
  });
}
