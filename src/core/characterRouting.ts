// Character routing for audio dramas: every role in the script can have its own track (the
// character track) with a voice effect and a room on its filter stack. After Line up or Cut Around,
// the clips that hold a character's lines are moved from the track they were recorded on to the
// character track, so each line plays with its character's sound.
import type {
  Clip,
  Frames,
  Fx,
  Project,
  Script,
  ScriptRole,
  Track,
} from "../shared/types";
import { uid } from "../shared/time";
import { addTrack } from "./project";
import {
  VOICE_EFFECTS,
  findVoiceEffect,
  voiceEffectFilters,
  type VoiceEffect,
} from "./fx/voiceEffects";
import {
  characterKey,
  roleTrack,
  scriptCharacters,
  takePosition,
} from "./script";

/** Voice effects a character can have (telephone, robot, giant…). */
export const ROLE_VOICES: VoiceEffect[] = VOICE_EFFECTS.filter(
  (e) => e.group !== "place",
);
/** Rooms a character can be in (Room & distance presets). */
export const ROLE_ROOMS: VoiceEffect[] = VOICE_EFFECTS.filter(
  (e) => e.group === "place",
);

/** A clip is only moved if it isn't much longer than the lines in it: 2 × their span plus this (seconds). */
const ROUTE_SLACK = 6;
/** Assumed length of a line whose end isn't known (seconds). */
const UNKNOWN_LINE = 3;

function speechTrack(
  project: Project,
  id: string | undefined,
): Track | undefined {
  return id
    ? project.tracks.find((t) => t.id === id && t.kind !== "soundboard")
    : undefined;
}

/** The character's role, with a track only while that track exists. */
export function characterRole(project: Project, character: string): ScriptRole {
  const role = project.script?.roles?.[characterKey(character)] ?? {};
  if (role.trackId && !speechTrack(project, role.trackId)) {
    const { trackId: _t, ...rest } = role;
    return rest;
  }
  return role;
}

/** The character track of a character, if it has one that still exists. */
export function characterTrack(
  project: Project,
  character: string,
): Track | undefined {
  return speechTrack(
    project,
    project.script?.roles?.[characterKey(character)]?.trackId,
  );
}

function withRole(
  project: Project,
  key: string,
  fn: (r: ScriptRole) => ScriptRole,
): Project {
  const script = project.script;
  if (!script) return project;
  const roles = { ...(script.roles ?? {}) };
  const next = fn(roles[key] ?? {});
  for (const k of Object.keys(next) as Array<keyof ScriptRole>)
    if (
      next[k] === undefined ||
      (Array.isArray(next[k]) && !(next[k] as string[]).length)
    )
      delete next[k];
  if (Object.keys(next).length) roles[key] = next;
  else delete roles[key];
  const out: Script = { ...script, roles };
  if (!Object.keys(roles).length) delete out.roles;
  return { ...project, script: out };
}

function words(s: string): string {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .join(" ");
}

