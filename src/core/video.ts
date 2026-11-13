// Multi-camera video: which part of which camera is seen at a timeline position. Pure, so the
// window, the export and the tests share it.
//
// Cameras keep no clips. A camera's sound is a track (Track.cameraId); at timeline frame t the
// camera shows the moment of its video that belongs to the sound its track plays there. Every edit
// to that track (ripple cut, text cut, cleanup, comping, moves) therefore cuts the picture as well.
import type { Camera, CameraSync, Clip, DirectorCut, Frames, Project, Track, VideoSettings } from '../shared/types';

/** Clips of the same recording whose gap is bridged when it is shorter than this (seconds). */
const BRIDGE_TOLERANCE_S = 0.01;
/** Default video size when the episode has none set: the first camera's, else 1080p30. */
export const DEFAULT_VIDEO: VideoSettings = { width: 1920, height: 1080, fps: 30 };
export const MAX_CAMERAS = 9;

export const CAMERA_COLORS = ['#4fc3f7', '#ffb74d', '#ba68c8', '#81c784', '#f06292', '#ffd54f', '#4db6ac', '#9575cd', '#e57373'];

export function cameraTrack(project: Project, cameraId: string): Track | undefined {
  return project.tracks.find((t) => t.cameraId === cameraId);
}

export function cameraById(project: Project, id: string): Camera | undefined {
  return project.cameras?.find((c) => c.id === id);
}

/** Camera number (1-based, the key that picks it) or 0. */
export function cameraNumber(project: Project, id: string): number {
  return (project.cameras?.findIndex((c) => c.id === id) ?? -1) + 1;
}

export function syncFor(camera: Camera, file: string): CameraSync | undefined {
  return camera.sync.find((s) => s.file === file);
}

/** Seconds into the camera's video for a frame of an audio file, or null if the file isn't synced. */
export function videoTimeOf(camera: Camera, file: string, frame: number, sampleRate: number): number | null {
  const s = syncFor(camera, file);
  if (!s) return null;
  return s.offset + (frame / sampleRate) * s.rate;
}

/**
 * The clip whose sound is heard at `t` on a track (clips sorted by start). Where two overlap
 * (a crossfade), the picture switches in the middle of the overlap.
 */
export function clipAt(track: Track, t: Frames): Clip | undefined {
  let found: Clip | undefined;
  for (const c of track.clips) {
    if (c.start > t) break;
    if (t >= c.start + c.length) continue;
    if (!found) {
      found = c;
      continue;
    }
    // overlap of `found` and `c`: the later clip takes over in the middle
    const end = Math.min(found.start + found.length, c.start + c.length);
    const mid = (c.start + end) / 2;
    if (t >= mid) found = c;
  }
  return found;
}

/** Source frame of `clip` at timeline `t`; null for sound-designed clips (reverse, varispeed, loop), which freeze. */
function sourceFrame(clip: Clip, t: Frames): number {
  if (clip.sound) return clip.offset;
  return clip.offset + (t - clip.start);
}

/**
 * Seconds into `camera`'s video at timeline frame `t`, or null when it has no picture there.
 * A gap between two clips of the same recording that run on without a jump (a cough deleted
 * without closing the gap) keeps showing the video.
 */
export function cameraTimeAt(project: Project, camera: Camera, t: Frames): number | null {
  const track = cameraTrack(project, camera.id);
  if (!track) return null;
  const sr = project.sampleRate;
  const clip = clipAt(track, t);
  if (clip) return videoTimeOf(camera, clip.file, sourceFrame(clip, t), sr);
  // bridge a gap inside one recording
  let prev: Clip | undefined;
  let next: Clip | undefined;
  for (const c of track.clips) {
    if (c.start + c.length <= t) {
      if (!prev || c.start + c.length > prev.start + prev.length) prev = c;
    } else if (c.start > t) {
      next = c;
      break;
    }
  }
  if (!prev || !next || prev.file !== next.file || prev.sound || next.sound) return null;
  const jump = next.offset - next.start - (prev.offset - prev.start);
  if (Math.abs(jump) > BRIDGE_TOLERANCE_S * sr) return null;
  return videoTimeOf(camera, prev.file, prev.offset + (t - prev.start), sr);
}

