// View › Video: the program monitor (what the video export will show) and every camera below it.
// Click a camera to switch to it at the playhead; right-click for its settings.
import type { Camera, Project } from '../../shared/types';
import { cameraNumber, cameraTrack, setCut, videoSettings } from '../../core/video';
import { formatTimestamp } from '../../shared/time';
import { showContextMenu, type ContextMenuEntry } from '../contextMenu';
import { h, toast } from '../dom';
import { askName } from '../nameDialog';
import { store } from '../store';
import { deleteCamera, importVideos, renameCamera, setFraming, setSpeakers, shiftCamera, syncAllCameras, syncCamera } from './cameras';
import { videoPlayer } from './player';

export class VideoPanel {
  readonly el = h('aside', { class: 'video-panel', tabIndex: -1 });
  private program = h('canvas', { class: 'video-program' });
  private programLabel = h('div', { class: 'video-program-label' });
  private tiles = h('div', { class: 'video-tiles' });
  private body = h('div', { class: 'video-body' });
  private shown = false;
  private hidden = false;
  private detach: Array<() => void> = [];
  private tileKey = '';
  onOpen: () => void = () => {};
  onWatchThrough: () => void = () => {};
  onAutoDirect: () => void = () => {};
  onExport: () => void = () => {};

  constructor() {
    this.el.append(
      h(
        'div',
        { class: 'fx-head' },
        h('div', null, h('div', { class: 'fx-kicker' }, 'Video podcast'), h('h2', null, 'Cameras')),
        h('button', { class: 'fx-close', title: 'Close', onclick: () => this.close() }, '×'),
      ),
      this.body,
    );
    videoPlayer.onFrame = (frame, pos) => {
      if (!this.shown) return;
      const cam = frame.b ?? frame.a;
      const c = cam && store.project.cameras?.find((x) => x.id === cam.camera);
      this.programLabel.textContent = c ? `${cameraNumber(store.project, c.id)} · ${c.name}${frame.b ? ' (dissolve)' : ''}` : 'No picture here';
      this.programLabel.style.borderColor = c?.color ?? 'transparent';
      for (const tile of this.tiles.children) (tile as HTMLElement).classList.toggle('live', !!cam && (tile as HTMLElement).dataset.camera === cam.camera);
      void pos;
    };
  }

  get isOpen(): boolean {
    return this.shown;
  }

  toggle(): void {
    if (this.shown) this.close();
    else this.open();
  }

  open(): void {
    if (!this.shown) this.onOpen();
    this.shown = true;
    document.body.classList.add('video-open');
    this.render(true);
    if (!this.hidden) document.getElementById('app')!.append(this.el);
    this.attach();
  }

