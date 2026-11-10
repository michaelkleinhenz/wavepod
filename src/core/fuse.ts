// Fuse: joins neighbouring clips on one track into a single clip. Clips that simply continue each
// other (as after a split) are joined without touching any audio; anything else (other files, gain
// steps, fades and crossfades between them, sound design, filters) is rendered into a new file.
import type { Clip, EnvelopePoint, FileTranscript, Frames, Project, Track, TranscriptWord } from '../shared/types';
import { uid } from '../shared/time';
import { isSeamless } from './crossfade';
import { envelopeDbAt, isUnityEnvelope } from './envelope';
import { subtractSpans, unionSpans } from './transcript';

export type FuseCheck = { ok: true; track: Track; clips: Clip[]; start: Frames; end: Frames } | { ok: false; reason: string };

const enabledFx = (c: Clip) => (c.fx ?? []).filter((f) => f.enabled);

/**
 * Whether the clips can be fused: at least two, all on one track, and no other clip of that track
 * playing in between (it would end up inside the fused clip). Gaps between them are fine: they
 * become silence in the fused clip. Clips are returned in timeline order.
 */
export function checkFuse(project: Project, ids: Iterable<string>): FuseCheck {
  const set = new Set(ids);
  const tracks = project.tracks.filter((t) => t.clips.some((c) => set.has(c.id)));
  if (!tracks.length) return { ok: false, reason: 'Select the clips to fuse' };
  if (tracks.length > 1) return { ok: false, reason: 'Fuse works on clips of one track' };
  const track = tracks[0];
  const clips = track.clips.filter((c) => set.has(c.id)).sort((a, b) => a.start - b.start || a.length - b.length);
  if (clips.length < 2) return { ok: false, reason: 'Select two or more clips next to each other to fuse them' };
  const start = clips[0].start;
  const end = Math.max(...clips.map((c) => c.start + c.length));
  if (track.clips.some((c) => !set.has(c.id) && c.length > 0 && c.start < end && c.start + c.length > start)) {
    return { ok: false, reason: 'Another clip lies between these clips: select it too, or move it away' };
  }
  return { ok: true, track, clips, start, end };
}

/**
 * What Fuse acts on: the clips, or with a single clip that clip and the one after it on its track
 * (the next one to start), so a lone clip can be fused with its neighbour.
 */
export function fuseTargets(project: Project, ids: Iterable<string>): string[] {
  const list = [...ids];
  if (list.length !== 1) return list;
  const track = project.tracks.find((t) => t.clips.some((c) => c.id === list[0]));
  const clip = track?.clips.find((c) => c.id === list[0]);
  if (!track || !clip) return list;
  const next = track.clips
    .filter((c) => c.id !== clip.id && (c.start > clip.start || (c.start === clip.start && c.length > clip.length)))
    .sort((a, b) => a.start - b.start)[0];
  return next ? [clip.id, next.id] : list;
}

/**
 * True when the clips play one stretch of one file without a break (each one starts where the
 * previous one ends, in the file and on the timeline, with the same gain and no fades or filters
 * between them): fusing them is the opposite of splitting and needs no new audio.
 */
export function isSeamlessFuse(clips: readonly Clip[]): boolean {
  for (let i = 1; i < clips.length; i++) {
    const a = clips[i - 1];
    const b = clips[i];
    if (!isSeamless(a, b) || a.fadeOut || b.fadeIn) return false;
  }
  return clips.length >= 2;
}

/**
 * The volume line of seamless clips joined: each clip's own line over its part of the file
 * (points are in file frames), with a point at either side of every joint so one clip's line does
 * not lean into the next. Undefined when every clip is flat at 0 dB.
 */