/**
 * The next timeline frame after `t` (up to `limit`) where the camera's picture jumps (a cut, a
 * clip boundary that isn't continuous), or null. Used to start decoding a cut before it plays.
 */
export function nextJump(project: Project, camera: Camera, t: Frames, limit: Frames): Frames | null {
  const track = cameraTrack(project, camera.id);
  if (!track) return null;
  const sr = project.sampleRate;
  const step = Math.max(1, Math.round(sr / 100));
  let best: Frames | null = null;
  for (const c of track.clips) {
    for (const edge of [c.start, c.start + c.length]) {
      if (edge <= t || edge > limit || (best !== null && edge >= best)) continue;
      const before = cameraTimeAt(project, camera, edge - step);
      const after = cameraTimeAt(project, camera, edge);
      if (before === null || after === null || Math.abs(after - (before + step / sr)) > 0.02) best = edge;
    }
  }
  return best;
}

// ---------------------------------------------------------------- director

export function directorCuts(project: Project): DirectorCut[] {
  return project.director?.cuts ?? [];
}

/** Index of the director cut in force at `t` (the last one at or before it), or -1. */
export function shotIndexAt(cuts: readonly DirectorCut[], t: Frames): number {
  let lo = 0;
  let hi = cuts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cuts[mid].at <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** The camera the director chose for `t` (before falling back for a missing picture). */
export function directedCameraAt(project: Project, t: Frames): string | undefined {
  const cuts = directorCuts(project);
  const i = shotIndexAt(cuts, t);
  if (i >= 0) return cuts[i].camera;
  // before the first switch: the first switch's camera, else the first camera
  return cuts[0]?.camera ?? project.cameras?.[0]?.id;
}

export interface ProgramLayer {
  camera: string;
  /** Seconds into the camera's video. */
  time: number;
}

/** What the program shows at `t`: one camera, or two during a dissolve (`mix` 0..1 towards `b`). */
export interface ProgramFrame {
  a: ProgramLayer | null;
  b?: ProgramLayer;
  mix?: number;
}

/**
 * The camera actually shown for `camera` at `t`: itself if it has a picture there, else the other
 * cameras in their order (put the wide shot first), else none.
 */
export function layerAt(project: Project, cameraId: string | undefined, t: Frames): ProgramLayer | null {
  const cams = project.cameras ?? [];
  const wanted = cams.find((c) => c.id === cameraId);
  for (const c of wanted ? [wanted, ...cams.filter((x) => x !== wanted)] : cams) {
    const time = cameraTimeAt(project, c, t);
    if (time !== null) return { camera: c.id, time };
  }
  return null;
}

export function programAt(project: Project, t: Frames): ProgramFrame {
  const cuts = directorCuts(project);
  const i = shotIndexAt(cuts, t);
  const b = layerAt(project, directedCameraAt(project, t), t);
  if (i > 0 && cuts[i].dissolve && t < cuts[i].at + cuts[i].dissolve!) {
    const a = layerAt(project, cuts[i - 1].camera, t);
    if (a && b && a.camera !== b.camera) return { a, b, mix: (t - cuts[i].at) / cuts[i].dissolve! };
  }
  return { a: b };
}

/** Sorted, without switches to the camera already showing and without unknown cameras. */
export function normalizeCuts(cuts: readonly DirectorCut[], cameraIds?: ReadonlySet<string>): DirectorCut[] {
  const sorted = cuts
    .filter((c) => Number.isFinite(c.at) && c.at >= 0 && typeof c.camera === 'string' && (!cameraIds || cameraIds.has(c.camera)))
    .map((c) => ({ at: Math.round(c.at), camera: c.camera, ...(c.dissolve && c.dissolve > 0 ? { dissolve: Math.round(c.dissolve) } : {}) }))
    .sort((a, b) => a.at - b.at);
  const byAt: DirectorCut[] = [];
  for (const c of sorted) {
    if (byAt.length && byAt[byAt.length - 1].at === c.at) byAt[byAt.length - 1] = c;
    else byAt.push(c);
  }
  const out: DirectorCut[] = [];
  for (const c of byAt) if (out[out.length - 1]?.camera !== c.camera) out.push(c);
  return out;
}

function withCuts(project: Project, cuts: DirectorCut[]): Project {
  return { ...project, director: { ...(project.director ?? {}), cuts: normalizeCuts(cuts) } };
}

/** Switches to `camera` at `at` (the switch already there is replaced). */
export function setCut(project: Project, at: Frames, camera: string, dissolve?: Frames): Project {
  const cuts = directorCuts(project).filter((c) => c.at !== Math.round(at));
  cuts.push({ at: Math.round(at), camera, ...(dissolve ? { dissolve } : {}) });
  return withCuts(project, cuts);
}

/** Changes the camera of the shot at `t` (from its switch to the next one). */
export function setShotCamera(project: Project, t: Frames, camera: string): Project {
  const cuts = [...directorCuts(project)];
  const i = shotIndexAt(cuts, t);
  if (i < 0) cuts.unshift({ at: 0, camera });
  else cuts[i] = { ...cuts[i], camera };
  return withCuts(project, cuts);
}

export function removeCut(project: Project, at: Frames): Project {
  return withCuts(
    project,
    directorCuts(project).filter((c) => c.at !== at),
  );
}

export function moveCut(project: Project, from: Frames, to: Frames): Project {
  const cuts = directorCuts(project);
  const i = cuts.findIndex((c) => c.at === from);
  if (i < 0) return project;
  const lo = i > 0 ? cuts[i - 1].at + 1 : 0;
  const hi = i + 1 < cuts.length ? cuts[i + 1].at - 1 : Infinity;
  const at = Math.max(lo, Math.min(hi, Math.round(to)));
  return withCuts(
    project,
    cuts.map((c, k) => (k === i ? { ...c, at } : c)),
  );
}

export function setDissolve(project: Project, at: Frames, length: Frames): Project {
  return withCuts(
    project,
    directorCuts(project).map((c) => (c.at === at ? { at: c.at, camera: c.camera, ...(length > 0 ? { dissolve: Math.round(length) } : {}) } : c)),
  );
}

/**
 * A watch-through pass from `from` to `to`: its switches replace the ones in between, and what was
 * on screen at `to` before stays on from there.
 */
export function applyPass(project: Project, from: Frames, to: Frames, pass: readonly DirectorCut[]): Project {
  const cuts = directorCuts(project);
  const inside = pass.filter((c) => c.at >= from && c.at < to);
  if (!inside.length) return project;
  const atEnd = directedCameraAt(project, to);
  const before = cuts.filter((c) => c.at < from);
  const after = cuts.filter((c) => c.at >= to);
  const out = [...before, ...inside];
  // the old shot carries on after the pass
  if (atEnd && !after.some((c) => c.at === to)) out.push({ at: to, camera: atEnd });
  out.push(...after);
  return withCuts(project, out);
}

/** Ripple delete of [start, end): switches inside go; the shot running at `end` starts at `start`. */
export function rippleDeleteCuts(cuts: readonly DirectorCut[], start: Frames, end: Frames): DirectorCut[] {
  if (!cuts.length || end <= start) return [...cuts];
  const len = end - start;
  const i = shotIndexAt(cuts, end);
  const running = i >= 0 && cuts[i].at >= start ? cuts[i] : undefined;
  const out = cuts.filter((c) => c.at < start);
  if (running) out.push({ ...running, at: start });
  for (const c of cuts) if (c.at >= end) out.push({ ...c, at: c.at - len });
  return normalizeCuts(out);
}

/** Moves switches at or after `from` by `delta` frames (insert, paste, ripple drag). */
export function shiftCuts(cuts: readonly DirectorCut[], from: Frames, delta: Frames): DirectorCut[] {
  return normalizeCuts(cuts.map((c) => (c.at >= from ? { ...c, at: Math.max(0, c.at + delta) } : c)));
}

/** Applies `fn` to the project's director switches, if it has any. */
export function mapDirector(project: Project, fn: (cuts: DirectorCut[]) => DirectorCut[]): void {
  if (project.director?.cuts.length) project.director = { ...project.director, cuts: fn(project.director.cuts) };
}

/** Shots shorter than `min` frames (shown as a warning in the director lane). */
export function shortShots(project: Project, min: Frames): Frames[] {
  const cuts = directorCuts(project);
  const out: Frames[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) if (cuts[i + 1].at - cuts[i].at < min) out.push(cuts[i].at);
  return out;
}

/** Shots as spans [start, end) with their camera, up to `end`. */
export function shots(project: Project, end: Frames): Array<{ start: Frames; end: Frames; camera: string; index: number }> {
  const cuts = directorCuts(project);
  const out: Array<{ start: Frames; end: Frames; camera: string; index: number }> = [];
  cuts.forEach((c, i) => {
    const e = i + 1 < cuts.length ? cuts[i + 1].at : Math.max(end, c.at);
    if (e > c.at) out.push({ start: c.at, end: e, camera: c.camera, index: i });
  });
  return out;
}

// ---------------------------------------------------------------- cameras

/** A new camera's sync entry for its own extracted sound: frame 0 of the WAV is `audioStart` in the video. */
export function ownSync(audioFile: string, audioStart: number): CameraSync {
  return { file: audioFile, offset: audioStart, rate: 1 };
}

/**
 * After Align to other track resampled files to fix clock drift (old file → copy stretched by
 * `stretch` = 1 + drift), cameras that followed the old file follow the copy as well.
 */
export function cameraSyncAfterStretch(project: Project, files: Record<string, string>, stretch: number): Project {
  if (!project.cameras?.length || !Object.keys(files).length || !(stretch > 0)) return project;
  return {
    ...project,
    cameras: project.cameras.map((cam) => {
      const added: CameraSync[] = [];
      for (const [from, to] of Object.entries(files)) {
        const s = syncFor(cam, from);
        if (s && !syncFor(cam, to)) added.push({ file: to, offset: s.offset, rate: s.rate / stretch });
      }
      return added.length ? { ...cam, sync: [...cam.sync, ...added] } : cam;
    }),
  };
}

/** Removes a camera, its sound track and its director switches. */
export function removeCamera(project: Project, cameraId: string): Project {
  const cameras = (project.cameras ?? []).filter((c) => c.id !== cameraId);
  const tracks = project.tracks.filter((t) => t.cameraId !== cameraId);
  const left = new Set(cameras.map((c) => c.id));
  const cuts = normalizeCuts(directorCuts(project).filter((c) => c.camera !== cameraId), left);
  const p: Project = { ...project, tracks, cameras };
  if (!cameras.length) {
    delete p.cameras;
    delete p.director;
  } else p.director = { cuts };
  return p;
}

export function updateCamera(project: Project, cameraId: string, patch: Partial<Camera>): Project {
  return { ...project, cameras: (project.cameras ?? []).map((c) => (c.id === cameraId ? { ...c, ...patch } : c)) };
}

/** Moves a camera one place up or down (its number and the fallback order change with it). */
export function moveCamera(project: Project, cameraId: string, dir: -1 | 1): Project {
  const cams = [...(project.cameras ?? [])];
  const i = cams.findIndex((c) => c.id === cameraId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= cams.length) return project;
  [cams[i], cams[j]] = [cams[j], cams[i]];
  return { ...project, cameras: cams };
}

/** The exported video's size and rate: the episode's setting, else from the first camera. */
export function videoSettings(project: Project): VideoSettings {
  if (project.video) return project.video;
  const cam = project.cameras?.[0];
  if (!cam) return DEFAULT_VIDEO;
  const landscape = cam.width >= cam.height;
  const h = landscape ? Math.min(1080, cam.height) : Math.min(1920, cam.height);
  const w = Math.round((h * cam.width) / cam.height / 2) * 2;
  const fps = cam.fps > 0 && cam.fps <= 60 ? Math.round(cam.fps * 1000) / 1000 : 30;
  return { width: w || 1920, height: h || 1080, fps };
}

/**
 * Where the camera picture lands in an output frame: the source rectangle (in video pixels) that
 * fills the frame, cropped to the output's shape (cover) and then zoomed by the framing.
 */
export function sourceRect(cam: Pick<Camera, 'width' | 'height' | 'framing'>, outW: number, outH: number): { sx: number; sy: number; sw: number; sh: number } {
  const zoom = Math.max(1, cam.framing?.zoom ?? 1);
  const outAspect = outW / outH;
  let sw = cam.width;
  let sh = cam.width / outAspect;
  if (sh > cam.height) {
    sh = cam.height;
    sw = cam.height * outAspect;
  }
  sw /= zoom;
  sh /= zoom;
  const fx = Math.max(-1, Math.min(1, cam.framing?.x ?? 0));
  const fy = Math.max(-1, Math.min(1, cam.framing?.y ?? 0));
  const sx = ((cam.width - sw) / 2) * (1 + fx);
  const sy = ((cam.height - sh) / 2) * (1 + fy);
  return { sx, sy, sw, sh };
}

/** Tidies cameras and director switches of a loaded project (unknown cameras' switches go). */
export function normalizeVideo(p: Project): void {
  const cams = Array.isArray(p.cameras)
    ? p.cameras
        .filter((c) => c && typeof c.id === 'string' && typeof c.file === 'string')
        .slice(0, MAX_CAMERAS)
        .map((c, i) => ({
          id: c.id,
          name: typeof c.name === 'string' && c.name ? c.name : `Camera ${i + 1}`,
          color: typeof c.color === 'string' ? c.color : CAMERA_COLORS[i % CAMERA_COLORS.length],
          file: c.file,
          width: Number(c.width) || 1920,
          height: Number(c.height) || 1080,
          fps: Number(c.fps) || 30,
          duration: Number(c.duration) || 0,
          ...(typeof c.codec === 'string' ? { codec: c.codec } : {}),
          sync: (Array.isArray(c.sync) ? c.sync : [])
            .filter((s) => s && typeof s.file === 'string' && Number.isFinite(s.offset) && Number(s.rate) > 0)
            .map((s) => ({ file: s.file, offset: s.offset, rate: s.rate })),
          ...(c.framing && Number.isFinite(c.framing.zoom)
            ? { framing: { zoom: Math.max(1, Math.min(4, c.framing.zoom)), x: clamp1(c.framing.x), y: clamp1(c.framing.y) } }
            : {}),
          ...(Array.isArray(c.speakers) ? { speakers: c.speakers.filter((s) => typeof s === 'string') } : {}),
        }))
    : [];
  if (!cams.length) {
    delete p.cameras;
    delete p.director;
    delete p.video;
    for (const t of p.tracks) delete t.cameraId;
    return;
  }
  p.cameras = cams;
  const ids = new Set(cams.map((c) => c.id));
  for (const t of p.tracks) if (t.cameraId && !ids.has(t.cameraId)) delete t.cameraId;
  p.director = { cuts: normalizeCuts(Array.isArray(p.director?.cuts) ? p.director!.cuts : [], ids) };
  if (p.video) {
    const v = p.video;
    if (!(v.width > 0 && v.height > 0 && v.fps > 0)) delete p.video;
    else p.video = { width: Math.round(v.width / 2) * 2, height: Math.round(v.height / 2) * 2, fps: Math.min(120, v.fps) };
  }
}

function clamp1(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(-1, Math.min(1, n)) : 0;
}
