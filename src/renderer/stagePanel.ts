// View › Stage: the 3D stage tab of the sidebar. A top-down view of the listener's head with every
// voice placed around it: drag a voice to set its angle and distance, set its height below. Placed
// tracks are mixed binaurally for headphones (core/binaural.ts), or panned for speakers. A voice
// whose angle or distance is automated moves while the episode plays; dragging it then sets a
// point at the playhead.
import { clear, h } from './dom';
import { store } from './store';
import { sidebar } from './sidebar';
import { editableNumber, editableValue } from './valueEdit';
import type { AutomationLane, StagePosition, Track } from '../shared/types';
import { addAutomationPoint, setTrackAutomation, showTrackAutomation } from '../core/automation';
import {
  DISTANCE_MAX,
  DISTANCE_MIN,
  ELEVATION_MAX,
  ELEVATION_MIN,
  clampDistance,
  formatAzimuth,
  formatDistance,
  parseAzimuth,
  placeOnStage,
  removeFromStage,
  setStageMode,
  stageAt,
  stageMode,
} from '../core/stage';

/** Size of the listener's head in the middle of the stage (px). */
const HEAD_R = 16;
const DOT_R = 9;
const LOG_RANGE = Math.log(DISTANCE_MAX / DISTANCE_MIN);
/** Rings drawn on the stage (m). */
const RINGS = [1, 3, 10];

/** Radius on the stage drawing (px) of a distance, for a stage of radius `R`: log scale outside the head. */
export function stageRadius(distance: number, R: number): number {
  const f = Math.log(clampDistance(distance) / DISTANCE_MIN) / LOG_RANGE;
  return HEAD_R + f * (R - HEAD_R);
}

/** Distance (m) of a radius on the stage drawing (the inverse of stageRadius). */
export function radiusDistance(r: number, R: number): number {
  const f = Math.max(0, Math.min(1, (r - HEAD_R) / (R - HEAD_R)));
  return DISTANCE_MIN * Math.exp(f * LOG_RANGE);
}

const roundDistance = (d: number) => (d < 10 ? Math.round(d * 10) / 10 : Math.round(d));

export class StagePanel {
  readonly el = h('div', { class: 'stage-panel', 'aria-label': 'Stage' });
  private canvas = h('canvas', { class: 'stage-canvas', 'aria-label': 'Stage: drag a voice to place it' });
  private list = h('div', { class: 'stage-tracks' });
  private modeRow = h('div', { class: 'stage-mode' });
  private visible = false;
  private selected: string | null = null;
  private drag: { trackId: string; moved: boolean } | null = null;
  /** Last transport position drawn, so playback only redraws when a moving voice moved. */
  private drawnAt = -1;

  constructor() {
    this.el.append(
      h('div', { class: 'stage-head' }, h('h3', null, 'Stage'), this.modeRow),
      this.canvas,
      h('p', { class: 'muted stage-hint' }, 'Drag a voice to place it around the listener. Up is in front. Use headphones to hear the binaural mix.'),
      this.list,
    );
    this.canvas.addEventListener('pointerdown', (e) => this.pointerDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.pointerMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.pointerUp(e));
    this.canvas.addEventListener('pointercancel', (e) => this.pointerUp(e));
    store.subscribe((kinds) => {
      if (!this.visible) return;
      if (kinds.has('project')) {
        if (!this.drag) this.renderList();
        this.drawStage();
      } else if (kinds.has('transport') && store.transport.position !== this.drawnAt && this.anyMoving()) {
        this.drawStage();
      }
    });
    window.addEventListener('resize', () => this.visible && this.drawStage());
  }

  /** Shows the stage tab, with a track picked (the 3D button in its header). */
  openFor(trackId?: string): void {
    if (trackId) this.selected = trackId;
    sidebar().show('stage');
    if (store.view !== 'edit') store.setView('edit');
    if (this.visible) this.render();
  }

  enterSidebar(): void {
    this.visible = true;
    this.render();
  }

  leaveSidebar(): void {
    this.visible = false;
  }

  private placed(): Track[] {
    return store.project.tracks.filter((t) => t.stage);
  }

  private anyMoving(): boolean {
    return this.placed().some((t) => t.automation?.angle?.length || t.automation?.distance?.length);
  }

  private render(): void {
    this.renderMode();
    this.renderList();
    // the canvas gets its size once it is in the page
    requestAnimationFrame(() => this.drawStage());
  }

