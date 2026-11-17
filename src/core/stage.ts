// The 3D stage: each voice can stand somewhere around the listener (angle, height, distance)
// instead of being panned. Placed tracks are rendered binaurally for headphones (binaural.ts) or,
// in speakers mode, panned from their angle. The angle and distance lanes of track automation
// move a voice over time (a character walking past).
import type { Fx, Frames, Project, StageMode, StagePosition, Track } from '../shared/types';
import { automationValueAt } from './automation';

export const AZIMUTH_MIN = -180;
export const AZIMUTH_MAX = 180;
export const ELEVATION_MIN = -45;
export const ELEVATION_MAX = 90;
export const DISTANCE_MIN = 0.3;
export const DISTANCE_MAX = 30;

/** Where a voice stands when it is first put on the stage: in front at 1 m, which keeps its level. */
export const DEFAULT_STAGE: StagePosition = { azimuth: 0, elevation: 0, distance: 1 };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** An angle folded into -180 .. 180 (180 rather than -180 for straight behind). */
export function wrapAzimuth(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  let a = ((((deg + 180) % 360) + 360) % 360) - 180;
  if (a === -180) a = 180;
  return a;
}

export const clampAzimuth = (v: number): number => (Math.abs(v) <= 180 ? v : wrapAzimuth(v));
export const clampElevation = (v: number): number => clamp(Number.isFinite(v) ? v : 0, ELEVATION_MIN, ELEVATION_MAX);
export const clampDistance = (v: number): number => clamp(Number.isFinite(v) ? v : 1, DISTANCE_MIN, DISTANCE_MAX);

export function clampStage(p: Partial<StagePosition>): StagePosition {
  return {
    azimuth: Math.round(clampAzimuth(Number(p.azimuth ?? 0)) * 10) / 10,
    elevation: Math.round(clampElevation(Number(p.elevation ?? 0)) * 10) / 10,
    distance: Math.round(clampDistance(Number(p.distance ?? 1)) * 100) / 100,
  };
}

/** Cleans a stage position read from a project file (undefined when it isn't one). */
export function normalizeStage(raw: unknown): StagePosition | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (![r.azimuth, r.elevation, r.distance].every((v) => v === undefined || Number.isFinite(v))) return undefined;
  return clampStage(r as Partial<StagePosition>);
}

export function stageMode(project: Project): StageMode {
  return project.stage?.mode === 'speakers' ? 'speakers' : 'binaural';
}

export function isOnStage(track: Track): boolean {
  return !!track.stage;
}

/** The angle a panned track starts at when it is put on the stage: hard left is 90° left. */
export function panToAzimuth(pan: number): number {
  return Math.round(clamp(pan, -1, 1) * 90);
}

/** Pan for loudspeakers (speakers mode): the sideways part of the angle, so behind folds to the sides. */
export function azimuthToPan(azimuth: number): number {
  return Math.sin((azimuth * Math.PI) / 180);
}

/** Where a placed track's voice is at a timeline frame: its fixed place, moved by the angle and distance lanes. */
export function stageAt(track: Track, frame: Frames): StagePosition {
  const s = track.stage ?? DEFAULT_STAGE;
  const a = track.automation;
  return {
    azimuth: a?.angle?.length ? clampAzimuth(automationValueAt(a.angle, frame)) : s.azimuth,
    elevation: s.elevation,
    distance: a?.distance?.length ? clampDistance(automationValueAt(a.distance, frame)) : s.distance,
  };
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Puts tracks on the stage (or moves them there). A track that wasn't placed yet starts at the
 * angle of its pan, in front at 1 m, so it sounds where it did before.
 */
export function placeOnStage(project: Project, trackIds: string[], pos?: Partial<StagePosition>): Project {
  const p = clone(project);
  for (const t of p.tracks) {
    if (!trackIds.includes(t.id)) continue;
    const base = t.stage ?? { ...DEFAULT_STAGE, azimuth: panToAzimuth(t.pan) };
    t.stage = clampStage({ ...base, ...(pos ?? {}) });
  }
  return p;
}

/** Takes tracks off the stage: they are panned again, and their angle and distance lanes go. */
export function removeFromStage(project: Project, trackIds: string[]): Project {
  const p = clone(project);
  for (const t of p.tracks) {
    if (!trackIds.includes(t.id) || !t.stage) continue;
    delete t.stage;
    if (t.automation) {
      delete t.automation.angle;
      delete t.automation.distance;
      if (t.automation.shown === 'angle' || t.automation.shown === 'distance') delete t.automation.shown;
      if (!Object.keys(t.automation).length) delete t.automation;
    }
  }
  return p;
}

export function setStageMode(project: Project, mode: StageMode): Project {
  const p = clone(project);
  if (mode === 'binaural') delete p.stage;
  else p.stage = { mode };
  return p;
}

/** True when the list has a Room & distance filter switched on: it then takes over the distance (see Space). */
export function hasRoomFilter(list: Fx[] | undefined): boolean {
  return !!list?.some((f) => f.enabled && f.type === 'space');
}

/** An angle as shown to people: "Front", "R 30°", "L 120°", "Behind". */
export function formatAzimuth(deg: number): string {
  const a = Math.round(wrapAzimuth(deg));
  if (a === 0) return 'Front';
  if (Math.abs(a) === 180) return 'Behind';
  return `${a < 0 ? 'L' : 'R'} ${Math.abs(a)}°`;
}

/** Reads a typed angle: "30", "-45", "R 30", "L45", "front", "behind". Null when it isn't one. */
export function parseAzimuth(text: string): number | null {
  const t = text.trim().toUpperCase().replace(/°|DEG$/g, '').trim();
  if (t === 'FRONT' || t === 'F' || t === 'C') return 0;
  if (t === 'BEHIND' || t === 'BACK' || t === 'B') return 180;
  const m = /^([LR])\s*(\d+(?:[.,]\d+)?)$|^([+-]?\d+(?:[.,]\d+)?)\s*([LR])?$/.exec(t);
  if (!m) return null;
  let n: number;
  if (m[1]) n = Number(m[2].replace(',', '.')) * (m[1] === 'L' ? -1 : 1);
  else {
    n = Number(m[3].replace(',', '.'));
    if (m[4] === 'L') n = -Math.abs(n);
    if (m[4] === 'R') n = Math.abs(n);
  }
  return Number.isFinite(n) ? Math.round(wrapAzimuth(n) * 10) / 10 : null;
}

/** A distance as shown to people: "0.5 m", "2 m", "12 m". */
export function formatDistance(m: number): string {
  return `${m < 10 ? Math.round(m * 10) / 10 : Math.round(m)} m`;
}
