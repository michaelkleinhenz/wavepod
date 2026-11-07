// Takes and comping. A track's clips are what plays (the comp); `Track.takes` keeps every recorded
// pass of the same lines, so a whole take can be swapped in, or a part of one spliced into the comp.
// Every function is pure: it returns a new project and never touches the input.
import type { Clip, Frames, Project, Take, Track } from '../shared/types';
import { uid } from '../shared/time';

/** Partial last cycles of a loop recording shorter than this (seconds) are not kept as takes. */
export const MIN_LOOP_TAKE_SECONDS = 0.5;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

const clipEnd = (c: Clip) => c.start + c.length;

/** First and last frame a take covers on the timeline. */
export function takeSpan(take: Take): [Frames, Frames] {
  let a = Infinity;
  let b = -Infinity;
  for (const c of take.clips) {
    a = Math.min(a, c.start);
    b = Math.max(b, clipEnd(c));
  }
  return a < b ? [a, b] : [0, 0];
}

/**
 * The parts of `clips` inside [a, b), as new clips (new ids). A fade is kept only on an edge that
 * was not cut; volume lines stay valid because they count in source frames.
 */
export function clipsInRange(clips: Clip[], a: Frames, b: Frames): Clip[] {
  const out: Clip[] = [];
  for (const c of clips) {
    const s = Math.max(a, c.start);
    const e = Math.min(b, clipEnd(c));
    if (e <= s) continue;
    out.push({
      ...clone(c),
      id: uid('clp'),
      start: s,
      offset: c.offset + (s - c.start),
      length: e - s,
      fadeIn: s === c.start ? c.fadeIn : 0,
      fadeOut: e === clipEnd(c) ? c.fadeOut : 0,
    });
  }
  return out;
}

/** `clips` with [a, b) cut out; parts left and right of it stay (the right part gets a new id). */
export function clearRange(clips: Clip[], a: Frames, b: Frames): Clip[] {
  const out: Clip[] = [];
  for (const c of clips) {
    if (clipEnd(c) <= a || c.start >= b) {
      out.push(c);
      continue;
    }
    if (c.start < a) out.push({ ...c, length: a - c.start, fadeOut: 0 });
    if (clipEnd(c) > b) out.push({ ...c, id: uid('clp'), start: b, offset: c.offset + (b - c.start), length: clipEnd(c) - b, fadeIn: 0 });
  }
  return out;
}

function nextTakeNumber(track: Track): number {
  return (track.takes ?? []).reduce((n, t) => Math.max(n, t.n), 0) + 1;
}

const sortClips = (clips: Clip[]) => clips.sort((a, b) => a.start - b.start);

/**
 * Splices [a, b) of a take into the comp: whatever plays there now is replaced by the take, where
 * the take has audio. Returns the same project when the take has nothing in the range.
 */
export function compTake(project: Project, trackId: string, takeId: string, a: Frames, b: Frames): Project {
  const src = project.tracks.find((t) => t.id === trackId);
  const take = src?.takes?.find((t) => t.id === takeId);
  if (!take || b <= a) return project;
  const parts = clipsInRange(take.clips, Math.round(a), Math.round(b)).map((c) => ({ ...c, takeId }));
  if (!parts.length) return project;
  const p = clone(project);
  const t = p.tracks.find((x) => x.id === trackId)!;
  let clips = t.clips;
  for (const part of parts) clips = clearRange(clips, part.start, clipEnd(part));
  t.clips = sortClips([...clips, ...parts]);
  return p;
}

/** Makes a whole take the one that plays. */
export function pickTake(project: Project, trackId: string, takeId: string): Project {
  const take = project.tracks.find((t) => t.id === trackId)?.takes?.find((t) => t.id === takeId);
  if (!take) return project;
  const [a, b] = takeSpan(take);
  return compTake(project, trackId, takeId, a, b);
}

/**
 * Adds a recorded clip as a new take and makes it the one that plays. Recording over a stretch that
 * has no takes yet first keeps what was there as a take of its own, so nothing is lost. A clip over
 * an empty stretch is simply added (a first recording is not a take yet).
 */
