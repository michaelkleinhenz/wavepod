// Fades as they sound: a clip's own fades, widened into an equal-power crossfade where it overlaps
// the next clip on the same track.
import type { Clip, FadeShape, Track } from '../shared/types';
import { fadeGain } from './dsp';

export interface EffectiveFades {
  fadeIn: number;
  fadeOut: number;
  inShape: FadeShape;
  outShape: FadeShape;
  /** The fade comes (at least partly) from an overlap with a neighbouring clip. */
  autoIn: boolean;
  autoOut: boolean;
}

export function ownFades(clip: Clip): EffectiveFades {
  return {
    fadeIn: clip.fadeIn,
    fadeOut: clip.fadeOut,
    inShape: clip.fadeInShape ?? 'linear',
    outShape: clip.fadeOutShape ?? 'linear',
    autoIn: false,
    autoOut: false,
  };
}

/**
 * Fades of every clip on a track, by clip id. Where a clip starts inside the previous one (and
 * ends after it), both fade over the overlap with equal-power curves, so the joint keeps its
 * loudness. A clip lying completely inside another one is left alone (it plays on top).
 */
export function trackFades(track: Track): Map<string, EffectiveFades> {
  const out = new Map<string, EffectiveFades>();
  for (const c of track.clips) out.set(c.id, ownFades(c));
  const sorted = [...track.clips].sort((a, b) => a.start - b.start || a.length - b.length);
  for (let i = 1; i < sorted.length; i++) {
    const b = sorted[i];
    // the clip before b that reaches furthest into it
    let a: Clip | null = null;
    for (let k = i - 1; k >= 0; k--) {
      const c = sorted[k];
      if (c.start + c.length > b.start && (!a || c.start + c.length > a.start + a.length)) a = c;
    }
    if (!a) continue;
    const aEnd = a.start + a.length;
    const bEnd = b.start + b.length;
    if (bEnd <= aEnd || b.start <= a.start) continue;
    const overlap = aEnd - b.start;
    const fa = out.get(a.id)!;
    const fb = out.get(b.id)!;
    if (overlap > fa.fadeOut) Object.assign(fa, { fadeOut: Math.min(overlap, a.length - fa.fadeIn), outShape: 'equalPower', autoOut: true });
    if (overlap > fb.fadeIn) Object.assign(fb, { fadeIn: Math.min(overlap, b.length - fb.fadeOut), inShape: 'equalPower', autoIn: true });
  }
  return out;
}

/** Fade gain at clip-relative position `rel`. */
export function fadesAt(f: EffectiveFades, length: number, rel: number): number {
  if (f.fadeIn === 0 && f.fadeOut === 0) return 1;
  return fadeGain(rel, length, f.fadeIn, f.fadeOut, f.inShape, f.outShape);
}

export interface OverlapSpan {
  from: number;
  to: number;
  /** Indices (into the clips passed in) of every clip that plays in this span, in order. */
  clips: number[];
}

/**
 * The stretches of a track where two or more clips play at once, split wherever a clip starts
 * or ends, so each span has one fixed set of clips. The timeline draws these see-through.
 */
export function overlapSpans(clips: ReadonlyArray<Pick<Clip, 'start' | 'length'>>): OverlapSpan[] {
  const edges = [...new Set(clips.flatMap((c) => [c.start, c.start + c.length]))].sort((a, b) => a - b);
  const out: OverlapSpan[] = [];
  for (let k = 1; k < edges.length; k++) {
    const from = edges[k - 1];
    const to = edges[k];
    const inside: number[] = [];
    clips.forEach((c, i) => {
      if (c.length > 0 && c.start <= from && c.start + c.length >= to) inside.push(i);
    });
    if (inside.length < 2) continue;
    const last = out[out.length - 1];
    if (last && last.to === from && last.clips.join() === inside.join()) last.to = to;
    else out.push({ from, to, clips: inside });
  }
  return out;
}