  private renderMode(): void {
    const mode = stageMode(store.project);
    const btn = (m: 'binaural' | 'speakers', label: string, title: string) =>
      h('button', { class: `seg-btn${mode === m ? ' active' : ''}`, title, onclick: () => mode !== m && store.edit((p) => setStageMode(p, m)) }, label);
    clear(this.modeRow);
    this.modeRow.append(
      btn('binaural', 'Headphones', 'Binaural mix: voices come from their place on the stage when heard on headphones'),
      btn('speakers', 'Speakers', 'Loudspeaker mix: voices are panned by their angle (behind folds to the sides); distance still applies'),
    );
  }

  // ------------------------------------------------------------------ drawing

  private geometry(): { w: number; R: number; cx: number; cy: number } {
    const w = this.canvas.clientWidth || 300;
    return { w, R: w / 2 - DOT_R - 4, cx: w / 2, cy: w / 2 };
  }

  private posOf(t: Track): StagePosition {
    return stageAt(t, store.transport.position);
  }

  private xyOf(pos: StagePosition): [number, number] {
    const { R, cx, cy } = this.geometry();
    const r = stageRadius(pos.distance, R);
    const a = (pos.azimuth * Math.PI) / 180;
    return [cx + Math.sin(a) * r, cy - Math.cos(a) * r];
  }

  private drawStage(): void {
    if (!this.visible) return;
    this.drawnAt = store.transport.position;
    const { w, R, cx, cy } = this.geometry();
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(w * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(w * dpr);
    }
    this.canvas.style.height = `${w}px`;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, w);
    // floor and distance rings
    ctx.fillStyle = '#191c23';
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    for (const d of RINGS) {
      const r = stageRadius(d, R);
      ctx.strokeStyle = 'rgba(255,255,255,0.10)';
      ctx.setLineDash(d === 1 ? [] : [3, 4]);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillText(`${d} m`, cx + r * Math.SQRT1_2 + 3, cy + r * Math.SQRT1_2 - 1);
    }
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();
    // axes: front/back and left/right
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.beginPath();
    ctx.moveTo(cx, cy - R);
    ctx.lineTo(cx, cy + R);
    ctx.moveTo(cx - R, cy);
    ctx.lineTo(cx + R, cy);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('Front', cx, cy - R + 4);
    ctx.textBaseline = 'bottom';
    ctx.fillText('Behind', cx, cy + R - 4);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText('L', cx - R + 5, cy);
    ctx.textAlign = 'right';
    ctx.fillText('R', cx + R - 5, cy);
    this.drawHead(ctx, cx, cy);
    // voices: the picked one last, on top
    const tracks = this.placed().sort((a, b) => Number(a.id === this.selected) - Number(b.id === this.selected));
    for (const t of tracks) {
      const pos = this.posOf(t);
      const [x, y] = this.xyOf(pos);
      const sel = t.id === this.selected;
      // a faint line to the head shows the direction
      ctx.strokeStyle = `${t.color}55`;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(x, y);
      ctx.stroke();
      // height: a raised voice gets a lighter ring, a lowered one a darker one
      ctx.fillStyle = t.color;
      ctx.globalAlpha = t.mute ? 0.4 : 1;
      ctx.beginPath();
      ctx.arc(x, y, DOT_R + (pos.elevation / 90) * 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = sel ? 2.5 : 1.5;
      ctx.strokeStyle = sel ? '#ffffff' : '#0f1014';
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.globalAlpha = 1;
      const moving = !!(t.automation?.angle?.length || t.automation?.distance?.length);
      const label = `${t.name}${pos.elevation ? ` ${pos.elevation > 0 ? '▲' : '▼'}${Math.abs(Math.round(pos.elevation))}°` : ''}${moving ? ' ↻' : ''}`;
      ctx.font = `${sel ? '600 ' : ''}11px system-ui, sans-serif`;
      ctx.textAlign = x > cx + R * 0.5 ? 'right' : 'left';
      ctx.textBaseline = 'middle';
      const lx = x > cx + R * 0.5 ? x - DOT_R - 4 : x + DOT_R + 4;
      ctx.fillStyle = 'rgba(15,16,20,0.8)';
      const tw = ctx.measureText(label).width;
      ctx.fillRect(ctx.textAlign === 'right' ? lx - tw - 2 : lx - 2, y - 8, tw + 4, 16);
      ctx.fillStyle = '#e3e6ec';
      ctx.fillText(label, lx, y);
    }
    if (!tracks.length) {
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText('Put a track on the stage below', cx, cy + R * 0.45);
    }
  }