export function recordTake(project: Project, trackId: string, clip: Clip): Project {
  const src = project.tracks.find((t) => t.id === trackId);
  if (!src) return project;
  const s = clip.start;
  const e = clipEnd(clip);
  const under = src.clips.filter((c) => c.start < e && clipEnd(c) > s);
  const p = clone(project);
  const t = p.tracks.find((x) => x.id === trackId)!;
  if (!under.length) {
    // nothing under it: a plain clip, unless earlier takes of this stretch exist
    const overTakes = (t.takes ?? []).some((tk) => {
      const [a, b] = takeSpan(tk);
      return a < e && b > s;
    });
    if (!overTakes) {
      t.clips = sortClips([...t.clips, clip]);
      return p;
    }
  }
  t.takes = t.takes ?? [];
  // what plays there and doesn't come from a take yet becomes a take, so it can be picked again
  const loose = under.filter((c) => !c.takeId || !t.takes!.some((tk) => tk.id === c.takeId));
  if (loose.length) {
    const kept = clipsInRange(loose, s, e).map(({ takeId: _, ...c }) => c);
    if (kept.length) t.takes.push({ id: uid('tk'), n: nextTakeNumber(t), clips: sortClips(kept) });
  }
  const { takeId: _old, ...plain } = clip;
  const take: Take = { id: uid('tk'), n: nextTakeNumber(t), clips: [plain] };
  t.takes.push(take);
  return compTake(p, trackId, take.id, s, e);
}

/** Adds several takes in recording order (the cycles of a loop recording); the last one plays. */
export function recordTakes(project: Project, trackId: string, clips: Clip[]): Project {
  let p = project;
  // with more than one pass, even the first one over an empty stretch is a take
  if (clips.length > 1) {
    const t = p.tracks.find((x) => x.id === trackId);
    const [first] = clips;
    const empty = t && !t.clips.some((c) => c.start < clipEnd(first) && clipEnd(c) > first.start);
    if (t && empty) {
      p = clone(p);
      const tt = p.tracks.find((x) => x.id === trackId)!;
      const take: Take = { id: uid('tk'), n: nextTakeNumber(tt), clips: [{ ...first }] };
      tt.takes = [...(tt.takes ?? []), take];
      p = compTake(p, trackId, take.id, first.start, clipEnd(first));
      clips = clips.slice(1);
    }
  }
  for (const c of clips) p = recordTake(p, trackId, c);
  return p;
}

/**
 * Splits one loop recording into a clip per pass. The file was recorded from `clip.start`; the
 * timeline jumped back from `loop[1]` to `loop[0]` every time it got there. Audio before the loop
 * start (the run-up of the first pass) is not part of any take, and a last pass cut short under
 * MIN_LOOP_TAKE_SECONDS is dropped.
 */
export function loopTakeClips(clip: Clip, loop: [Frames, Frames], sampleRate: number): Clip[] {
  const [a, b] = loop;
  const total = clip.length;
  const L = b - a;
  if (L <= 0 || clip.start >= b) return [clip];
  const out: Clip[] = [];
  // first pass: from the record start to the loop end, minus the run-up
  const firstStart = Math.max(clip.start, a);
  const firstLen = Math.min(b, clip.start + total) - firstStart;
  if (firstLen > 0) out.push({ ...clip, id: uid('clp'), start: firstStart, offset: clip.offset + (firstStart - clip.start), length: firstLen });
  for (let f = b - clip.start; f < total; f += L) {
    out.push({ ...clip, id: uid('clp'), start: a, offset: clip.offset + f, length: Math.min(L, total - f) });
  }
  const min = MIN_LOOP_TAKE_SECONDS * sampleRate;
  while (out.length > 1 && out[out.length - 1].length < Math.min(min, L)) out.pop();
  return out.map((c) => ({ ...c, fadeIn: 0, fadeOut: 0 }));
}

