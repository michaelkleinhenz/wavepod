// Applying an alignment (see core/align.ts, which measures it) to the project: pure, so the
// renderer can make it one undo step.
import type { Clip, FileTranscript, Project } from '../shared/types';

/** Below this match quality the result is reported as weak. */
export const WEAK_CONFIDENCE = 0.3;

export interface AlignResult {
  /**
   * How far the clips move (frames, + = later) at `anchor`; with drift, a point at timeline frame
   * t moves by shift + drift · (t − anchor).
   */
  shift: number;
  /** Timeline frame (before the move) where `shift` was measured. */
  anchor: number;
  /** Clock drift: the moving audio has to be stretched by 1 + drift (0 when there is none to fix). */
  drift: number;
  /** Match quality 0..1: the share of windows that agree (or, for short clips, how clear the match is). */
  confidence: number;
  /** Fine windows that agreed with the result, out of the ones measured. */
  windows: number;
  measured: number;
  /** Seconds of audio the two tracks share once aligned. */
  overlapSeconds: number;
}

/** What the app gets back: the result, plus the drift-corrected copies made of the moving files. */
export interface AlignOutcome extends AlignResult {
  /** Old file → stretched copy, for clips that switch to a copy (empty without drift). */
  files: Record<string, string>;
}

/** Where timeline frame `t` (before the move) ends up. */
export function alignedPosition(r: Pick<AlignResult, 'shift' | 'anchor' | 'drift'>, t: number): number {
  return t + r.shift + r.drift * (t - r.anchor);
}

/**
 * Moves the clips as `r` says, as one edit. With drift, clips whose file was resampled (`files`:
 * old file → stretched copy) switch to the copy, and their offsets, lengths, fades and volume lines
 * stretch with it; other clips just move by what the drift is at their middle. Audio that would
 * land before the timeline start is trimmed off.
 */
export function applyAlignment(project: Project, clipIds: string[], r: Pick<AlignResult, 'shift' | 'anchor' | 'drift'>, files: Record<string, string> = {}): Project {
  const s = 1 + r.drift;
  return {
    ...project,
    tracks: project.tracks.map((t) => {
      if (!t.clips.some((c) => clipIds.includes(c.id))) return t;
      return {
        ...t,
        clips: t.clips.map((c): Clip => {
          if (!clipIds.includes(c.id)) return c;
          let out: Clip;
          const copy = r.drift !== 0 && !c.sound ? files[c.file] : undefined;
          if (copy) {
            out = {
              ...c,
              file: copy,
              start: Math.round(alignedPosition(r, c.start)),
              offset: Math.round(c.offset * s),
              length: Math.max(1, Math.round(c.length * s)),
              fadeIn: Math.round(c.fadeIn * s),
              fadeOut: Math.round(c.fadeOut * s),
              ...(c.envelope ? { envelope: c.envelope.map((p) => ({ ...p, pos: Math.round(p.pos * s) })) } : {}),
            };
          } else {
            const mid = c.start + c.length / 2;
            out = { ...c, start: Math.round(alignedPosition(r, mid) - c.length / 2) };
          }
          if (out.start < 0) {
            const cut = -out.start;
            if (cut >= out.length) return { ...out, start: 0, length: 1 };
            out = { ...out, start: 0, offset: out.offset + cut, length: out.length - cut, fadeIn: Math.max(0, out.fadeIn - cut) };
          }
          return out;
        }),
      };
    }),
  };
}

/** A free name for the drift-corrected copy of `file`, next to it: "media/Guest-synced.wav". */
export function syncedFileName(file: string, exists: (f: string) => boolean): string {
  const slash = file.replace(/\\/g, '/');
  const cutAt = slash.lastIndexOf('/');
  const dirName = cutAt < 0 ? '.' : slash.slice(0, cutAt);
  const base = slash.slice(cutAt + 1).replace(/\.[^.]+$/, '').replace(/-synced(-\d+)?$/, '');
  const join = (name: string) => (dirName === '.' ? name : `${dirName}/${name}`);
  let name = join(`${base}-synced.wav`);
  for (let i = 2; exists(name); i++) name = join(`${base}-synced-${i}.wav`);
  return name;
}

/** The transcript of a stretched copy: word and sound times (and the level curve) stretched along. */
export function stretchTranscript(t: FileTranscript, file: string, stretch: number): FileTranscript {
  const words = (ws: FileTranscript['words']) => ws.map((w) => ({ ...w, start: Math.round(w.start * stretch), end: Math.round(w.end * stretch) }));
  return {
    ...t,
    file,
    words: words(t.words),
    ...(t.events ? { events: words(t.events) } : {}),
    ...(t.levels ? { levels: { ...t.levels, step: t.levels.step * stretch } } : {}),
  };
}