  /** The listener, seen from above, facing up. */
  private drawHead(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
    ctx.fillStyle = '#3a4050';
    ctx.strokeStyle = '#8d94a3';
    // ears
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(cx + s * HEAD_R, cy, 3, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    // nose
    ctx.beginPath();
    ctx.moveTo(cx - 5, cy - HEAD_R + 3);
    ctx.lineTo(cx, cy - HEAD_R - 6);
    ctx.lineTo(cx + 5, cy - HEAD_R + 3);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, HEAD_R - 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // ------------------------------------------------------------------ dragging

  private local(e: PointerEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private hit(x: number, y: number): Track | null {
    let best: Track | null = null;
    let bestD = DOT_R + 4;
    for (const t of this.placed()) {
      const [tx, ty] = this.xyOf(this.posOf(t));
      const d = Math.hypot(x - tx, y - ty);
      if (d <= bestD) {
        best = t;
        bestD = d;
      }
    }
    return best;
  }

  private pointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const [x, y] = this.local(e);
    const t = this.hit(x, y);
    if (!t) return;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    this.selected = t.id;
    this.drag = { trackId: t.id, moved: false };
    this.renderList();
    this.drawStage();
  }

  private pointerMove(e: PointerEvent): void {
    const [x, y] = this.local(e);
    if (!this.drag) {
      this.canvas.style.cursor = this.hit(x, y) ? 'grab' : '';
      return;
    }
    this.drag.moved = true;
    const { R, cx, cy } = this.geometry();
    const dx = x - cx;
    const dy = y - cy;
    let azimuth = Math.round((Math.atan2(dx, -dy) * 180) / Math.PI);
    // straight ahead and the sides are sticky (Alt: free)
    if (!e.altKey) for (const snap of [0, -90, 90, 180, -180]) if (Math.abs(azimuth - snap) <= 3) azimuth = snap;
    const distance = roundDistance(radiusDistance(Math.hypot(dx, dy), R));
    this.canvas.style.cursor = 'grabbing';
    this.move(this.drag.trackId, { azimuth, distance }, true);
  }

  private pointerUp(e: PointerEvent): void {
    if (!this.drag) return;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    const moved = this.drag.moved;
    this.drag = null;
    this.canvas.style.cursor = '';
    if (moved) store.commitLive();
    this.renderList();
  }

  /**
   * Moves a voice. A lane with points (angle or distance automation) gets a point at the playhead
   * instead, so a walk can be drawn by playing, stopping and dragging.
   */
  private move(trackId: string, patch: Partial<StagePosition>, live: boolean): void {
    const t = store.project.tracks.find((x) => x.id === trackId);
    if (!t?.stage) return;
    const frame = store.transport.position;
    const apply = (project: typeof store.project) => {
      let p = project;
      const fixed: Partial<StagePosition> = { ...patch };
      for (const [lane, key] of [['angle', 'azimuth'], ['distance', 'distance']] as Array<[AutomationLane, 'azimuth' | 'distance']>) {
        const pts = t.automation?.[lane];
        if (patch[key] === undefined || !pts?.length) continue;
        const rest = pts.filter((q) => q.pos !== frame);
        p = setTrackAutomation(p, trackId, lane, addAutomationPoint(lane, rest, frame, patch[key]!).points);
        delete fixed[key];
      }
      if (Object.keys(fixed).length) p = placeOnStage(p, [trackId], fixed);
      return p;
    };
    if (live) store.editLive(apply);
    else store.edit(apply);
  }

  // ------------------------------------------------------------------ the track list

  private renderList(): void {
    if (!this.visible) return;
    clear(this.list);
    const tracks = store.project.tracks.filter((t) => t.kind !== 'soundboard');
    if (!tracks.length) {
      this.list.append(h('p', { class: 'muted' }, 'No tracks yet.'));
      return;
    }
    for (const t of tracks) this.list.append(this.trackRow(t));
  }

  private trackRow(t: Track): HTMLElement {
    const on = !!t.stage;
    const toggle = h('input', {
      type: 'checkbox',
      checked: on,
      title: on ? 'Take this track off the stage (it is panned again)' : 'Put this track on the stage',
      onchange: () => {
        if (on) store.edit((p) => removeFromStage(p, [t.id]));
        else {
          this.selected = t.id;
          store.edit((p) => placeOnStage(p, [t.id]));
        }
      },
    });
    const head = h(
      'label',
      { class: 'stage-track-head' },
      toggle,
      h('span', { class: 'stage-swatch', style: `background:${t.color}` }),
      h('span', { class: 'stage-track-name' }, t.name),
    );
    const row = h('div', { class: `stage-track${on ? ' placed' : ''}${t.id === this.selected ? ' selected' : ''}`, onclick: () => on && this.pick(t.id) }, head);
    if (!on) return row;
    const pos = this.posOf(t);
    const autoAngle = !!t.automation?.angle?.length;
    const autoDist = !!t.automation?.distance?.length;
    // angle: click to type ("R 30", "-45", "behind")
    const angle = h('span', { class: 'stage-value', title: autoAngle ? 'Angle follows its automation: typing sets a point at the playhead' : 'Angle (click to type, e.g. L 30, R 120, behind)' }, formatAzimuth(pos.azimuth));
    editableValue(angle, {
      initial: () => String(Math.round(this.posOf(t).azimuth)),
      parse: parseAzimuth,
      commit: (azimuth) => this.move(t.id, { azimuth }, false),
    });
    const height = h('input', {
      type: 'range',
      min: String(ELEVATION_MIN),
      max: String(ELEVATION_MAX),
      step: '1',
      value: String(Math.round(pos.elevation)),
      title: 'Height: below ear level … overhead (double-click: ear level)',
      oninput: (e: Event) => store.editLive((p) => placeOnStage(p, [t.id], { elevation: Number((e.target as HTMLInputElement).value) })),
      onchange: () => store.commitLive(),
      ondblclick: () => store.edit((p) => placeOnStage(p, [t.id], { elevation: 0 })),
    });
    const heightValue = h('span', { class: 'stage-value' }, `${Math.round(pos.elevation)}°`);
    editableNumber(heightValue, {
      min: ELEVATION_MIN,
      max: ELEVATION_MAX,
      unit: '°',
      precision: 0,
      get: () => t.stage?.elevation ?? 0,
      commit: (elevation) => store.edit((p) => placeOnStage(p, [t.id], { elevation })),
    });
    const toSlider = (d: number) => Math.round((Math.log(d / DISTANCE_MIN) / LOG_RANGE) * 1000);
    const fromSlider = (v: number) => roundDistance(DISTANCE_MIN * Math.exp((v / 1000) * LOG_RANGE));
    const distance = h('input', {
      type: 'range',
      min: '0',
      max: '1000',
      step: '1',
      value: String(toSlider(pos.distance)),
      title: autoDist ? 'Distance follows its automation: moving it sets a point at the playhead' : 'Distance from the listener (double-click: 1 m)',
      oninput: (e: Event) => this.move(t.id, { distance: fromSlider(Number((e.target as HTMLInputElement).value)) }, true),
      onchange: () => store.commitLive(),
      ondblclick: () => this.move(t.id, { distance: 1 }, false),
    });
    const distValue = h('span', { class: 'stage-value' }, formatDistance(pos.distance));
    editableNumber(distValue, {
      min: DISTANCE_MIN,
      max: DISTANCE_MAX,
      unit: 'm',
      precision: 1,
      get: () => this.posOf(t).distance,
      commit: (d) => this.move(t.id, { distance: d }, false),
    });
    const showLane = (lane: AutomationLane) => store.patch((p) => showTrackAutomation(p, t.id, lane));
    row.append(
      h(
        'div',
        { class: 'stage-fields' },
        h('span', { class: 'stage-field-name' }, 'Angle'),
        h('input', {
          type: 'range',
          min: '-180',
          max: '180',
          step: '1',
          value: String(Math.round(pos.azimuth)),
          title: 'Angle: behind on the left … in front … behind on the right (double-click: in front)',
          oninput: (e: Event) => this.move(t.id, { azimuth: Number((e.target as HTMLInputElement).value) }, true),
          onchange: () => store.commitLive(),
          ondblclick: () => this.move(t.id, { azimuth: 0 }, false),
        }),
        angle,
        h('button', { class: `stage-auto${autoAngle ? ' active' : ''}`, title: 'Show the angle automation on the track, to move the voice over time', onclick: () => showLane('angle') }, autoAngle ? 'moves' : 'Auto'),
        h('span', { class: 'stage-field-name' }, 'Height'),
        height,
        heightValue,
        h('span'),
        h('span', { class: 'stage-field-name' }, 'Distance'),
        distance,
        distValue,
        h('button', { class: `stage-auto${autoDist ? ' active' : ''}`, title: 'Show the distance automation on the track, to move the voice over time', onclick: () => showLane('distance') }, autoDist ? 'moves' : 'Auto'),
      ),
    );
    if (t.fx?.some((f) => f.enabled && f.type === 'space')) {
      row.append(h('p', { class: 'muted stage-note' }, 'Its Room & distance filter follows this distance; the room stays all around.'));
    }
    return row;
  }

  private pick(trackId: string): void {
    if (this.selected === trackId) return;
    this.selected = trackId;
    this.renderList();
    this.drawStage();
  }
}
