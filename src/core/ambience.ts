// Scene ambience beds for audio dramas: an act or scene heading of the script gets an atmosphere
// (forest, tavern, rain) that loops under that part of the recording and crossfades into the next
// scene's bed by itself. Where a scene is on the timeline comes from its recorded lines (their
// takes), so the beds follow the edit when they are laid again. The beds are ordinary looped clips
// (Clip.sound.loop) on one ambience track, marked with Clip.bed, so the mixer, export, stems and
// editing need nothing special; laying the beds again replaces exactly those clips.
import type { Clip, Frames, Project, SceneBed, Script, Track } from '../shared/types';
import { uid } from '../shared/time';
import { addTrack } from './project';
import { headingLevel, placedLines, type PlacedLine } from './script';

/** Crossfade from one scene's bed into the next, by default (seconds). */
export const BED_FADE_SECONDS = 3;
/** The crossfade lengths the script panel offers. */
export const BED_FADE_CHOICES = [1, 3, 6, 10];
/** A bed starts this long before the scene's first line ... */
export const BED_LEAD_SECONDS = 1;
/** ... and the last scene's bed runs this long after its last line. */
export const BED_TAIL_SECONDS = 2;
/** A line whose take has no end is taken to last this long. */
const LINE_SECONDS = 3;
export const AMBIENCE_TRACK_NAME = 'Ambience';
/** Folder names an ambience track is put into when the episode has one (Track folders › Audio drama folders makes "Atmo"). */
const AMBIENCE_FOLDER = /^(atmo|atmos|atmosphere|atmosph[äa]re|ambience|ambiences|ambient)\b/i;

/** The crossfade length of a script's beds, in seconds. */
export function bedFadeSeconds(script: Script | undefined): number {
  const f = script?.bedFade;
  return Number.isFinite(f) && f! >= 0 ? Math.min(30, f!) : BED_FADE_SECONDS;
}

/**
 * For every line of the script, the heading whose bed plays under it: the innermost act or scene
 * above it that has one (a scene's own bed wins over its act's), or -1.
 */
export function bedOwners(script: Script): number[] {
  const beds = script.beds ?? {};
  const out = new Array<number>(script.lines.length).fill(-1);
  const stack: Array<{ index: number; level: number }> = [];
  script.lines.forEach((l, i) => {
    if (l.kind === 'scene') {
      const level = headingLevel(l);
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ index: i, level });
    }
    for (let k = stack.length - 1; k >= 0; k--) {
      if (beds[script.lines[stack[k].index].id]) {
        out[i] = stack[k].index;
        break;
      }
    }
  });
  return out;
}

/** One stretch of the recording that has the same bed (or none) under it. */
export interface BedSpan {
  /** Heading index whose bed plays here, -1: no bed. */
  owner: number;
  /** Where the stretch begins and ends on the timeline (boundaries with the neighbours). */
  start: Frames;
  end: Frames;
  /** First line start and last line end in the stretch. */
  first: Frames;
  last: Frames;
}

/**
 * The recording cut into stretches by bed: consecutive recorded lines (in timeline order) with the
 * same bed make one. A stretch begins a little before its first line (but not before the previous
 * stretch's last line ends) and lasts until the next one begins; the last one runs on a little.
 */
export function bedSpans(project: Project, placed: PlacedLine[] = placedLines(project)): BedSpan[] {
  const script = project.script;
  if (!script || !placed.length) return [];
  const sr = project.sampleRate;
  const owners = bedOwners(script);
  const runs: Array<{ owner: number; first: Frames; last: Frames }> = [];
  for (const p of placed) {
    const owner = owners[p.index] ?? -1;
    const end = p.end !== undefined && p.end > p.start ? p.end : p.start + LINE_SECONDS * sr;
    const run = runs[runs.length - 1];
    if (run && run.owner === owner) run.last = Math.max(run.last, end);
    else runs.push({ owner, first: p.start, last: end });
  }
  const lead = Math.round(BED_LEAD_SECONDS * sr);
  const out: BedSpan[] = [];
  let start = Math.max(0, runs[0].first - lead);
  runs.forEach((r, k) => {
    const next = runs[k + 1];
    const end = next ? Math.max(next.first - lead, Math.min(r.last, next.first)) : r.last + Math.round(BED_TAIL_SECONDS * sr);
    out.push({ owner: r.owner, start, end: Math.max(start, end), first: r.first, last: r.last });
    start = Math.max(start, end);
  });
  return out;
}

/** A bed clip as it should be on the timeline (without an id). */
export type PlannedBed = Omit<Clip, 'id'> & { bed: string };