function joinEnvelopes(clips: readonly Clip[]): EnvelopePoint[] | undefined {
  if (clips.every((c) => isUnityEnvelope(c.envelope))) return undefined;
  const out: EnvelopePoint[] = [];
  for (const c of clips) {
    const from = c.offset;
    const to = c.offset + c.length - 1;
    const pts = c.envelope ?? [];
    out.push({ pos: from, db: envelopeDbAt(pts, from) });
    for (const p of pts) if (p.pos > from && p.pos < to) out.push({ ...p });
    if (to > from) out.push({ pos: to, db: envelopeDbAt(pts, to) });
  }
  // drop points that change nothing (same value as both neighbours)
  return out.filter((p, i) => i === 0 || i === out.length - 1 || !(out[i - 1].db === p.db && out[i + 1].db === p.db));
}

/** Name, colour and notes of the fused clip, taken from the clips it is made of. */
function fusedLabels(clips: readonly Clip[]): Pick<Clip, 'name' | 'color' | 'note'> {
  const name = clips.find((c) => c.name)?.name;
  const color = clips.find((c) => c.color)?.color;
  const notes = [...new Set(clips.map((c) => c.note?.trim()).filter((n): n is string => !!n))];
  return { ...(name ? { name } : {}), ...(color ? { color } : {}), ...(notes.length ? { note: notes.join('\n') } : {}) };
}

/** The clips at the very start and end of the fused clip, whose fades stay on it. */
export function outerClips(clips: readonly Clip[], start: Frames, end: Frames): { first: Clip; last: Clip } {
  return { first: clips.find((c) => c.start === start)!, last: [...clips].reverse().find((c) => c.start + c.length === end)! };
}

/** The first clip's fade in and the last clip's fade out stay editable on the fused clip. */
function outerFades(clips: readonly Clip[], start: Frames, end: Frames): Pick<Clip, 'fadeIn' | 'fadeOut' | 'fadeInShape' | 'fadeOutShape'> {
  const { first, last } = outerClips(clips, start, end);
  const half = Math.floor((end - start) / 2);
  return {
    fadeIn: Math.min(first.fadeIn, half),
    fadeOut: Math.min(last.fadeOut, half),
    ...(first.fadeIn && first.fadeInShape ? { fadeInShape: first.fadeInShape } : {}),
    ...(last.fadeOut && last.fadeOutShape ? { fadeOutShape: last.fadeOutShape } : {}),
  };
}

function replaceClips(project: Project, trackId: string, ids: ReadonlySet<string>, fused: Clip): Project {
  return {
    ...project,
    tracks: project.tracks.map((t) => (t.id === trackId ? { ...t, clips: [...t.clips.filter((c) => !ids.has(c.id)), fused].sort((a, b) => a.start - b.start) } : t)),
  };
}

/** Joins seamless clips (see isSeamlessFuse) into one, without new audio. Returns the fused clip's id. */
export function fuseSeamless(project: Project, ids: Iterable<string>): { project: Project; clipId: string } | null {
  const check = checkFuse(project, ids);
  if (!check.ok || !isSeamlessFuse(check.clips)) return null;
  const { track, clips, start, end } = check;
  const first = clips[0];
  const envelope = joinEnvelopes(clips);
  const takes = new Set(clips.map((c) => c.takeId));
  const fused: Clip = {
    ...first,
    id: uid('clp'),
    start,
    offset: first.offset,
    length: end - start,
    ...outerFades(clips, start, end),
    ...fusedLabels(clips),
    ...(envelope ? { envelope } : {}),
    ...(clips.some((c) => c.showEnvelope) ? { showEnvelope: true } : {}),
  };
  if (!envelope) delete fused.envelope;
  if (takes.size !== 1) delete fused.takeId;
  return { project: replaceClips(project, track.id, new Set(clips.map((c) => c.id)), fused), clipId: fused.id };
}

/**
 * How a rendered fuse is made: the clip gain is kept on the fused clip when all clips share it, and
 * so are the clip filters when all clips have the same ones; the rest is rendered into the file.
 */
export function fusePlan(clips: readonly Clip[]): { gain: number; keepFx: boolean } {
  const gains = new Set(clips.map((c) => c.gain));
  // the same filters with the same settings (filter ids differ between clips)
  const stacks = new Set(clips.map((c) => JSON.stringify(enabledFx(c).map(({ id: _id, ...f }) => f))));
  return { gain: gains.size === 1 ? clips[0].gain : 0, keepFx: stacks.size === 1 && enabledFx(clips[0]).length > 0 };
}

