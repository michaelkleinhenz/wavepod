// The director lane above the tracks: which camera is seen when. Each shot is a block in its
// camera's colour; drag a block's left edge to move the switch, click to go there, right-click to
// change the camera, add a dissolve or remove the switch.
import { cameraNumber, directorCuts, moveCut, removeCut, setCut, setDissolve, setShotCamera, shotIndexAt, shots } from '../../core/video';
import { snapToWords } from '../../core/autoDirect';
import { showContextMenu, type ContextMenuEntry } from '../contextMenu';
import { h } from '../dom';
import { store } from '../store';
import { transcripts } from '../transcripts';

export const DIRECTOR_H = 30;
const EDGE_PX = 5;
const MIN_SHOT_S = 1.5;

export interface LaneView {
  xOf(frame: number): number;
  frameOf(x: number): number;
  width(): number;
  seek(frame: number): void;
}

export class DirectorLane {
  readonly canvas = h('canvas', { class: 'director-canvas' });
  readonly el: HTMLElement;
  private drag: { from: number; startX: number; moved: boolean } | null = null;

  constructor(
    private view: LaneView,
    headerWidth: number,
    onCameras: () => void,
  ) {
    this.el = h(
      'div',
      { class: 'director-row' },
      h(
        'div',
        { class: 'director-corner', style: { width: `${headerWidth}px` } },
        h('span', null, 'Director'),
        h('button', { class: 'director-cams', title: 'Cameras (View › Video)', onclick: onCameras }, 'Cameras'),
      ),
      this.canvas,
    );
    this.bind();
  }

  get visible(): boolean {
    return !!store.project?.cameras?.length;
  }