/** Where every bed goes: one looped clip per stretch with a bed, overlapping its neighbours by the crossfade. */
export function planBeds(project: Project, placed?: PlacedLine[]): PlannedBed[] {
  const script = project.script;
  const beds = script?.beds;
  if (!script || !beds || !Object.keys(beds).length) return [];
  const spans = bedSpans(project, placed);
  const xf = Math.round(bedFadeSeconds(script) * project.sampleRate);
  const half = Math.floor(xf / 2);
  const out: PlannedBed[] = [];
  spans.forEach((s, k) => {
    if (s.owner < 0) return;
    const id = script.lines[s.owner].id;
    const bed = beds[id];
    if (!bed || bed.length <= 0) return;
    const start = Math.max(0, k > 0 ? s.start - half : s.start);
    const end = k < spans.length - 1 ? s.end + (xf - half) : s.end;
    const length = Math.round(end - start);
    if (length <= 0) return;
    const fade = Math.min(xf, Math.floor(length / 2));
    out.push({
      file: bed.file,
      start,
      offset: 0,
      length,
      gain: bed.gain,
      fadeIn: fade,
      fadeOut: fade,
      fadeInShape: 'equalPower',
      fadeOutShape: 'equalPower',
      name: bed.name,
      bed: id,
      sound: { loop: true, start: 0, length: bed.length, base: 0 },
    });
  });
  return out;
}

/** The bed clips on the timeline now, with their tracks. */
export function bedClips(project: Project): Array<{ track: Track; clip: Clip }> {
  const out: Array<{ track: Track; clip: Clip }> = [];
  for (const t of project.tracks) for (const c of t.clips) if (c.bed) out.push({ track: t, clip: c });
  return out;
}

/** True when the bed clips on the timeline are not where the scenes are now (lines moved, beds changed). */
export function bedsStale(project: Project, placed?: PlacedLine[]): boolean {
  const want = planBeds(project, placed);
  const have = bedClips(project).map((b) => b.clip);
  if (want.length !== have.length) return true;
  const key = (c: Omit<Clip, 'id'>) => `${c.bed}|${c.file}|${c.start}|${c.length}|${c.fadeIn}|${c.fadeOut}`;
  const a = want.map(key).sort();
  const b = have.map(key).sort();
  return a.some((k, i) => k !== b[i]);
}

/** Bedded headings none of whose lines are on the timeline yet (their bed can't be placed). */
export function unplacedBeds(project: Project, placed?: PlacedLine[]): Set<string> {
  const script = project.script;
  const ids = new Set(Object.keys(script?.beds ?? {}));
  if (!script) return ids;
  for (const s of bedSpans(project, placed)) if (s.owner >= 0) ids.delete(script.lines[s.owner].id);
  return ids;
}

/** The track the beds go on: where they are now, else a track named Ambience, else a new one. */
function bedTrack(project: Project): { project: Project; trackId: string } {
  const counts = new Map<string, number>();
  for (const { track } of bedClips(project)) counts.set(track.id, (counts.get(track.id) ?? 0) + 1);
  const busiest = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (busiest) return { project, trackId: busiest[0] };
  const named = project.tracks.find((t) => t.kind !== 'soundboard' && !t.remote && t.name.trim().toLowerCase() === AMBIENCE_TRACK_NAME.toLowerCase());
  if (named) return { project, trackId: named.id };
  const folder = project.folders?.find((f) => AMBIENCE_FOLDER.test(f.name.trim()));
  const id = uid('trk');
  return { project: addTrack(project, { id, name: AMBIENCE_TRACK_NAME, stem: 'effects', ...(folder ? { folderId: folder.id } : {}) }), trackId: id };
}

/**
 * Lays every bed again: the old bed clips go, new ones loop under each scene with a bed. A bed's
 * clip gain changed on the timeline is kept (it becomes the bed's volume). Beds of headings that
 * are gone from the script are forgotten. Returns the same project when nothing changes.
 */
export function layBeds(project: Project): Project {
  const script = project.script;
  const existing = bedClips(project);
  if (!script?.beds && !existing.length) return project;
  let p = project;
  // tidy up: beds of headings that are gone, and gains changed on the timeline
  if (script?.beds) {
    const ids = new Set(script.lines.filter((l) => l.kind === 'scene').map((l) => l.id));
    const beds: Record<string, SceneBed> = {};
    for (const [id, bed] of Object.entries(script.beds)) {
      if (!ids.has(id)) continue;
      const gains = new Set(existing.filter((e) => e.clip.bed === id).map((e) => e.clip.gain));
      beds[id] = gains.size === 1 ? { ...bed, gain: [...gains][0] } : bed;
    }
    p = { ...p, script: withBeds(script, beds) };
  }
  if (!bedsStale(p)) return sameBeds(project, p) ? project : p;
  const planned = planBeds(p);
  if (!planned.length) {
    if (!existing.length) return p;
    return { ...p, tracks: p.tracks.map((t) => (t.clips.some((c) => c.bed) ? { ...t, clips: t.clips.filter((c) => !c.bed) } : t)) };
  }
  const target = bedTrack(p);
  p = target.project;
  return {
    ...p,
    tracks: p.tracks.map((t) => {
      const kept = t.clips.some((c) => c.bed) ? t.clips.filter((c) => !c.bed) : t.clips;
      if (t.id !== target.trackId) return kept === t.clips ? t : { ...t, clips: kept };
      return { ...t, clips: [...kept, ...planned.map((c) => ({ id: uid('clp'), ...c }))].sort((a, b) => a.start - b.start) };
    }),
  };
}