/** "DR. SARAH MEYER" → "Dr. Sarah Meyer"; names already in mixed case stay as they are. */
export function characterTrackName(name: string): string {
  const n = name.replace(/\s+/g, " ").trim();
  if (n !== n.toUpperCase()) return n;
  return n
    .toLowerCase()
    .replace(
      /(^|[\s\-'.(])(\p{L})/gu,
      (_, a: string, b: string) => a + b.toUpperCase(),
    );
}

/** Filters copied to a new track: same settings, own ids. */
function copyFx(
  list: readonly Fx[] | undefined,
  skip: ReadonlySet<string>,
): Fx[] {
  return (list ?? [])
    .filter((f) => !skip.has(f.id))
    .map((f) => ({ ...structuredClone(f), id: uid("fx") }));
}

/** Filter ids that some role added (voice or room). */
function roleFxIds(script: Script): Set<string> {
  const out = new Set<string>();
  for (const r of Object.values(script.roles ?? {}))
    for (const id of [...(r.voiceFx ?? []), ...(r.roomFx ?? [])]) out.add(id);
  return out;
}

/**
 * Gives a character its own track. A track already named after the character is used as it is
 * (an actor's microphone named after the role); otherwise a new track is added, named after the
 * character, in the folder of the track the character is recorded on (or the Dialogue folder),
 * starting with a copy of that track's filters so the voice still gets its clean-up.
 */
export function ensureCharacterTrack(
  project: Project,
  character: string,
): { project: Project; trackId: string; created: boolean } {
  const script = project.script;
  if (!script) throw new Error("No script");
  const key = characterKey(character);
  const have = characterTrack(project, key);
  if (have) return { project, trackId: have.id, created: false };
  const name =
    scriptCharacters(script).find((c) => c.key === key)?.name ?? character;
  const want = words(name);
  const taken = new Set(
    Object.entries(script.roles ?? {})
      .filter(([k]) => k !== key)
      .map(([, r]) => r.trackId),
  );
  const same = project.tracks.find(
    (t) =>
      t.kind !== "soundboard" &&
      !t.cameraId &&
      !taken.has(t.id) &&
      words(t.name) === want,
  );
  if (same)
    return {
      project: withRole(project, key, (r) => ({ ...r, trackId: same.id })),
      trackId: same.id,
      created: false,
    };
  const recorded = speechTrack(project, script.cast[key]);
  const folderId =
    recorded?.folderId ??
    project.folders?.find((f) => f.name.trim().toLowerCase() === "dialogue")
      ?.id;
  const id = uid("trk");
  let p = addTrack(project, {
    id,
    name: characterTrackName(name),
    stem: "dialogue",
    ...(folderId ? { folderId } : {}),
    ...(recorded?.fx?.length
      ? { fx: copyFx(recorded.fx, roleFxIds(script)) }
      : {}),
  });
  p = withRole(p, key, (r) => ({ ...r, trackId: id }));
  return { project: p, trackId: id, created: true };
}

/** Character tracks for every character that has none yet. */
export function ensureCharacterTracks(project: Project): {
  project: Project;
  created: number;
} {
  if (!project.script) return { project, created: 0 };
  let p = project;
  let created = 0;
  for (const c of scriptCharacters(project.script)) {
    const r = ensureCharacterTrack(p, c.key);
    p = r.project;
    if (r.created) created++;
  }
  return { project: p, created };
}

/**
 * Sets (or with null, removes) a character's track. Its voice and room filters stay on the track
 * they were added to: they are that track's filters now.
 */
export function setCharacterTrack(
  project: Project,
  character: string,
  trackId: string | null,
): Project {
  const key = characterKey(character);
  return withRole(project, key, (r) =>
    trackId ? (r.trackId === trackId ? r : { trackId }) : {},
  );
}

function removeIds(
  project: Project,
  trackId: string,
  ids: readonly string[] | undefined,
): Project {
  if (!ids?.length) return project;
  const drop = new Set(ids);
  return {
    ...project,
    tracks: project.tracks.map((t) =>
      t.id === trackId && t.fx?.some((f) => drop.has(f.id))
        ? { ...t, fx: t.fx.filter((f) => !drop.has(f.id)) }
        : t,
    ),
  };
}

function insertAt(
  project: Project,
  trackId: string,
  filters: Fx[],
  before: readonly string[] | undefined,
): Project {
  return {
    ...project,
    tracks: project.tracks.map((t) => {
      if (t.id !== trackId) return t;
      const list = [...(t.fx ?? [])];
      const at = before?.length
        ? list.findIndex((f) => before.includes(f.id))
        : -1;
      list.splice(at < 0 ? list.length : at, 0, ...filters);
      return { ...t, fx: list };
    }),
  };
}

/**
 * Sets a character's voice effect (or none): its filters go on the character track (made first if
 * needed), before the room, replacing the voice set before.
 */
export function setCharacterVoice(
  project: Project,
  character: string,
  voice: string | null,
): Project {
  const key = characterKey(character);
  const effect = voice ? findVoiceEffect(voice) : null;
  if (voice && (!effect || effect.group === "place"))
    throw new Error(`Unknown voice "${voice}"`);
  if (!effect && !characterTrack(project, key))
    return withRole(project, key, (r) => ({
      ...r,
      voice: undefined,
      voiceFx: undefined,
    }));
  const t = ensureCharacterTrack(project, key);
  const role = characterRole(t.project, key);
  let p = removeIds(t.project, t.trackId, role.voiceFx);
  const filters = effect ? voiceEffectFilters(effect) : [];
  p = insertAt(p, t.trackId, filters, role.roomFx);
  return withRole(p, key, (r) => ({
    ...r,
    voice: effect?.id,
    voiceFx: filters.map((f) => f.id),
  }));
}

/** Sets a character's room (a Room & distance preset, or none) at the end of the character track's filters. */
export function setCharacterRoom(
  project: Project,
  character: string,
  room: string | null,
): Project {
  const key = characterKey(character);
  const effect = room
    ? (findVoiceEffect(room.startsWith("place-") ? room : `place-${room}`) ??
      findVoiceEffect(room))
    : null;
  if (room && (!effect || effect.group !== "place"))
    throw new Error(`Unknown room "${room}"`);
  if (!effect && !characterTrack(project, key))
    return withRole(project, key, (r) => ({
      ...r,
      room: undefined,
      roomFx: undefined,
    }));
  const t = ensureCharacterTrack(project, key);
  const role = characterRole(t.project, key);
  let p = removeIds(t.project, t.trackId, role.roomFx);
  const filters = effect ? voiceEffectFilters(effect) : [];
  p = insertAt(p, t.trackId, filters, undefined);
  return withRole(p, key, (r) => ({
    ...r,
    room: effect?.id,
    roomFx: filters.map((f) => f.id),
  }));
}

/** Whether any character has a character track. */
export function hasCharacterTracks(project: Project): boolean {
  return Object.keys(project.script?.roles ?? {}).some((k) =>
    characterTrack(project, k),
  );
}

/** A line spoken somewhere on the timeline (a take). */
export interface LineSpot {
  lineId?: string;
  trackId: string;
  start: Frames;
  end: Frames;
}

export interface RouteResult {
  project: Project;
  /** Clips moved to a character track. */
  moved: number;
  clipIds: string[];
}

/**
 * Moves the clips that hold lines of one character to that character's track, at the same time.
 * Only clips holding the given takes (all found lines when none are given) are moved, and only
 * when every line in the clip is the same character's and the clip isn't much longer than its
 * lines, so a long recording with lines of several characters stays where it is until it is cut
 * (Cut Around Every Take).
 */
export function routeLines(
  project: Project,
  only?: readonly LineSpot[],
): RouteResult {
  const script = project.script;
  if (!script || !hasCharacterTracks(project))
    return { project, moved: 0, clipIds: [] };
  const sr = project.sampleRate;
  const keyOf = new Map(
    script.lines
      .filter((l) => l.kind === "dialogue" && l.character)
      .map((l) => [l.id, characterKey(l.character!)]),
  );
  const placed: LineSpot[] = [];
  for (const l of script.lines) {
    if (l.kind !== "dialogue" || !l.take?.file) continue;
    const p = takePosition(
      project,
      l.take,
      roleTrack(script, l) ?? script.cast[keyOf.get(l.id) ?? ""],
    );
    if (p?.trackId)
      placed.push({
        lineId: l.id,
        trackId: p.trackId,
        start: p.start,
        end: p.end ?? p.start + UNKNOWN_LINE * sr,
      });
  }
  const wanted = new Set<LineSpot>(only ?? placed);
  const all = only ? [...placed, ...only] : placed;
  const moves = new Map<string, string>();
  for (const t of project.tracks) {
    if (t.kind === "soundboard" || t.cameraId) continue;
    for (const c of t.clips) {
      if (c.sound) continue;
      const end = c.start + c.length;
      const inside = all.filter(
        (s) =>
          s.trackId === t.id && s.lineId && s.start >= c.start && s.start < end,
      );
      if (!inside.some((s) => wanted.has(s))) continue;
      const keys = new Set(inside.map((s) => keyOf.get(s.lineId!)));
      if (keys.size !== 1) continue;
      const key = [...keys][0];
      const to = key ? characterTrack(project, key) : undefined;
      if (!to || to.id === t.id) continue;
      const span =
        Math.max(...inside.map((s) => s.end)) -
        Math.min(...inside.map((s) => s.start));
      if (c.length > 2 * span + ROUTE_SLACK * sr) continue;
      moves.set(c.id, to.id);
    }
  }
  if (!moves.size) return { project, moved: 0, clipIds: [] };
  const arriving = new Map<string, Clip[]>();
  const stripped = project.tracks.map((t) => {
    if (!t.clips.some((c) => moves.has(c.id))) return t;
    const keep: Clip[] = [];
    for (const c of t.clips) {
      const to = moves.get(c.id);
      if (!to) {
        keep.push(c);
        continue;
      }
      // a comp piece leaves its take lane behind
      const { takeId: _take, ...moved } = c;
      let list = arriving.get(to);
      if (!list) arriving.set(to, (list = []));
      list.push(moved);
    }
    return { ...t, clips: keep };
  });
  const tracks = stripped.map((t) => {
    const add = arriving.get(t.id);
    return add
      ? { ...t, clips: [...t.clips, ...add].sort((a, b) => a.start - b.start) }
      : t;
  });
  return {
    project: { ...project, tracks },
    moved: moves.size,
    clipIds: [...moves.keys()],
  };
}

/** The roles for an AI agent: each character's recording track, character track, voice and room. */
export function rolesSummary(project: Project): Array<Record<string, unknown>> {
  const script = project.script;
  if (!script) return [];
  const names = new Map(project.tracks.map((t) => [t.id, t.name]));
  return scriptCharacters(script).map((c) => {
    const role = characterRole(project, c.key);
    const cast = script.cast[c.key];
    return {
      name: c.name,
      lines: c.lines,
      recorded: c.recorded,
      ...(cast && names.has(cast) ? { track: names.get(cast) } : {}),
      ...(role.trackId ? { characterTrack: names.get(role.trackId) } : {}),
      ...(role.voice ? { voice: role.voice } : {}),
      ...(role.room ? { room: role.room } : {}),
    };
  });
}