/** Where file frame `frame` of a loop recording that started at `start` sits on the timeline. */
export function loopFramePosition(frame: Frames, start: Frames, loop: [Frames, Frames]): Frames {
  const [a, b] = loop;
  const pos = start + frame;
  if (pos < b || b <= a) return pos;
  return a + ((pos - b) % (b - a));
}

/** Which pass of a loop recording is being recorded at `recorded` frames in (1 = the first). */
export function loopPass(recorded: Frames, start: Frames, loop: [Frames, Frames]): number {
  const [a, b] = loop;
  const pos = start + recorded;
  if (pos < b || b <= a) return 1;
  return 2 + Math.floor((pos - b) / (b - a));
}

/** Takes of a track that cover `frame`, by number. */
export function takesAt(track: Track, frame: Frames): Take[] {
  return (track.takes ?? []).filter((tk) => {
    const [a, b] = takeSpan(tk);
    return frame >= a && frame < b;
  }).sort((x, y) => x.n - y.n);
}

/** The take the comp plays at `frame`, if the clip there came from one. */
export function activeTakeAt(track: Track, frame: Frames): Take | undefined {
  const c = track.clips.find((x) => x.takeId && frame >= x.start && frame < clipEnd(x));
  return c ? track.takes?.find((tk) => tk.id === c.takeId) : undefined;
}

/** Stretches of the timeline where the comp plays this take. */
export function takeUsage(track: Track, takeId: string): Array<[Frames, Frames]> {
  return track.clips.filter((c) => c.takeId === takeId).map((c) => [c.start, clipEnd(c)]);
}

export function takeInUse(track: Track, takeId: string): boolean {
  return track.clips.some((c) => c.takeId === takeId);
}

/** Plays the next (dir 1) or previous (dir -1) take wherever the playhead's take group is. */
export function cycleTake(project: Project, trackId: string, frame: Frames, dir: 1 | -1): { project: Project; take?: Take } {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) return { project };
  const here = takesAt(track, frame);
  if (here.length < 2) return { project };
  const cur = activeTakeAt(track, frame);
  const i = cur ? here.findIndex((t) => t.id === cur.id) : -1;
  const next = here[(i + dir + here.length) % here.length];
  return { project: pickTake(project, trackId, next.id), take: next };
}

/** Removes a take that the comp doesn't use (one in use stays; pick another one first). */
export function deleteTake(project: Project, trackId: string, takeId: string): Project {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track?.takes?.some((t) => t.id === takeId) || takeInUse(track, takeId)) return project;
  const p = clone(project);
  const t = p.tracks.find((x) => x.id === trackId)!;
  t.takes = t.takes!.filter((x) => x.id !== takeId);
  tidy(t);
  return p;
}

/** Removes every take the comp doesn't use. */
export function deleteUnusedTakes(project: Project, trackId: string): Project {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track?.takes?.some((tk) => !takeInUse(track, tk.id))) return project;
  const p = clone(project);
  const t = p.tracks.find((x) => x.id === trackId)!;
  t.takes = t.takes!.filter((tk) => takeInUse(t, tk.id));
  tidy(t);
  return p;
}

/** Keeps the comp as plain clips and forgets the takes (the files stay in the project folder). */
export function flattenTakes(project: Project, trackId: string): Project {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track?.takes?.length) return project;
  const p = clone(project);
  const t = p.tracks.find((x) => x.id === trackId)!;
  delete t.takes;
  delete t.showTakes;
  for (const c of t.clips) delete c.takeId;
  return p;
}

function tidy(t: Track): void {
  if (t.takes && !t.takes.length) {
    delete t.takes;
    delete t.showTakes;
  }
  const ids = new Set((t.takes ?? []).map((x) => x.id));
  for (const c of t.clips) if (c.takeId && !ids.has(c.takeId)) delete c.takeId;
}

// ------------------------------------------------------------ keeping takes in step with edits

