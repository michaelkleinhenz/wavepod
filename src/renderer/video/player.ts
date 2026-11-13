// Shows the cameras while the episode plays or the playhead moves: the program (what the director
// chose, with dissolves) and each camera on its own. The sound engine is the clock; pictures that
// decode late are skipped, the sound never waits for them.
import type { Camera, Project } from "../../shared/types";
import {
  cameraTimeAt,
  cameraTrack,
  layerAt,
  programAt,
  sourceRect,
  videoSettings,
  type ProgramFrame,
} from "../../core/video";
import { LiveFrame } from "./media";
import { store } from "../store";

/** Anything that can be drawn as a camera picture (a decoded frame canvas, or a view of one). */
export type Picture = CanvasImageSource & { width: number; height: number };

/**
 * Draws a program frame into a w×h area: each camera cropped to the frame's shape and framed as
 * set; during a dissolve the second camera fades in over the first.
 */
export function drawProgram(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  project: Project,
  frame: ProgramFrame,
  picture: (cameraId: string) => Picture | null,
  w: number,
  h: number,
): void {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  const layer = (cameraId: string, alpha: number) => {
    const cam = project.cameras?.find((c) => c.id === cameraId);
    const pic = picture(cameraId);
    if (!cam || !pic || !pic.width) return;
    const r = sourceRect(cam, w, h);
    // the picture may be a scaled-down decode of the camera's frame
    const k = pic.width / cam.width;
    ctx.globalAlpha = alpha;
    ctx.drawImage(pic, r.sx * k, r.sy * k, r.sw * k, r.sh * k, 0, 0, w, h);
    ctx.globalAlpha = 1;
  };
  if (frame.a) layer(frame.a.camera, 1);
  if (frame.b) layer(frame.b.camera, Math.max(0, Math.min(1, frame.mix ?? 1)));
}

type Display =
  | { canvas: HTMLCanvasElement; kind: "program" }
  | {
      canvas: HTMLCanvasElement;
      kind: "camera";
      cameraId: string;
      /** show its first picture where it has none at the playhead */ fallback?: boolean;
    };

class VideoPlayer {
  private frames = new Map<string, LiveFrame>();
  private displays = new Set<Display>();
  private raf = 0;
  /** Transport position and when it arrived, to move the picture on smoothly between updates. */
  private anchor = { pos: 0, at: 0, playing: false };
  /** Called after each drawn frame with the program frame (for labels). */
  onFrame: (frame: ProgramFrame, pos: number) => void = () => {};
  /** While directing live: the camera chosen so far, shown instead of the stored switches. */
  override: ((pos: number) => string | null) | null = null;
  private frameListeners = new Set<
    (frame: ProgramFrame, pos: number) => void
  >();

  /** Extra listener for each drawn frame (the watch-through view). */
  listen(fn: (frame: ProgramFrame, pos: number) => void): () => void {
    this.frameListeners.add(fn);
    return () => this.frameListeners.delete(fn);
  }

  constructor() {
    store.subscribe((kinds) => {
      if (kinds.has("transport")) {
        const t = store.transport;
        this.anchor = {
          pos: t.position,
          at: performance.now(),
          playing: t.state === "playing",
        };
      }
      if (kinds.has("project")) this.syncCameras();
      if (this.displays.size) this.kick();
    });
  }

  /** Timeline frame now, moved on from the last transport update while playing. */
  position(): number {
    const a = this.anchor;
    if (!a.playing) return store.transport.position;
    return (
      a.pos +
      ((performance.now() - a.at) / 1000) * store.sampleRate * store.speed
    );
  }

  get playing(): boolean {
    return this.anchor.playing;
  }

  attach(d: Display): () => void {
    this.displays.add(d);
    this.syncCameras();
    this.kick();
    return () => {
      this.displays.delete(d);
      if (!this.displays.size) this.idle();
    };
  }

  /** Error text of a camera's file, if it can't be shown. */
  error(cameraId: string): string | null {
    const cam = store.project.cameras?.find((c) => c.id === cameraId);
    return cam ? (this.frames.get(key(cam))?.error ?? null) : null;
  }

  private syncCameras(): void {
    const cams = store.project?.cameras ?? [];
    const keys = new Set(cams.map(key));
    for (const [k, f] of this.frames) {
      if (!keys.has(k)) {
        f.dispose();
        this.frames.delete(k);
      }
    }
    if (!this.displays.size) return;
    for (const cam of cams) {
      if (this.frames.has(key(cam))) continue;
      const f = new LiveFrame(cam.file, 1280);
      f.onDraw = () => this.kick();
      this.frames.set(key(cam), f);
    }
  }

  private idle(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    // free the decoders while nothing shows video
    for (const f of this.frames.values()) f.dispose();
    this.frames.clear();
  }

  private kick(): void {
    if (!this.raf && this.displays.size)
      this.raf = requestAnimationFrame(() => this.tick());
  }

  private tick(): void {
    this.raf = 0;
    const project = store.project;
    if (!project?.cameras?.length || !this.displays.size) return;
    const pos = this.position();
    const forced = this.override?.(pos) ?? null;
    const frame: ProgramFrame = forced
      ? { a: layerAt(project, forced, pos) }
      : programAt(project, pos);
    const needed = new Set<string>();
    if (frame.a) needed.add(frame.a.camera);
    if (frame.b) needed.add(frame.b.camera);
    const fallback = new Set<string>();
    for (const d of this.displays)
      if (d.kind === "camera") {
        needed.add(d.cameraId);
        if (d.fallback) fallback.add(d.cameraId);
      }
    const timeOf = (cam: Camera): number | null => {
      const t = cameraTimeAt(project, cam, pos);
      if (t !== null || !fallback.has(cam.id)) return t;
      const first = cameraTrack(project, cam.id)?.clips.reduce(
        (m, c) => Math.min(m, c.start),
        Infinity,
      );
      return first !== undefined && Number.isFinite(first)
        ? cameraTimeAt(project, cam, first)
        : null;
    };
    const wanted = new Map<string, number | null>();
    for (const cam of project.cameras) {
      const f = this.frames.get(key(cam));
      if (!f) continue;
      const t = needed.has(cam.id) ? timeOf(cam) : null;
      wanted.set(cam.id, t);
      f.want(t);
    }
    const picture = (id: string) => {
      const cam = project.cameras!.find((c) => c.id === id);
      const f = cam && this.frames.get(key(cam));
      return f && f.shown !== null ? f.view : null;
    };
    for (const d of this.displays) {
      const ctx = d.canvas.getContext("2d")!;
      const w = d.canvas.width;
      const h = d.canvas.height;
      if (d.kind === "program") drawProgram(ctx, project, frame, picture, w, h);
      else {
        const t = d.fallback
          ? (wanted.get(d.cameraId) ?? null)
          : cameraTimeAt(
              project,
              project.cameras.find((c) => c.id === d.cameraId)!,
              pos,
            );
        drawProgram(
          ctx,
          project,
          t === null ? { a: null } : { a: { camera: d.cameraId, time: t } },
          picture,
          w,
          h,
        );
      }
    }
    this.onFrame(frame, pos);
    for (const fn of this.frameListeners) fn(frame, pos);
    if (this.anchor.playing) this.kick();
  }
}

function key(cam: Camera): string {
  return `${cam.id}|${cam.file}`;
}

export const videoPlayer = new VideoPlayer();

/** Output aspect ratio of the episode's video. */
export function outputAspect(project: Project): number {
  const v = videoSettings(project);
  return v.width / v.height;
}
