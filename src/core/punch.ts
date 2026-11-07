// Punch-in recording: re-record one line inside existing audio. Playback starts a few seconds
// before the punch range (pre-roll) so the speaker hears the lead-in, the take only replaces the
// audio inside the range, and a short post-roll lets the line ring out. The whole pass is written
// to the file, so the new clip has handles: its edges can be dragged out again afterwards.
import type { Clip, Frames, Project } from '../shared/types';
import { uid } from '../shared/time';
import { recordTake } from './takes';

/** Overlap at each punch edge: the new take and the old audio crossfade (equal power) over it. */
export const PUNCH_CROSSFADE_SECONDS = 0.02;
export const DEFAULT_PRE_ROLL_SECONDS = 3;
export const DEFAULT_POST_ROLL_SECONDS = 1;
export const MAX_PRE_ROLL_SECONDS = 30;
export const MAX_POST_ROLL_SECONDS = 10;

/** What the renderer asks for: the range to replace and how much to play around it (all frames). */
export interface PunchRequest {
  start: Frames;
  end: Frames;
  preRoll: Frames;
  postRoll: Frames;
}

/** A punch pass as the engine runs it. */
export interface PunchPlan {
  /** Where playback and the take's file start (punch-in minus pre-roll, not before 0). */
  from: Frames;
  /** Punch-in and punch-out: the part of the timeline the take replaces. */
  in: Frames;
  out: Frames;
  /** Where the pass stops by itself (punch-out plus post-roll). */
  until: Frames;
}

/** Turns a request into a plan; throws when the range is empty. */
export function punchPlan(req: PunchRequest): PunchPlan {
  const start = Math.max(0, Math.round(Math.min(req.start, req.end)));
  const end = Math.round(Math.max(req.start, req.end));
  if (!(end > start)) throw new Error('Select the time range to re-record first.');
  const pre = Math.max(0, Math.round(req.preRoll) || 0);
  const post = Math.max(0, Math.round(req.postRoll) || 0);
  return { from: Math.max(0, start - pre), in: start, out: end, until: end + post };
}

/** Clamps pre-roll / post-roll seconds to what the settings allow. */
export function clampRoll(seconds: unknown, fallback: number, max: number): number {
  const v = Number(seconds);
  if (!Number.isFinite(v)) return fallback;
  return Math.round(Math.max(0, Math.min(max, v)) * 10) / 10;
}

/**
 * The clip a punch take becomes: the range [in, out) of the file (cut short when the pass was
 * stopped early), widened by up to PUNCH_CROSSFADE_SECONDS on each side where the file has audio
 * there, so it overlaps the old audio and crossfades into it. Null when the pass was stopped
 * before the punch-in (nothing was replaced).
 */
export function punchTakeClip(
  take: { file: string; recordStart: Frames; frames: Frames },
  punch: { in: Frames; out: Frames },
  sampleRate: number,
): { clip: Clip; range: [Frames, Frames] } | null {
  const recordedEnd = take.recordStart + take.frames;
  const a = Math.max(punch.in, take.recordStart);
  const b = Math.min(punch.out, recordedEnd);
  if (!(b > a)) return null;
  const xf = Math.round(PUNCH_CROSSFADE_SECONDS * sampleRate);
  const left = Math.min(xf, a - take.recordStart);
  const right = Math.min(xf, recordedEnd - b);
  const start = a - left;
  return {
    range: [a, b],
    clip: {
      id: uid('clp'),
      file: take.file,
      start,
      offset: start - take.recordStart,
      length: b + right - start,
      gain: 0,
      fadeIn: 0,
      fadeOut: 0,
    },
  };
}

/**
 * Puts a punch take on its track as a new take (see core/takes.ts recordTake): what was under it
 * is kept as a take of its own, so it can be picked again, and the new take plays. Comping cuts the
 * old audio at the clip's edges; where the old audio simply ran on there, the neighbours are
 * stretched back to the punch range, so they overlap the new clip's 20 ms handles and the mixer
 * crossfades them (equal power) instead of butting them together.
 */
export function mergePunchTake(project: Project, trackId: string, clip: Clip, range: [Frames, Frames]): Project {
  const before = project.tracks.find((t) => t.id === trackId)?.clips ?? [];
  const p = recordTake(project, trackId, clip);
  const t = p.tracks.find((x) => x.id === trackId);
  if (!t || p === project) return p;
  const [a, b] = range;
  const s = clip.start;
  const e = clip.start + clip.length;
  // the old clip that played continuously over [from, to), in the same source frames as `c`
  const ranOn = (c: Clip, from: Frames, to: Frames) =>
    before.some((o) => o.file === c.file && !o.sound && !c.sound && o.offset - o.start === c.offset - c.start && o.start <= from && o.start + o.length >= to);
  t.clips = t.clips.map((c) => {
    if (c.file === clip.file) return c; // the new take itself
    if (a > s && c.start + c.length === s && c.start < s && ranOn(c, c.start, a)) return { ...c, length: a - c.start };
    if (e > b && c.start === e && ranOn(c, b, c.start + c.length)) return { ...c, start: b, offset: c.offset - (e - b), length: c.length + (e - b) };
    return c;
  });
  t.clips.sort((x, y) => x.start - y.start);
  return p;
}