/** Ripple cut [start, end) applied to a track's takes (called by project.rippleDelete). */
export function rippleTakes(t: Track, start: Frames, end: Frames): void {
  if (!t.takes?.length) return;
  const len = end - start;
  for (const tk of t.takes) tk.clips = clearRange(tk.clips, start, end).map((c) => (c.start >= end ? { ...c, start: c.start - len } : c));
  t.takes = t.takes.filter((tk) => tk.clips.length);
  if (!t.takes.length) delete t.takes;
}

/** Silence inserted at `pos` applied to a track's takes (called by project.insertSilence). */
export function insertIntoTakes(t: Track, pos: Frames, length: Frames): void {
  if (!t.takes?.length) return;
  for (const tk of t.takes) {
    const split: Clip[] = [];
    for (const c of tk.clips) {
      if (pos > c.start && pos < clipEnd(c)) {
        split.push({ ...c, length: pos - c.start, fadeOut: 0 });
        split.push({ ...c, id: uid('clp'), start: pos + length, offset: c.offset + (pos - c.start), length: clipEnd(c) - pos, fadeIn: 0 });
      } else split.push(c.start >= pos ? { ...c, start: c.start + length } : c);
    }
    tk.clips = split;
  }
}

/** Takes whose spans overlap, directly or through each other. */
function takeGroups(takes: Take[]): Take[][] {
  const sorted = [...takes].sort((x, y) => takeSpan(x)[0] - takeSpan(y)[0]);
  const groups: Take[][] = [];
  let end = -Infinity;
  for (const tk of sorted) {
    const [a, b] = takeSpan(tk);
    if (groups.length && a < end) {
      groups[groups.length - 1].push(tk);
      end = Math.max(end, b);
    } else {
      groups.push([tk]);
      end = b;
    }
  }
  return groups;
}

/**
 * How far the comp of a take group was moved on the timeline, or null if it wasn't moved as a
 * whole (parts moved by different amounts, or nothing to tell by).
 */
function groupShift(track: Track, group: Take[]): number | null {
  const byId = new Map(group.map((tk) => [tk.id, tk]));
  let shift: number | null = null;
  for (const c of track.clips) {
    const tk = c.takeId ? byId.get(c.takeId) : undefined;
    if (!tk || c.sound) continue;
    const src = tk.clips.find((x) => x.file === c.file && x.offset <= c.offset && c.offset + c.length <= x.offset + x.length);
    if (!src) return null;
    const d = c.start - (src.start + (c.offset - src.offset));
    if (shift === null) shift = d;
    else if (shift !== d) return null;
  }
  return shift;
}

/**
 * Moves takes along when the user moved a comp as a whole (dragged the line somewhere else), so
 * picking another take puts it where the line is now. Returns the same project when nothing moved.
 */
export function syncTakes(project: Project): Project {
  let p: Project | null = null;
  project.tracks.forEach((track, ti) => {
    if (!track.takes?.length) return;
    for (const group of takeGroups(track.takes)) {
      const d = groupShift(track, group);
      if (!d) continue;
      if (group.some((tk) => takeSpan(tk)[0] + d < 0)) continue;
      p = p ?? clone(project);
      const ids = new Set(group.map((tk) => tk.id));
      for (const tk of p.tracks[ti].takes!) if (ids.has(tk.id)) for (const c of tk.clips) c.start += d;
    }
  });
  return p ?? project;
}

/** Fills defaults for takes read from project.json; drops broken ones. */
export function normalizeTakes(raw: unknown, normalizeClip: (c: Clip) => Clip): Take[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Take[] = [];
  for (const r of raw as Array<Partial<Take>>) {
    if (!r || !Array.isArray(r.clips)) continue;
    const clips = r.clips.filter((c) => c && typeof c.file === 'string' && Number.isFinite(c.start) && Number.isFinite(c.length) && c.length > 0).map(normalizeClip);
    if (!clips.length) continue;
    out.push({ id: typeof r.id === 'string' && r.id ? r.id : uid('tk'), n: Number.isFinite(r.n) && r.n! > 0 ? Math.round(r.n!) : out.length + 1, clips });
  }
  return out.length ? out : undefined;
}
