// Punch-in recording: re-record one line inside existing audio. Playback starts a few seconds
// before the punch range (pre-roll) so the speaker hears the lead-in, the take only replaces the
// audio inside the range, and a short post-roll lets the line ring out. The whole pass is written
// to the file, so the new clip has handles: its edges can be dragged out again afterwards.
import type { Clip, Frames, Project } from '../shared/types';
import { uid } from '../shared/time';
import { splitAt } from './project';

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
 * Puts a punch take on its track: the old clips are cut at the range edges, what lay inside the
 * range goes, and the new clip takes its place. Where the new clip reaches past the range it
 * overlaps the old audio, which the mixer turns into an equal-power crossfade.
 */
export function punchInClip(project: Project, trackId: string, clip: Clip, range: [Frames, Frames]): Project {
  const [a, b] = range;
  const p = splitAt(splitAt(project, a, [trackId]), b, [trackId]);
  const t = p.tracks.find((x) => x.id === trackId);
  if (!t) return p;
  t.clips = t.clips.filter((c) => !(c.start >= a && c.start + c.length <= b));
  t.clips.push(clip);
  t.clips.sort((x, y) => x.start - y.start);
  return p;
}