  close(): void {
    this.shown = false;
    document.body.classList.remove('video-open');
    this.el.remove();
    this.release();
  }

  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    if (hidden) {
      this.el.remove();
      document.body.classList.remove('video-open');
      this.release();
    } else if (this.shown) {
      document.body.classList.add('video-open');
      document.getElementById('app')!.append(this.el);
      this.render(true);
      this.attach();
    }
  }

  /** Called when the project changes. */
  refresh(): void {
    if (this.shown && !this.hidden) this.render(false);
  }

  private attach(): void {
    this.release();
    if (!this.shown || this.hidden) return;
    this.detach.push(videoPlayer.attach({ canvas: this.program, kind: 'program' }));
    for (const tile of this.tiles.querySelectorAll<HTMLCanvasElement>('canvas[data-camera]')) {
      this.detach.push(videoPlayer.attach({ canvas: tile, kind: 'camera', cameraId: tile.dataset.camera! }));
    }
  }

  private release(): void {
    for (const d of this.detach) d();
    this.detach = [];
  }

  private render(force: boolean): void {
    const p = store.project;
    const cams = p.cameras ?? [];
    const key = JSON.stringify([cams.map((c) => [c.id, c.name, c.color, c.file]), videoSettings(p)]);
    if (!force && key === this.tileKey) return;
    this.tileKey = key;
    const v = videoSettings(p);
    this.program.width = 384 * 2;
    this.program.height = Math.round((384 * 2 * v.height) / v.width);
    if (!cams.length) {
      this.body.replaceChildren(
        h(
          'div',
          { class: 'video-empty' },
          h('p', null, 'Make a video podcast from the camera recordings of the conversation.'),
          h(
            'ol',
            { class: 'muted' },
            h('li', null, 'Import each camera’s video. Its sound comes along on a muted track.'),
            h('li', null, 'Sync the cameras to a microphone recording (Sync cameras, below).'),
            h('li', null, 'Edit the audio as usual: every cut applies to the video too.'),
            h('li', null, 'Watch it through and switch cameras with 1–9, or let Auto-direct do a first pass.'),
            h('li', null, 'File › Export Video…'),
          ),
          h('button', { class: 'primary', onclick: () => void importVideos() }, 'Import camera video…'),
        ),
      );
      this.release();
      return;
    }
    this.tiles.replaceChildren(...cams.map((c, i) => this.tile(c, i + 1, v)));
    this.body.replaceChildren(
      h('div', { class: 'video-program-wrap' }, this.program, this.programLabel),
      h(
        'div',
        { class: 'video-actions' },
        h('button', { class: 'primary', title: 'Play the episode in a large view and switch cameras with 1–9 as you watch (W)', onclick: () => this.onWatchThrough() }, 'Watch through (W)'),
        h('button', { title: 'Cut to whoever is speaking: a first pass to refine', onclick: () => this.onAutoDirect() }, 'Auto-direct…'),
        h('button', { title: 'File › Export Video…', onclick: () => this.onExport() }, 'Export video…'),
      ),
      this.tiles,
      h(
        'div',
        { class: 'video-actions' },
        h('button', { onclick: () => void importVideos() }, 'Import camera…'),
        h('button', { title: 'Line every camera’s sound up with a microphone recording, clock drift included', onclick: () => void syncAllCameras() }, 'Sync cameras…'),
      ),
      h('p', { class: 'muted video-hint' }, 'Click a camera to switch to it at the playhead (or Alt+1–9). Right-click it for framing, its speakers and more.'),
    );
    this.attach();
  }

  private tile(cam: Camera, n: number, v: { width: number; height: number }): HTMLElement {
    const canvas = h('canvas', { class: 'video-tile-canvas', 'data-camera': cam.id });
    canvas.width = 320;
    canvas.height = Math.round((320 * v.height) / v.width);
    const err = videoPlayer.error(cam.id);
    const el = h(
      'button',
      {
        class: 'video-tile',
        'data-camera': cam.id,
        style: `--cam-color: ${cam.color}`,
        title: `${cam.name}: click to switch to this camera at the playhead (Alt+${n})`,
        onclick: () => switchAtPlayhead(cam.id),
        oncontextmenu: (e: MouseEvent) => {
          e.preventDefault();
          showCameraMenu(cam.id, e.pageX, e.pageY);
        },
      },
      canvas,
      h('span', { class: 'video-tile-name' }, h('b', null, String(n)), ` ${cam.name}`),
      err ? h('span', { class: 'video-tile-error' }, err) : null,
    );
    return el;
  }
}

/** Switches the program to a camera at the playhead (the switch at that very spot is replaced). */
export function switchAtPlayhead(cameraId: string, at = videoPlayer.position()): void {
  const p = store.project;
  if (!p.cameras?.some((c) => c.id === cameraId)) return;
  store.edit((q) => setCut(q, at, cameraId));
  const cam = p.cameras.find((c) => c.id === cameraId)!;
  toast(`${cam.name} from ${formatTimestamp(at / store.sampleRate)}`);
}

export function showCameraMenu(cameraId: string, x: number, y: number): void {
  const p = store.project;
  const cams = p.cameras ?? [];
  const i = cams.findIndex((c) => c.id === cameraId);
  const cam = cams[i];
  if (!cam) return;
  const entries: ContextMenuEntry[] = [
    { kind: 'header', label: `Camera ${i + 1}: ${cam.name}` },
    { label: 'Switch to It at the Playhead', accel: `Alt+${i + 1}`, run: () => switchAtPlayhead(cameraId) },
    { label: 'Sync to Audio…', title: 'Line this camera’s sound up with a microphone recording', run: () => void syncCamera(cameraId) },
    { label: 'Framing…', title: 'Zoom into the picture and move the crop', run: () => openFraming(cameraId) },
    { label: 'Who Is in the Picture…', title: 'For Auto-direct: the speakers this camera shows', run: () => openSpeakers(cameraId) },
    {
      label: 'Rename…',
      run: () =>
        void askName({ title: 'Rename camera', value: cam.name, ok: 'Rename' }).then((n) => {
          if (n) renameCamera(cameraId, n);
        }),
    },
    { kind: 'separator' },
    { label: 'Move Up (Earlier Number)', enabled: i > 0, run: () => shiftCamera(cameraId, -1) },
    { label: 'Move Down', enabled: i < cams.length - 1, run: () => shiftCamera(cameraId, 1) },
    { kind: 'separator' },
    { label: 'Remove Camera', title: 'Removes the camera, its sound track and its switches (the video file stays)', run: () => deleteCamera(cameraId) },
  ];
  showContextMenu(entries, x, y);
}

