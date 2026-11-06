// Fades as they sound: a clip's own fades, widened into an equal-power crossfade where it overlaps
// the next clip on the same track.
import type { Clip, FadeShape, Track } from '../shared/types';
import { fadeCurve, fadeGain } from './dsp';

/**
 * Length of the automatic declick at hard clip edges. A cut (a deleted transcript word, a ripple
 * cut, a split with a gap) almost never lands where the waveform crosses zero, so butting two clips
 * together leaves a step in the signal that is heard as a click even though no peak shows. Each
 * such edge gets this short equal-power fade; where the next clip starts right at a clip's end,
 * the earlier clip plays on past its end for this long instead, so the joint is a real crossfade
 * and not a dip.
 */
export const DECLICK_SECONDS = 0.005;

export interface EffectiveFades {
  fadeIn: number;
  fadeOut: number;
  inShape: FadeShape;
  outShape: FadeShape;
  /** The fade comes (at least partly) from an overlap with a neighbouring clip. */
  autoIn: boolean;
  autoOut: boolean;
  /** Automatic declick fades (frames) at hard edges; heard, never drawn as fade handles. */
  declickIn: number;
  declickOut: number;
  /** Frames the clip keeps playing past its end, fading out under the clip that starts there. */
  tail: number;
}

export function ownFades(clip: Clip): EffectiveFades {
  return {
    fadeIn: clip.fadeIn,
    fadeOut: clip.fadeOut,
    inShape: clip.fadeInShape ?? 'linear',
    outShape: clip.fadeOutShape ?? 'linear',
    autoIn: false,
    autoOut: false,
    declickIn: 0,
    declickOut: 0,
    tail: 0,
  };
}

/** True when `b` simply continues `a` (as after a split): same file, same gain, no jump in the source. */
export function isSeamless(a: Clip, b: Clip): boolean {
  return (
    a.start + a.length === b.start &&
    a.file === b.file &&
    !a.sound &&
    !b.sound &&
    a.offset + a.length === b.offset &&
    a.gain === b.gain &&
    !a.fx?.some((f) => f.enabled) &&
    !b.fx?.some((f) => f.enabled)
  );
}

/**
 * Fades of every clip on a track, by clip id. Where a clip starts inside the previous one (and
 * ends after it), both fade over the overlap with equal-power curves, so the joint keeps its
 * loudness. A clip lying completely inside another one is left alone (it plays on top).
 *
 * With `declick` (frames) every edge that has no fade and does not simply continue its neighbour
 * gets a short declick fade (see DECLICK_SECONDS). The very start and end of a file are no cuts and
 * stay as they are. `sourceFrames` gives the length of a clip's file (default: unknown, endless).
 */
export function trackFades(track: Track, declick = 0, sourceFrames: (c: Clip) => number = () => Infinity): Map<string, EffectiveFades> {
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
  if (declick > 0) addDeclicks(sorted, out, declick, sourceFrames);
  return out;
}

function addDeclicks(sorted: Clip[], out: Map<string, EffectiveFades>, declick: number, sourceFrames: (c: Clip) => number): void {
  // clips by start and by end, to find what butts against an edge
  const byStart = new Map<number, Clip[]>();
  const byEnd = new Map<number, Clip[]>();
  for (const c of sorted) {
    if (c.length <= 0) continue;
    byStart.set(c.start, [...(byStart.get(c.start) ?? []), c]);
    byEnd.set(c.start + c.length, [...(byEnd.get(c.start + c.length) ?? []), c]);
  }
  for (const c of sorted) {
    if (c.length <= 0) continue;
    const f = out.get(c.id)!;
    const end = c.start + c.length;
    const before = byEnd.get(c.start) ?? [];
    const after = (byStart.get(end) ?? []).filter((n) => n !== c);
    // where a plain clip starts or ends with its file, nothing was cut
    const fileStart = !c.sound && c.offset === 0;
    const left = c.sound ? 0 : sourceFrames(c) - (c.offset + c.length);
    if (f.fadeIn === 0 && !fileStart && !before.some((p) => isSeamless(p, c))) f.declickIn = Math.min(declick, Math.floor(c.length / 2));
    if (f.fadeOut === 0 && !(left <= 0 && !c.sound) && !after.some((n) => isSeamless(c, n))) {
      // butted against the next clip: play on under its declick fade-in (a crossfade); else fade out in place
      const next = after.find((n) => out.get(n.id)!.fadeIn === 0);
      if (next && left >= declick) f.tail = Math.min(declick, Math.floor(next.length / 2));
      else f.declickOut = Math.min(declick, Math.floor(c.length / 2));
    }
  }
  // a tail and the fade-in it crosses must be the same length to keep the power constant
  for (const c of sorted) {
    const f = out.get(c.id)!;
    if (!f.tail) continue;
    const next = (byStart.get(c.start + c.length) ?? []).find((n) => n !== c && out.get(n.id)!.fadeIn === 0);
    if (next) out.get(next.id)!.declickIn = f.tail;
  }
}

/** Fade gain at clip-relative position `rel` (from `length` on: the declick tail, if any). */
export function fadesAt(f: EffectiveFades, length: number, rel: number): number {
  if (rel >= length) return f.tail > 0 && rel < length + f.tail ? fadeCurve(1 - (rel - length) / f.tail, 'equalPower') : 0;
  let g = f.fadeIn === 0 && f.fadeOut === 0 ? 1 : fadeGain(rel, length, f.fadeIn, f.fadeOut, f.inShape, f.outShape);
  if (f.declickIn > 0 && rel < f.declickIn) g *= fadeCurve(rel / f.declickIn, 'equalPower');
  if (f.declickOut > 0 && rel > length - f.declickOut) g *= fadeCurve((length - rel) / f.declickOut, 'equalPower');
  return g;
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