function sameBeds(a: Project, b: Project): boolean {
  return JSON.stringify(a.script?.beds ?? {}) === JSON.stringify(b.script?.beds ?? {});
}

function withBeds(script: Script, beds: Record<string, SceneBed>): Script {
  const { beds: _b, ...rest } = script;
  return Object.keys(beds).length ? { ...rest, beds } : rest;
}

/** Gives a heading a bed (or takes it away) and lays the beds again. */
export function setSceneBed(project: Project, headingId: string, bed: SceneBed | null): Project {
  const script = project.script;
  if (!script || !script.lines.some((l) => l.id === headingId && l.kind === 'scene')) return project;
  const beds = { ...(script.beds ?? {}) };
  if (bed) beds[headingId] = { ...bed, gain: bed.gain ?? beds[headingId]?.gain ?? 0 };
  else delete beds[headingId];
  // the old clips of this heading go with it, so their gain isn't taken over by the new sound
  const tracks = project.tracks.map((t) => (t.clips.some((c) => c.bed === headingId) ? { ...t, clips: t.clips.filter((c) => c.bed !== headingId) } : t));
  return layBeds({ ...project, tracks, script: withBeds(script, beds) });
}

/** Sets a bed's volume, on its clips too. */
export function setBedGain(project: Project, headingId: string, db: number): Project {
  const script = project.script;
  const bed = script?.beds?.[headingId];
  if (!script || !bed || !Number.isFinite(db)) return project;
  const gain = Math.max(-60, Math.min(24, db));
  return layBeds({
    ...project,
    tracks: project.tracks.map((t) => (t.clips.some((c) => c.bed === headingId) ? { ...t, clips: t.clips.map((c) => (c.bed === headingId ? { ...c, gain } : c)) } : t)),
    script: withBeds(script, { ...script.beds, [headingId]: { ...bed, gain } }),
  });
}

/** Sets the crossfade between beds and lays them again. */
export function setBedFade(project: Project, seconds: number): Project {
  const script = project.script;
  if (!script || !Number.isFinite(seconds)) return project;
  const s = Math.max(0, Math.min(30, seconds));
  const next: Script = { ...script };
  if (s === BED_FADE_SECONDS) delete next.bedFade;
  else next.bedFade = s;
  return layBeds({ ...project, script: next });
}

/** Takes every bed away, with its clips. */
export function removeBeds(project: Project): Project {
  const script = project.script;
  const tracks = project.tracks.map((t) => (t.clips.some((c) => c.bed) ? { ...t, clips: t.clips.filter((c) => !c.bed) } : t));
  if (!script) return { ...project, tracks };
  const { beds: _b, bedFade: _f, ...rest } = script;
  return { ...project, tracks, script: rest };
}

/** Heading text as beds are matched between drafts. */
function headingKey(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * After a new draft of the script is imported: the beds of headings that are still there (same
 * text) move to the new headings, and the beds are laid again.
 */
export function carryBeds(old: Script | undefined, project: Project): Project {
  const script = project.script;
  if (!old?.beds || !script) return layBeds(project);
  const byText = new Map<string, SceneBed>();
  for (const l of old.lines) if (l.kind === 'scene' && old.beds[l.id]) byText.set(headingKey(l.text), old.beds[l.id]);
  const beds: Record<string, SceneBed> = {};
  for (const l of script.lines) {
    const bed = l.kind === 'scene' ? byText.get(headingKey(l.text)) : undefined;
    if (bed) beds[l.id] = bed;
  }
  // the old clips point at the old heading ids: hand them over too so their gain is kept
  const moved = new Map<string, string>();
  for (const l of old.lines) {
    if (l.kind !== 'scene' || !old.beds[l.id]) continue;
    const to = script.lines.find((n) => n.kind === 'scene' && headingKey(n.text) === headingKey(l.text));
    if (to) moved.set(l.id, to.id);
  }
  const tracks = project.tracks.map((t) =>
    t.clips.some((c) => c.bed) ? { ...t, clips: t.clips.flatMap((c) => (!c.bed ? [c] : moved.has(c.bed) ? [{ ...c, bed: moved.get(c.bed)! }] : [])) } : t,
  );
  return layBeds({ ...project, tracks, script: { ...withBeds(script, beds), ...(old.bedFade !== undefined ? { bedFade: old.bedFade } : {}) } });
}

/** Beds for an AI agent: which heading has which atmosphere, and where it plays. */
export function bedSummary(project: Project): Array<Record<string, unknown>> {
  const script = project.script;
  if (!script?.beds) return [];
  const sr = project.sampleRate;
  const clips = bedClips(project).map((b) => b.clip);
  return script.lines
    .filter((l) => l.kind === 'scene' && script.beds![l.id])
    .map((l) => {
      const bed = script.beds![l.id];
      const mine = clips.filter((c) => c.bed === l.id);
      return {
        heading: l.text,
        sound: bed.name,
        gain: bed.gain,
        placed: mine.map((c) => ({ start: Math.round((c.start / sr) * 100) / 100, end: Math.round(((c.start + c.length) / sr) * 100) / 100 })),
      };
    });
}