/**
 * The clips as they are rendered into the fused file: the parts that stay on the fused clip (shared
 * gain and filters, the outer fades) are taken out, so they are not applied twice.
 */
export function clipsToRender(clips: readonly Clip[], start: Frames, end: Frames): Clip[] {
  const { gain, keepFx } = fusePlan(clips);
  const { first, last } = outerClips(clips, start, end);
  return clips.map((c) => {
    const r: Clip = { ...c, gain: c.gain - gain };
    if (keepFx) delete r.fx;
    if (c === first) r.fadeIn = 0;
    if (c === last) r.fadeOut = 0;
    return r;
  });
}

/** Replaces the clips with one clip playing `file`, rendered by renderFused (core/fuseRender.ts). */
export function applyRenderedFuse(project: Project, ids: Iterable<string>, file: string): { project: Project; clipId: string } | null {
  const check = checkFuse(project, ids);
  if (!check.ok) return null;
  const { track, clips, start, end } = check;
  const { gain, keepFx } = fusePlan(clips);
  const fused: Clip = {
    id: uid('clp'),
    file,
    start,
    offset: 0,
    length: end - start,
    gain,
    ...outerFades(clips, start, end),
    ...fusedLabels(clips),
    ...(keepFx ? { fx: clips[0].fx!.map((f) => ({ ...f, id: uid('fx') })) } : {}),
  };
  return { project: replaceClips(project, track.id, new Set(clips.map((c) => c.id)), fused), clipId: fused.id };
}

/**
 * The transcript of a fused file, put together from the transcripts of the clips' files: each
 * clip's words where it plays in the fused clip. Parts played by a clip without a transcript (or
 * with sound design, whose words no longer line up) are left out as not transcribed yet; gaps
 * count as transcribed silence. Null when no clip has a transcript.
 */
export function fuseTranscript(
  clips: readonly Clip[],
  start: Frames,
  end: Frames,
  file: string,
  sampleRate: number,
  get: (file: string) => FileTranscript | null | undefined,
): FileTranscript | null {
  const words: TranscriptWord[] = [];
  const events: TranscriptWord[] = [];
  const missing: Array<[number, number]> = [];
  let base: FileTranscript | null = null;
  for (const c of clips) {
    const t = c.sound ? null : get(c.file);
    const from = c.start - start;
    const to = from + c.length;
    if (!t) {
      missing.push([from, to]);
      continue;
    }
    base ??= t;
    // file frames → project frames (imports may have another rate)
    const scale = sampleRate / (t.sampleRate || sampleRate);
    const take = (list: TranscriptWord[] | undefined, into: TranscriptWord[]) => {
      for (const w of list ?? []) {
        const mid = ((w.start + w.end) / 2) * scale;
        if (mid < c.offset || mid >= c.offset + c.length) continue;
        const s = Math.max(from, from + Math.round(w.start * scale) - c.offset);
        const e = Math.min(to, from + Math.round(w.end * scale) - c.offset);
        into.push({ ...w, start: s, end: Math.max(s, e) });
      }
    };
    take(t.words, words);
    if (t.events) take(t.events, events);
    if (t.spans) {
      // the parts of the clip its file's transcript doesn't cover
      const covered = t.spans.map(([a, b]) => [from + Math.round(a * scale) - c.offset, from + Math.round(b * scale) - c.offset] as [number, number]);
      missing.push(...subtractSpans([[from, to]], unionSpans(covered)));
    }
  }
  if (!base) return null;
  const byTime = (a: TranscriptWord, b: TranscriptWord) => a.start - b.start || a.end - b.end;
  const spans = subtractSpans([[0, end - start]], unionSpans(missing));
  const out: FileTranscript = {
    version: 1,
    file,
    sampleRate,
    language: base.language,
    model: base.model,
    created: new Date().toISOString(),
    words: words.sort(byTime),
  };
  if (events.length) out.events = events.sort(byTime);
  if (missing.length) out.spans = spans;
  return out;
}