function overlay(title: string, body: HTMLElement[], onClose: () => void = () => {}): HTMLElement {
  const close = () => {
    window.removeEventListener('keydown', onKey, true);
    el.remove();
    onClose();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' || e.key === 'Enter') {
      e.stopPropagation();
      close();
    }
  };
  window.addEventListener('keydown', onKey, true);
  const el = h('div', { class: 'overlay' }, h('div', { class: 'dialog narrow' }, h('h2', null, title), ...body, h('div', { class: 'row end' }, h('button', { class: 'primary', onclick: close }, 'Done'))));
  el.addEventListener('mousedown', (e) => e.target === el && close());
  document.body.append(el);
  return el;
}

/** Framing: zoom and crop position, previewed live. */
function openFraming(cameraId: string): void {
  const cam = store.project.cameras?.find((c) => c.id === cameraId);
  if (!cam) return;
  const f = { zoom: 1, x: 0, y: 0, ...cam.framing };
  const preview = h('canvas', { class: 'video-framing-preview' });
  const v = videoSettings(store.project);
  preview.width = 480;
  preview.height = Math.round((480 * v.height) / v.width);
  const detach = videoPlayer.attach({ canvas: preview, kind: 'camera', cameraId, fallback: true });
  const slider = (label: string, key: 'zoom' | 'x' | 'y', min: number, max: number) =>
    h(
      'label',
      { class: 'video-slider' },
      h('span', null, label),
      h('input', {
        type: 'range',
        min: String(min),
        max: String(max),
        step: '0.01',
        value: String(f[key]),
        oninput: (e: Event) => {
          f[key] = Number((e.target as HTMLInputElement).value);
          setFraming(cameraId, { ...f }, true);
        },
        onchange: () => store.commitLive(),
      }),
    );
  overlay(
    `Framing: ${cam.name}`,
    [
      preview,
      slider('Zoom', 'zoom', 1, 3),
      slider('Left ↔ right', 'x', -1, 1),
      slider('Up ↕ down', 'y', -1, 1),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            onclick: (e: MouseEvent) => {
              setFraming(cameraId, undefined);
              const dlg = (e.target as HTMLElement).closest('.dialog')!;
              for (const i of dlg.querySelectorAll<HTMLInputElement>('input[type=range]')) i.value = i.closest('label')!.textContent!.startsWith('Zoom') ? '1' : '0';
              Object.assign(f, { zoom: 1, x: 0, y: 0 });
            },
          },
          'Reset',
        ),
      ),
    ],
    detach,
  );
}

/** Which speakers a camera shows (Auto-direct cuts to the camera of whoever speaks). */
function openSpeakers(cameraId: string): void {
  const p: Project = store.project;
  const cam = p.cameras?.find((c) => c.id === cameraId);
  if (!cam) return;
  const chosen = new Set(cam.speakers ?? []);
  const tracks = p.tracks.filter((t) => !t.cameraId && t.kind !== 'soundboard');
  overlay(`Who is in the picture: ${cam.name}`, [
    h('p', { class: 'muted' }, 'Auto-direct shows this camera while one of these people speaks. Tick everyone for a wide shot.'),
    ...tracks.map((t) =>
      h(
        'label',
        { class: 'video-speaker' },
        h('input', {
          type: 'checkbox',
          checked: chosen.has(t.id),
          onchange: (e: Event) => {
            if ((e.target as HTMLInputElement).checked) chosen.add(t.id);
            else chosen.delete(t.id);
            setSpeakers(cameraId, [...chosen]);
          },
        }),
        h('span', { class: 'dot', style: { background: t.color } }),
        t.name,
      ),
    ),
    tracks.length ? null : h('p', null, 'There are no microphone tracks yet.'),
  ].filter(Boolean) as HTMLElement[]);
}

/** The camera track's id for a camera (for menus elsewhere). */
export function cameraTrackId(cameraId: string): string | undefined {
  return cameraTrack(store.project, cameraId)?.id;
}