  resize(w: number): void {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(DIRECTOR_H * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${DIRECTOR_H}px`;
  }

  draw(): void {
    this.el.style.display = this.visible ? '' : 'none';
    if (!this.visible) return;
    const p = store.project;
    const ctx = this.canvas.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = this.view.width();
    ctx.fillStyle = '#1b1e25';
    ctx.fillRect(0, 0, w, DIRECTOR_H);
    const end = this.view.frameOf(w);
    const list = shots(p, Math.max(end, ...p.tracks.flatMap((t) => t.clips.map((c) => c.start + c.length))));
    // before the first switch the first switch's camera shows (drawn without a switch line)
    if (list.length && list[0].start > 0) list.unshift({ start: 0, end: list[0].start, camera: list[0].camera, index: -1 });
    if (!list.length) {
      ctx.fillStyle = '#8d94a3';
      ctx.font = '11px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText('No camera switches yet: watch through (W) and press 1–9, or use Auto-direct in the Cameras panel. The first camera is shown until then.', 8, DIRECTOR_H / 2);
      return;
    }
    const cuts = directorCuts(p);
    const minShot = MIN_SHOT_S * store.sampleRate;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (const s of list) {
      const x0 = this.view.xOf(s.start);
      const x1 = this.view.xOf(s.end);
      if (x1 < 0 || x0 > w) continue;
      const cam = p.cameras?.find((c) => c.id === s.camera);
      const color = cam?.color ?? '#888';
      const a = Math.max(-2, x0);
      const b = Math.min(w + 2, x1);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.28;
      ctx.fillRect(a, 3, b - a, DIRECTOR_H - 6);
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      ctx.fillRect(a, 3, b - a, 3);
      // the switch itself
      if (x0 >= -2 && s.index >= 0) {
        ctx.fillStyle = s.end - s.start < minShot && s.index + 1 < cuts.length && s.index > 0 ? '#ffa726' : '#e3e6ec';
        ctx.fillRect(Math.round(x0), 1, 2, DIRECTOR_H - 2);
        const d = cuts[s.index].dissolve;
        if (d) {
          const xd = this.view.xOf(s.start + d);
          ctx.strokeStyle = '#e3e6ec';
          ctx.beginPath();
          ctx.moveTo(x0, DIRECTOR_H - 3);
          ctx.lineTo(xd, 4);
          ctx.stroke();
        }
      }
      const label = cam ? `${cameraNumber(p, cam.id)} ${cam.name}` : '?';
      const lx = Math.max(a, 0) + 6;
      if (b - lx > 24) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(lx, 0, b - lx - 4, DIRECTOR_H);
        ctx.clip();
        ctx.fillStyle = '#e3e6ec';
        ctx.fillText(label, lx, DIRECTOR_H / 2 + 2);
        ctx.restore();
      }
    }
    // playhead
    const px = Math.round(this.view.xOf(store.transport.position)) + 0.5;
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, DIRECTOR_H);
    ctx.stroke();
  }

  /** The switch whose line is under x (not the very first one, which starts the programme). */
  private cutAt(x: number): number | null {
    for (const c of directorCuts(store.project)) {
      if (c.at === 0) continue;
      if (Math.abs(this.view.xOf(c.at) - x) <= EDGE_PX) return c.at;
    }
    return null;
  }

  private bind(): void {
    const local = (e: MouseEvent) => {
      const r = this.canvas.getBoundingClientRect();
      return e.clientX - r.left;
    };
    this.canvas.addEventListener('mousemove', (e) => {
      if (this.drag) return;
      const onEdge = this.cutAt(local(e)) !== null;
      this.canvas.style.cursor = onEdge ? 'ew-resize' : 'pointer';
      this.canvas.title = onEdge ? 'Drag to move this camera switch' : 'Click to go here · right-click to change the camera';
    });
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const x = local(e);
      const at = this.cutAt(x);
      if (at === null) {
        this.view.seek(this.view.frameOf(x));
        return;
      }
      e.preventDefault();
      this.drag = { from: at, startX: x, moved: false };
      const words = transcripts().words();
      const move = (ev: MouseEvent) => {
        if (!this.drag) return;
        const nx = local(ev);
        if (!this.drag.moved && Math.abs(nx - this.drag.startX) < 3) return;
        this.drag.moved = true;
        let to = this.view.frameOf(nx);
        const px = Math.abs(this.view.frameOf(8) - this.view.frameOf(0));
        to = snapToWords(to, words, px);
        const from = this.drag.from;
        store.editLive((p) => moveCut(p, from, to));
        // follow the switch where it landed (it may have been clamped)
        const cuts = directorCuts(store.project);
        const i = shotIndexAt(cuts, to);
        if (i >= 0) this.drag.from = cuts[i].at;
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        if (this.drag?.moved) store.commitLive();
        this.drag = null;
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    this.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const x = local(e);
      const t = this.view.frameOf(x);
      const p = store.project;
      const cuts = directorCuts(p);
      const i = shotIndexAt(cuts, t);
      const cut = i >= 0 ? cuts[i] : null;
      const sr = store.sampleRate;
      const entries: ContextMenuEntry[] = [
        { kind: 'header', label: 'This shot' },
        ...(p.cameras ?? []).map(
          (c, n): ContextMenuEntry => ({
            label: `${n + 1}  ${c.name}`,
            checked: (cut?.camera ?? p.cameras?.[0]?.id) === c.id,
            run: () => store.edit((q) => setShotCamera(q, t, c.id)),
          }),
        ),
        { kind: 'separator' },
        { label: 'Switch Camera Here…', title: 'A new switch at this point; pick its camera next', run: () => showSwitchMenu(t, e.pageX, e.pageY) },
        ...(cut && i > 0
          ? ([
              { label: 'Cut (No Dissolve)', checked: !cut.dissolve, run: () => store.edit((q) => setDissolve(q, cut.at, 0)) },
              { label: 'Dissolve ½ s', checked: cut.dissolve === Math.round(0.5 * sr), run: () => store.edit((q) => setDissolve(q, cut.at, Math.round(0.5 * sr))) },
              { label: 'Dissolve 1 s', checked: cut.dissolve === sr, run: () => store.edit((q) => setDissolve(q, cut.at, sr)) },
              { kind: 'separator' },
              { label: 'Remove This Switch', title: 'The shot before carries on', run: () => store.edit((q) => removeCut(q, cut.at)) },
            ] as ContextMenuEntry[])
          : []),
        { kind: 'separator' },
        { label: 'Remove All Switches', enabled: cuts.length > 0, run: () => store.edit((q) => ({ ...q, director: { cuts: [] } })) },
      ];
      showContextMenu(entries, e.pageX, e.pageY);
    });
  }
}

function showSwitchMenu(at: number, x: number, y: number): void {
  const p = store.project;
  showContextMenu(
    [
      { kind: 'header', label: 'Switch to' },
      ...(p.cameras ?? []).map((c, n): ContextMenuEntry => ({ label: `${n + 1}  ${c.name}`, run: () => store.edit((q) => setCut(q, at, c.id)) })),
    ],
    x,
    y,
  );
}
