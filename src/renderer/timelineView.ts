// Record & Edit view: track headers, canvas timeline with waveforms, markers, selection and transport following.
import { LevelMeter } from './levelMeter';
import { selectionSpan } from '../core/navigation';
import type { Clip, EnvelopePoint, PeakLevel, Track } from '../shared/types';
import { formatTick } from '../shared/time';
import { addTrack, moveClip, removeTrack, updateClip, updateMarker, updateTrack } from '../core/project';
import { projectLength } from '../core/project';
import { FADE_SHAPES, fadeCurve, type FadeShape } from '../core/dsp';
import { fadesAt, trackFades, type EffectiveFades } from '../core/crossfade';
import { jingleMediaFile } from '../core/soundboard';
import { clear, h, toast } from './dom';
import { iconButton, setTip } from './icons';
import { coughDown, coughUp, dropMarker, importAudioFiles, muteSelection, prepareForEditing, rippleCut, seek, splitAtPlayhead } from './actions';
import { addMuteRegion, removeMuteRegion, updateMuteRegion } from '../core/muteRegions';
import { ENV_MAX_DB, addPoint, ampToDb, envAmp, envelopeAmpAt, envelopeDbAt, setClipEnvelope, toSource } from '../core/envelope';
import { snap, snapTargets } from '../core/snap';
import { normalizeClips } from './loudnessDialog';
import { store } from './store';
import { drawFileWaveform, drawLevelsWaveform } from './waveform';

const TRACK_H = 84;
const RULER_H = 26;
const MARKER_H = 24;
const HEADER_W = 290;
const EDGE_PX = 6;
/** Strip at the bottom of each track where mute (cough) regions are drawn and edited. */
const MUTE_LANE_H = 12;
/** Strip at the top of a clip where the fade handles are grabbed. */
const FADE_ZONE_PX = 10;
const FADE_HANDLE_PX = 7;
/** The volume line uses the track height between this offset and the mute lane. */
const ENV_TOP = 16;
const ENV_HIT_PX = 5;
/** Edges snap to targets closer than this. */
const SNAP_PX = 8;
const RANGE_EDGE_PX = 5;
// Falls back to the key used while the app was called SoundPod.
const SNAP_KEY = 'wavepod.timeline.snap';
/** While a clip is dragged to another track, horizontal movement below this keeps its position (sync). */
const TRACK_MOVE_LOCK_PX = 20;
/** Deepest zoom: one sample this many pixels wide. */
const MAX_PX_PER_SAMPLE = 64;
/** Ruler tick steps in seconds, from a few samples up to an hour. */
const TICK_STEPS = [
  0.00001, 0.00002, 0.00005, 0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800,
  3600,
];
/** Volume-line toggle shown at the top left of a hovered clip (offsets from the clip's top left). */
const VOL_BTN = { x: 4, y: 17, w: 26, h: 13 };

type Drag =
  | { kind: 'clip'; clipId: string; ids: Set<string>; startX: number; startY: number; delta: number; dTrack: number; minDTrack: number; maxDTrack: number; moved: boolean }
  | { kind: 'trim'; clipId: string; side: 'left' | 'right'; startX: number; orig: Clip; delta: number }
  | { kind: 'fade'; clipId: string; side: 'in' | 'out'; startX: number; orig: Clip; moved: boolean }
  | { kind: 'range'; startFrame: number; endFrame: number; startTrack: number | null; endTrack: number | null }
  | { kind: 'rangeEdge'; fixed: number; current: number; tracks: string[] | null; moved: boolean }
  | { kind: 'envPoint'; clipId: string; ti: number; index: number; orig: EnvelopePoint[]; moved: boolean }
  | { kind: 'envLine'; clipId: string; ti: number; indices: number[]; orig: EnvelopePoint[]; startY: number; moved: boolean }
  | { kind: 'marker'; markerId: string; startX: number; origPos: number; dx: number; moved: boolean }
  | { kind: 'mute'; trackId: string; index: number | null; edge: 'left' | 'right' | 'new'; anchor: number; current: number; moved: boolean };

export class TimelineView {
  readonly el = h('div', { class: 'view edit-view' });
  private toolbar = h('div', { class: 'toolbar' });
  private rulerCanvas = h('canvas', { class: 'ruler-canvas' });
  private scroll = h('div', { class: 'tracks-scroll' });
  private headers = h('div', { class: 'track-headers' });
  private canvas = h('canvas', { class: 'tracks-canvas' });
  private hscroll = h('input', { type: 'range', class: 'hscroll', min: '0', max: '1000', value: '0' });
  private trackMeters = new Map<string, LevelMeter>();

  /** Seconds at the left edge. */
  viewStart = 0;
  pxPerSec = 40;
  private width = 800;
  private drag: Drag | null = null;
  /** Middle-mouse pan in progress (Reaper style): where it started and the view at that moment. */
  private pan: { startX: number; startY: number; viewStart: number; scrollTop: number } | null = null;
  private lastFollowPos = 0;
  /** Snap dragged edges to clip edges, markers and the playhead. */
  private snapping = readSnapSetting();
  /** Position the current drag snapped to, drawn as a guide line. */
  private snapLine: number | null = null;
  /** Clip under the mouse, whose fade handles are shown. */
  private hoverClipId: string | null = null;
  private snapBtn = iconButton('snap', { label: 'Snapping' }, null, 'snap-btn');
  /** Opens the filter stack of a track. */
  onOpenFx: (trackId: string) => void = () => {};
  /** Opens the loudness analysis. */
  onOpenLoudness: () => void = () => {};

  constructor(private footer: HTMLElement) {
    const rulerRow = h(
      'div',
      { class: 'ruler-row' },
      h('div', { class: 'ruler-corner', style: { width: `${HEADER_W}px` } }, h('span', { class: 'muted' }, 'Chapters ▸')),
      this.rulerCanvas,
    );
    const body = h('div', { class: 'tracks-body' }, this.headers, this.canvas);
    this.scroll.append(body);
    this.el.append(this.toolbar, rulerRow, this.scroll, h('div', { class: 'hscroll-row' }, h('div', { style: { width: `${HEADER_W}px` } }), this.hscroll), this.footer);
    this.buildToolbar();
    this.bindEvents();
    new ResizeObserver(() => this.resize()).observe(this.scroll);
  }

  // ------------------------------------------------------------ coordinates

  private get sr(): number {
    return store.sampleRate;
  }

  private xOf(frame: number): number {
    return (frame / this.sr - this.viewStart) * this.pxPerSec;
  }

  private frameOf(x: number): number {
    return Math.max(0, Math.round((x / this.pxPerSec + this.viewStart) * this.sr));
  }

  /** Clamps an x coordinate to just outside the canvas: at deep zoom, clips span millions of pixels. */
  private cx(x: number): number {
    return Math.max(-16, Math.min(this.width + 16, x));
  }

  private totalSeconds(): number {
    const end = Math.max(projectLength(store.project), store.transport.position);
    return Math.max(60, end / this.sr + 30);
  }

  zoom(factor: number, anchorX = this.width / 2): void {
    const anchorSec = anchorX / this.pxPerSec + this.viewStart;
    this.pxPerSec = Math.min(this.sr * MAX_PX_PER_SAMPLE, Math.max(0.5, this.pxPerSec * factor));
    this.viewStart = Math.max(0, anchorSec - anchorX / this.pxPerSec);
    this.draw();
  }

  /** View before the last "zoom to selection", for toggling back. */
  private zoomBack: { pxPerSec: number; viewStart: number } | null = null;

  /** Shift+Z: zooms to the selected range or clips; pressed again (or with nothing selected), zooms back. */
  toggleZoomToSelection(span: [number, number] | null): boolean {
    if (this.zoomBack && !span) {
      ({ pxPerSec: this.pxPerSec, viewStart: this.viewStart } = this.zoomBack);
      this.zoomBack = null;
      this.draw();
      return true;
    }
    if (!span) return false;
    const before = { pxPerSec: this.pxPerSec, viewStart: this.viewStart };
    const secs = Math.max(0.01, (span[1] - span[0]) / this.sr);
    // a little room on both sides
    this.pxPerSec = Math.min(this.sr * MAX_PX_PER_SAMPLE, Math.max(0.5, (this.width * 0.9) / secs));
    this.viewStart = Math.max(0, span[0] / this.sr - (this.width * 0.05) / this.pxPerSec);
    if (this.zoomBack && Math.abs(before.pxPerSec - this.pxPerSec) < 1e-6 && Math.abs(before.viewStart - this.viewStart) < 1e-6) {
      // already zoomed to this selection: go back
      ({ pxPerSec: this.pxPerSec, viewStart: this.viewStart } = this.zoomBack);
      this.zoomBack = null;
    } else {
      this.zoomBack = this.zoomBack ?? before;
    }
    this.draw();
    return true;
  }

  /** Scrolls only if `pos` is off screen. */
  ensureVisible(pos: number): void {
    const x = this.xOf(pos);
    if (x < 0 || x > this.width * 0.95) this.reveal(pos);
  }

  zoomToFit(): void {
    this.zoomBack = null;
    const len = projectLength(store.project) / this.sr;
    this.pxPerSec = Math.max(0.5, (this.width - 20) / Math.max(10, len));
    this.viewStart = 0;
    this.draw();
  }

  // ------------------------------------------------------------ DOM

  private buildToolbar(): void {
    const btn = iconButton;
    this.toolbar.append(
      btn('addTrack', { label: 'Add track', detail: 'Add an empty track' }, () => store.edit((p) => addTrack(p))),
      btn('import', { label: 'Import audio…', shortcut: 'Ctrl+I', detail: 'Import audio files as new tracks at the playhead' }, () => void importAudioFiles()),
      btn(
        'prepareEdit',
        { label: 'Prepare for editing', detail: 'Unarm all tracks after recording, so pressing R while editing cannot start a new take' },
        prepareForEditing,
      ),
      h('span', { class: 'sep' }),
      btn('split', { label: 'Split', shortcut: 'S', detail: 'Split clips at the playhead' }, splitAtPlayhead),
      btn('rippleCut', { label: 'Ripple cut', shortcut: 'Ctrl+X or Shift+Delete', detail: 'Remove the selected time range from all tracks and close the gap' }, rippleCut),
      btn('muteRange', { label: 'Mute range', shortcut: 'Ctrl+Y', detail: 'Silence the selected range on the selected tracks using their volume lines' }, muteSelection),
      btn('fade', { label: 'Fade', shortcut: 'F', detail: 'Add short fades to selected clips, or drag the top corners of a clip' }, () => this.fadeSelected()),
      btn(
        'normalise',
        { label: 'Normalise', shortcut: 'Alt+Shift+N', detail: 'Set the clip gain of the selected clips so each reaches the loudness target, −16 LUFS by default' },
        () => void normalizeClips([...store.selection.clipIds]),
      ),
      btn(
        'loudness',
        { label: 'Loudness…', shortcut: 'Shift+Ctrl+L', detail: 'Loudness analysis of the selected clips, or of the mix and every track when no clip is selected' },
        () => this.onOpenLoudness(),
      ),
      this.snapBtn,
      h('span', { class: 'sep' }),
      btn('chapter', { label: 'Chapter marker', shortcut: 'M', detail: 'Add a chapter marker at the playhead' }, () => dropMarker('chapter'), 'chapter'),
      btn('editMark', { label: 'Edit marker', shortcut: 'E', detail: 'Add an edit marker at the playhead' }, () => dropMarker('edit'), 'editmark'),
      h('span', { class: 'sep' }),
      btn('zoomOut', { label: 'Zoom out', shortcut: '-' }, () => this.zoomAtPlayhead(1 / 1.5)),
      btn('zoomIn', { label: 'Zoom in', shortcut: '+' }, () => this.zoomAtPlayhead(1.5)),
      btn('fit', { label: 'Zoom to fit', detail: 'Zoom to fit the whole episode' }, () => this.zoomToFit()),
      btn('zoomSel', { label: 'Zoom to selection', shortcut: 'Shift+Z', detail: 'Zoom to the selected range or clips; again to zoom back' }, () =>
        void this.toggleZoomToSelection(selectionSpan(store.project, store.selection.range, store.selection.clipIds))),
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted hint-keys' }, 'Space play · R record · M chapter · S split · Ctrl+X ripple cut · Ctrl+Y mute range'),
    );
    this.snapBtn.addEventListener('click', () => {
      this.snapping = !this.snapping;
      try {
        localStorage.setItem(SNAP_KEY, this.snapping ? '1' : '0');
      } catch {
        // storage unavailable; the setting just isn't remembered
      }
      this.updateSnapButton();
    });
    this.updateSnapButton();
  }

  private updateSnapButton(): void {
    this.snapBtn.classList.toggle('on', this.snapping);
    this.snapBtn.setAttribute('aria-pressed', String(this.snapping));
    setTip(this.snapBtn, {
      label: this.snapping ? 'Snapping on' : 'Snapping off',
      detail: this.snapping
        ? 'Dragged edges lock to clip edges on other tracks, markers and the playhead. Hold Alt to drag freely.'
        : 'Click to lock dragged edges to clips, markers and the playhead',
    });
  }

  fadeSelected(): void {
    const ids = store.selection.clipIds;
    if (!ids.size) return toast('Select one or more clips first');
    const f = Math.round(this.sr * 0.25);
    store.edit((p) => {
      let q = p;
      for (const id of ids) {
        const clip = q.tracks.flatMap((t) => t.clips).find((c) => c.id === id);
        if (clip) q = updateClip(q, id, { fadeIn: Math.min(f, clip.length / 2), fadeOut: Math.min(f, clip.length / 2) });
      }
      return q;
    });
  }

  renderHeaders(): void {
    clear(this.headers);
    this.trackMeters.clear();
    const status = store.status;
    const nIn = status?.inputChannelCount ?? 0;
    const labels = store.profile?.inputs ?? [];
    const labelOf = (i: number) => labels.find((l) => l.index === i)?.label ?? `In ${i + 1}`;
    const inputOptions: Array<{ value: string; label: string }> = [{ value: '', label: 'No input' }];
    for (let i = 0; i < nIn; i++) inputOptions.push({ value: String(i), label: `${i + 1}: ${labelOf(i)}` });
    for (let i = 0; i + 1 < nIn; i += 2) inputOptions.push({ value: `${i},${i + 1}`, label: `${i + 1}/${i + 2}: ${labelOf(i).replace(/ L$/, '')} (stereo)` });

    store.project.tracks.forEach((t: Track) => {
      const cur = t.inputChannels.join(',');
      if (cur && !inputOptions.some((o) => o.value === cur)) inputOptions.push({ value: cur, label: `${cur} (unavailable)` });
      const meter = new LevelMeter(`trk:${t.id}`);
      this.trackMeters.set(t.id, meter);
      const toggle = (key: 'armed' | 'mute' | 'solo', label: string, title: string) =>
        h(
          'button',
          {
            class: `toggle ${key}${t[key] ? ' on' : ''}`,
            title,
            onclick: () => {
              if (key === 'armed' && store.transport.state === 'recording') return toast('Stop recording before changing armed tracks');
              store.patch((p) => updateTrack(p, t.id, { [key]: !t[key] }));
            },
          },
          label,
        );
      this.headers.append(
        h(
          'div',
          { class: 'track-header', style: { height: `${TRACK_H}px`, borderLeftColor: t.color } },
          h(
            'div',
            { class: 'th-row' },
            h('input', {
              class: 'track-name',
              value: t.name,
              onchange: (e: Event) => store.edit((p) => updateTrack(p, t.id, { name: (e.target as HTMLInputElement).value })),
            }),
            t.kind === 'soundboard' ? h('span', { class: 'toggle placeholder' }) : toggle('armed', '●', 'Arm for recording'),
            t.kind === 'soundboard'
              ? h('span', { class: 'toggle placeholder' })
              : h(
                  'button',
                  {
                    class: 'toggle cough',
                    title: `Cough button: hold to mute this speaker while recording or playing${coughKey(t.id)}`,
                    onmousedown: (e: MouseEvent) => {
                      e.preventDefault();
                      coughDown(t.id);
                      const up = () => {
                        window.removeEventListener('mouseup', up);
                        coughUp(t.id);
                      };
                      window.addEventListener('mouseup', up);
                    },
                  },
                  'C',
                ),
            toggle('mute', 'M', 'Mute'),
            toggle('solo', 'S', 'Solo'),
            h(
              'button',
              {
                class: 'toggle remove',
                title: 'Remove track',
                onclick: () => {
                  if (t.clips.length && !confirm(`Remove track "${t.name}" and its ${t.clips.length} clip(s)? (Undo with Ctrl+Z)`)) return;
                  store.edit((p) => removeTrack(p, t.id));
                },
              },
              '×',
            ),
          ),
          t.kind === 'soundboard'
            ? h('div', { class: 'th-row muted th-hint' }, 'Jingles played while recording')
            : h(
            'div',
            { class: 'th-row' },
            h(
              'select',
              {
                class: 'input-select',
                title: 'Input channel(s) this track records from',
                onchange: (e: Event) => {
                  const v = (e.target as HTMLSelectElement).value;
                  store.patch((p) => updateTrack(p, t.id, { inputChannels: v ? v.split(',').map(Number) : [] }));
                },
              },
              ...inputOptions.map((o) => h('option', { value: o.value, selected: o.value === cur }, o.label)),
            ),
          ),
          h(
            'div',
            { class: 'th-row' },
            h(
              'button',
              {
                class: `fx-btn${t.fx?.some((f) => f.enabled) ? ' active' : ''}`,
                title: 'Filters (EQ, compressor, Dynamics, …)',
                onclick: () => this.onOpenFx(t.id),
              },
              t.fx?.some((f) => f.enabled) ? `FX ${t.fx.filter((f) => f.enabled).length}` : 'FX',
            ),
            h('span', { class: 'gain-label', title: 'Track gain' }, `${t.gain > 0 ? '+' : ''}${t.gain.toFixed(1)} dB`),
            h('input', {
              type: 'range',
              class: 'gain',
              min: '-24',
              max: '12',
              step: '0.5',
              value: String(t.gain),
              title: 'Track gain (double-click to reset)',
              ondblclick: () => store.edit((p) => updateTrack(p, t.id, { gain: 0 })),
              onchange: (e: Event) => store.edit((p) => updateTrack(p, t.id, { gain: Number((e.target as HTMLInputElement).value) })),
            }),
            meter.el,
          ),
        ),
      );
    });
    if (!store.project.tracks.length) {
      this.headers.append(
        h(
          'div',
          { class: 'empty-tracks' },
          h('p', null, 'No tracks yet.'),
          h('p', { class: 'muted' }, 'Go to Setup to create one track per microphone from your interface, or import audio.'),
          h('button', { class: 'primary', onclick: () => store.setView('setup') }, 'Open Setup'),
        ),
      );
    }
    this.resize();
  }

  updateMeters(): void {
    const peaks = store.meterHold;
    for (const t of store.project.tracks) {
      const meter = this.trackMeters.get(t.id);
      if (!meter) continue;
      // armed: live input of its channels; unarmed: only what the track itself plays back
      const raw = store.transport;
      const v = t.armed ? Math.max(0, ...t.inputChannels.map((c) => peaks[c] ?? 0)) : (store.trackMeterHold.get(t.id) ?? 0);
      const p = t.armed ? Math.max(0, ...t.inputChannels.map((c) => raw.inputPeaks[c] ?? 0)) : (raw.trackPeaks?.[t.id] ?? 0);
      meter.update(v, p);
    }
  }

  private resize(): void {
    const w = Math.max(100, this.scroll.clientWidth - HEADER_W);
    this.width = w;
    const dpr = window.devicePixelRatio || 1;
    const hTracks = Math.max(store.project?.tracks.length ?? 0, 1) * TRACK_H;
    for (const [c, height] of [
      [this.rulerCanvas, RULER_H + MARKER_H],
      [this.canvas, hTracks],
    ] as const) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(height * dpr);
      c.style.width = `${w}px`;
      c.style.height = `${height}px`;
    }
    this.draw();
  }

  // ------------------------------------------------------------ drawing

  /** Keeps the playhead in view while the transport runs. */
  follow(): void {
    const t = store.transport;
    const moved = t.position !== this.lastFollowPos;
    this.lastFollowPos = t.position;
    if (this.drag || this.pan || (t.state === 'stopped' && !moved)) return;
    const x = this.xOf(t.position);
    if (x > this.width * 0.92 || x < 0) {
      this.viewStart = Math.max(0, t.position / this.sr - (this.width * 0.1) / this.pxPerSec);
    }
  }

  /** Scrolls so `pos` is in view (a tenth from the left edge), whatever the transport does. */
  reveal(pos: number): void {
    this.viewStart = Math.max(0, pos / this.sr - (this.width * 0.1) / this.pxPerSec);
    this.draw();
  }

  /** Zooms around the playhead when it is visible, otherwise around the centre. */
  zoomAtPlayhead(factor: number): void {
    const x = this.xOf(store.transport.position);
    this.zoom(factor, x >= 0 && x <= this.width ? x : this.width / 2);
  }

  draw(): void {
    if (!store.project) return;
    this.drawRuler();
    this.drawTracks();
    const total = this.totalSeconds();
    const visible = this.width / this.pxPerSec;
    const maxStart = Math.max(0, total - visible);
    this.hscroll.max = String(Math.round(maxStart * 1000));
    this.hscroll.value = String(Math.round(Math.min(this.viewStart, maxStart) * 1000));
  }

  private ctx(c: HTMLCanvasElement): CanvasRenderingContext2D {
    const ctx = c.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  private tickStep(): number {
    const minPx = 80;
    for (const s of TICK_STEPS) if (s * this.pxPerSec >= minPx) return s;
    return 7200;
  }

  /** Tick positions (seconds) across the visible range, computed by index so tiny steps don't drift. */
  private ticks(step: number): number[] {
    const out: number[] = [];
    const end = this.viewStart + this.width / this.pxPerSec;
    for (let i = Math.floor(this.viewStart / step); i * step < end; i++) out.push(i * step);
    return out;
  }

  private drawRuler(): void {
    const ctx = this.ctx(this.rulerCanvas);
    const w = this.width;
    ctx.fillStyle = '#1d2027';
    ctx.fillRect(0, 0, w, RULER_H + MARKER_H);
    ctx.fillStyle = '#23262e';
    ctx.fillRect(0, RULER_H, w, MARKER_H);
    const step = this.tickStep();
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    for (const s of this.ticks(step)) {
      const x = Math.round((s - this.viewStart) * this.pxPerSec) + 0.5;
      ctx.strokeStyle = '#4a4f5c';
      ctx.beginPath();
      ctx.moveTo(x, RULER_H - 10);
      ctx.lineTo(x, RULER_H);
      ctx.stroke();
      ctx.fillStyle = '#9aa1b0';
      ctx.fillText(formatTick(s, step).replace(/^00:/, ''), x + 3, 4);
      for (let k = 1; k < 4; k++) {
        const xx = Math.round(x + (k * step * this.pxPerSec) / 4) + 0.5;
        ctx.beginPath();
        ctx.moveTo(xx, RULER_H - 4);
        ctx.lineTo(xx, RULER_H);
        ctx.stroke();
      }
    }
    // selection range
    const r = this.liveRange();
    if (r) {
      ctx.fillStyle = 'rgba(120,160,255,0.35)';
      ctx.fillRect(this.cx(this.xOf(r[0])), 0, this.cx(this.xOf(r[1])) - this.cx(this.xOf(r[0])), RULER_H);
      // edge handles, draggable
      ctx.fillStyle = '#9ab8ff';
      for (const f of r) ctx.fillRect(Math.round(this.cx(this.xOf(f))) - 1, 0, 2, RULER_H);
    }
    // markers
    ctx.textBaseline = 'middle';
    for (const m of store.project.markers) {
      const pos = this.drag?.kind === 'marker' && this.drag.markerId === m.id ? this.drag.origPos + Math.round((this.drag.dx / this.pxPerSec) * this.sr) : m.position;
      const x = Math.round(this.xOf(pos)) + 0.5;
      if (x < -200 || x > w + 2) continue;
      const color = m.kind === 'chapter' ? '#ffca28' : '#ef5350';
      const selected = store.selection.markerId === m.id;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x, RULER_H + 2);
      ctx.lineTo(x + 8, RULER_H + 2);
      ctx.lineTo(x + 8, RULER_H + MARKER_H - 4);
      ctx.lineTo(x, RULER_H + MARKER_H - 2);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = selected ? '#fff' : '#d8dbe2';
      ctx.font = `${selected ? 'bold ' : ''}11px system-ui, sans-serif`;
      ctx.fillText(m.title, x + 11, RULER_H + MARKER_H / 2);
    }
    this.drawPlayhead(ctx, RULER_H + MARKER_H);
    this.drawSnapLine(ctx, RULER_H + MARKER_H);
  }

  private drawSnapLine(ctx: CanvasRenderingContext2D, height: number): void {
    if (this.snapLine === null || !this.drag) return;
    const x = Math.round(this.xOf(this.snapLine)) + 0.5;
    ctx.strokeStyle = '#ffd54f';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** The time selection as currently shown (including one being dragged). */
  private liveRange(): [number, number] | null {
    const d = this.drag;
    if (d?.kind === 'range' || d?.kind === 'rangeEdge') {
      const [p, q] = d.kind === 'range' ? [d.startFrame, d.endFrame] : [d.fixed, d.current];
      const a = Math.min(p, q);
      const b = Math.max(p, q);
      return b > a ? [a, b] : null;
    }
    return store.selection.range;
  }

  /** Track ids the shown selection covers (null = all). */
  private liveRangeTracks(): string[] | null {
    const d = this.drag;
    if (d?.kind === 'range') return this.tracksBetween(d.startTrack, d.endTrack);
    if (d?.kind === 'rangeEdge') return d.tracks;
    return store.selection.rangeTracks ?? null;
  }

  private tracksBetween(a: number | null, b: number | null): string[] | null {
    if (a === null || b === null) return null;
    const tracks = store.project.tracks;
    const lo = Math.max(0, Math.min(a, b));
    const hi = Math.min(tracks.length - 1, Math.max(a, b));
    return tracks.slice(lo, hi + 1).map((t) => t.id);
  }

  private drawPlayhead(ctx: CanvasRenderingContext2D, height: number): void {
    const x = Math.round(this.xOf(store.transport.position)) + 0.5;
    if (x < 0 || x > this.width) return;
    ctx.strokeStyle = store.transport.state === 'recording' ? '#ff5252' : '#ffffff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  private drawTracks(): void {
    const ctx = this.ctx(this.canvas);
    const w = this.width;
    const tracks = store.project.tracks;
    const height = Math.max(tracks.length, 1) * TRACK_H;
    ctx.fillStyle = '#16181d';
    ctx.fillRect(0, 0, w, height);
    // grid
    const step = this.tickStep();
    ctx.strokeStyle = '#20232a';
    for (const s of this.ticks(step)) {
      const x = Math.round((s - this.viewStart) * this.pxPerSec) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    const recording = store.transport.state === 'recording';
    tracks.forEach((t, i) => {
      const y = i * TRACK_H;
      ctx.fillStyle = i % 2 ? '#191b21' : '#1b1d23';
      ctx.fillRect(0, y, w, TRACK_H - 1);
      for (const clip of t.clips) if (!this.isDragged(clip.id)) this.drawClip(ctx, t, i, clip);
      if (recording && t.kind === 'soundboard') this.drawLiveJingles(ctx, y);
      this.drawMuteRegions(ctx, t, y);
      if (recording && t.armed && t.inputChannels.length) {
        const x0 = this.xOf(store.recordStart);
        const x1 = this.xOf(store.transport.position);
        ctx.fillStyle = 'rgba(229,57,53,0.25)';
        ctx.fillRect(this.cx(x0), y + 4, Math.max(1, this.cx(x1) - this.cx(x0)), TRACK_H - 9);
        const live = store.livePeaks.get(t.id);
        if (live) this.drawLiveWaveform(ctx, live.levelsSnapshot(false), x0, Math.min(x1, w), y + 4, TRACK_H - 9);
        ctx.fillStyle = '#ffcdd2';
        ctx.font = '11px system-ui, sans-serif';
        ctx.textBaseline = 'top';
        ctx.fillText('● recording', Math.max(4, x0 + 4), y + 8);
      }
      ctx.fillStyle = '#0f1014';
      ctx.fillRect(0, y + TRACK_H - 1, w, 1);
    });
    // clips being dragged float above all tracks (drawn last so lower tracks can't hide them)
    tracks.forEach((t, i) => {
      for (const clip of t.clips) {
        if (!this.isDragged(clip.id)) continue;
        const dest = tracks[this.clipGeometry(i, clip).trackIndex] ?? t;
        this.drawClip(ctx, dest, i, clip);
      }
    });
    const range = this.liveRange();
    if (range) {
      const ids = this.liveRangeTracks();
      const x0 = this.cx(this.xOf(range[0]));
      const x1 = this.cx(this.xOf(range[1]));
      tracks.forEach((t, i) => {
        if (ids && !ids.includes(t.id)) return;
        ctx.fillStyle = 'rgba(120,160,255,0.22)';
        ctx.fillRect(x0, i * TRACK_H, x1 - x0, TRACK_H - 1);
        ctx.fillStyle = 'rgba(154,184,255,0.8)';
        ctx.fillRect(Math.round(x0), i * TRACK_H, 1, TRACK_H - 1);
        ctx.fillRect(Math.round(x1) - 1, i * TRACK_H, 1, TRACK_H - 1);
      });
    }
    // marker lines
    for (const m of store.project.markers) {
      const x = Math.round(this.xOf(m.position)) + 0.5;
      if (x < 0 || x > w) continue;
      ctx.strokeStyle = m.kind === 'chapter' ? 'rgba(255,202,40,0.45)' : 'rgba(239,83,80,0.45)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    this.drawPlayhead(ctx, height);
    this.drawSnapLine(ctx, height);
  }

  private isDragged(clipId: string): boolean {
    return this.drag?.kind === 'clip' && this.drag.moved && this.drag.ids.has(clipId);
  }

  // ------------------------------------------------------------ volume line

  private envTop(ti: number): number {
    return ti * TRACK_H + ENV_TOP;
  }

  private envBottom(ti: number): number {
    return ti * TRACK_H + TRACK_H - 1 - MUTE_LANE_H - 2;
  }

  /** Fader-like scale: cube root of the linear gain, +6 dB at the top, silence at the bottom. */
  private yOfDb(db: number, ti: number): number {
    const frac = Math.cbrt(envAmp(db)) / Math.cbrt(envAmp(ENV_MAX_DB));
    return this.envBottom(ti) - frac * (this.envBottom(ti) - this.envTop(ti));
  }

  private dbOfY(y: number, ti: number): number {
    const frac = Math.max(0, Math.min(1, (this.envBottom(ti) - y) / (this.envBottom(ti) - this.envTop(ti))));
    return Math.round(ampToDb(Math.pow(frac * Math.cbrt(envAmp(ENV_MAX_DB)), 3)) * 10) / 10;
  }

  /** Timeline x of a source-frame position of a clip drawn at `g`. */
  private envX(g: { x: number; offset: number }, pos: number): number {
    return g.x + ((pos - g.offset) / this.sr) * this.pxPerSec;
  }

  /** The clip's volume line, drawn inside the clip at its (possibly dragged) geometry. */
  private drawClipEnvelope(ctx: CanvasRenderingContext2D, clip: Clip, g: { x: number; w: number; offset: number; trackIndex: number }): void {
    const ti = g.trackIndex;
    const points = clip.envelope ?? [];
    const framesPerPx = this.sr / this.pxPerSec;
    const x0 = Math.max(0, Math.floor(g.x));
    const x1 = Math.min(this.width, Math.ceil(g.x + g.w));
    if (x1 <= x0) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.cx(g.x), ti * TRACK_H, this.cx(g.x + g.w) - this.cx(g.x), TRACK_H);
    ctx.clip();
    ctx.strokeStyle = '#69f0ae';
    ctx.lineWidth = 1.5;
    // one sample per pixel (interpolated in dB, so the line curves on the fader scale), plus the
    // exact corners at the points so steps and steep ramps stay sharp
    ctx.beginPath();
    let k = 0;
    for (let x = x0; x <= x1; x++) {
      for (; k < points.length && this.envX(g, points[k].pos) <= x; k++) {
        const px = this.envX(g, points[k].pos);
        if (px >= x0) ctx.lineTo(px, this.yOfDb(points[k].db, ti));
      }
      const y = this.yOfDb(envelopeDbAt(points, g.offset + (x - g.x) * framesPerPx), ti);
      if (x === x0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.lineWidth = 1;
    const d = this.drag;
    const active = (d?.kind === 'envPoint' || d?.kind === 'envLine') && d.clipId === clip.id && d.moved ? d : null;
    for (let i = 0; i < points.length; i++) {
      const x = this.envX(g, points[i].pos);
      if (x < x0 - 5 || x > x1 + 5) continue;
      const y = this.yOfDb(points[i].db, ti);
      ctx.fillStyle = '#69f0ae';
      ctx.strokeStyle = '#0f1014';
      ctx.fillRect(x - 3, y - 3, 6, 6);
      ctx.strokeRect(x - 3.5, y - 3.5, 7, 7);
      const label = active && (active.kind === 'envPoint' ? active.index === i : active.indices[0] === i);
      if (label) {
        ctx.fillStyle = '#e0f2f1';
        ctx.font = '10px system-ui, sans-serif';
        ctx.textBaseline = 'bottom';
        ctx.fillText(formatDb(points[i].db), x + 6, y - 2);
      }
    }
    ctx.restore();
  }

  /** Point or line of a visible clip volume line under the mouse. */
  private hitEnvelope(x: number, y: number): { clip: Clip; ti: number; point: number | null; src: number } | null {
    const area = this.inEnvelopeArea(x, y, ENV_HIT_PX);
    if (!area) return null;
    const { clip, ti } = area;
    const g = { x: this.xOf(clip.start), offset: clip.offset };
    const points = clip.envelope ?? [];
    let best: number | null = null;
    let bestD = Infinity;
    for (let i = 0; i < points.length; i++) {
      const dx = Math.abs(x - this.envX(g, points[i].pos));
      const dy = Math.abs(y - this.yOfDb(points[i].db, ti));
      if (dx <= ENV_HIT_PX && dy <= ENV_HIT_PX && dx + dy < bestD) {
        best = i;
        bestD = dx + dy;
      }
    }
    const src = toSource(clip, this.frameOf(x));
    if (best !== null) return { clip, ti, point: best, src };
    if (Math.abs(y - this.yOfDb(envelopeDbAt(points, src), ti)) <= ENV_HIT_PX - 1) return { clip, ti, point: null, src };
    return null;
  }

  /** The clip whose visible volume line area contains (x, y). */
  private inEnvelopeArea(x: number, y: number, slack = 0): { clip: Clip; ti: number } | null {
    const ti = Math.floor(y / TRACK_H);
    const track = store.project.tracks[ti];
    if (!track) return null;
    if (y < Math.max(ti * TRACK_H + FADE_ZONE_PX + 4, this.envTop(ti) - slack) || y > this.envBottom(ti) + slack) return null;
    for (let k = track.clips.length - 1; k >= 0; k--) {
      const clip = track.clips[k];
      if (!clip.showEnvelope) continue;
      if (x >= this.xOf(clip.start) && x <= this.xOf(clip.start + clip.length)) return { clip, ti };
    }
    return null;
  }

  /** The volume-line toggle at the top left of a clip. */
  private hitVolButton(x: number, y: number): Clip | null {
    const ti = Math.floor(y / TRACK_H);
    const track = store.project.tracks[ti];
    if (!track) return null;
    const top = ti * TRACK_H + 4;
    for (let k = track.clips.length - 1; k >= 0; k--) {
      const clip = track.clips[k];
      const x0 = this.xOf(clip.start);
      const w = (clip.length / this.sr) * this.pxPerSec;
      if (w < VOL_BTN.x + VOL_BTN.w + 8) continue;
      if (x >= x0 + VOL_BTN.x && x <= x0 + VOL_BTN.x + VOL_BTN.w && y >= top + VOL_BTN.y && y <= top + VOL_BTN.y + VOL_BTN.h) return clip;
    }
    return null;
  }

  /** Regions as drawn, including one being dragged and a cough button being held. */
  private displayedRegions(t: Track): Array<{ a: number; b: number; index: number | null; live: boolean }> {
    const d = this.drag?.kind === 'mute' && this.drag.trackId === t.id ? this.drag : null;
    const out = (t.muteRegions ?? []).map(([a, b], index): { a: number; b: number; index: number | null; live: boolean } => {
      if (d && d.index === index && d.edge !== 'new') {
        return d.edge === 'left' ? { a: Math.min(d.current, b - 1), b, index, live: false } : { a, b: Math.max(d.current, a + 1), index, live: false };
      }
      return { a, b, index, live: false };
    });
    if (d && d.edge === 'new') out.push({ a: Math.min(d.anchor, d.current), b: Math.max(d.anchor, d.current), index: null, live: false });
    const held = store.coughs.get(t.id);
    if (held !== undefined) out.push({ a: held, b: Math.max(held + 1, store.transport.position), index: null, live: true });
    return out;
  }

  private drawMuteRegions(ctx: CanvasRenderingContext2D, t: Track, y: number): void {
    const sel = store.selection.muteRegion;
    const lane = y + TRACK_H - 1 - MUTE_LANE_H;
    for (const r of this.displayedRegions(t)) {
      const x0 = this.cx(this.xOf(r.a));
      const x1 = this.cx(this.xOf(r.b));
      if (x1 < 0 || x0 > this.width) continue;
      const w = Math.max(2, x1 - x0);
      ctx.fillStyle = 'rgba(10,11,14,0.6)';
      ctx.fillRect(x0, y + 4, w, lane - y - 4);
      const selected = sel && r.index !== null && sel.trackId === t.id && sel.index === r.index;
      ctx.fillStyle = r.live ? '#ff7043' : selected ? '#9ab8ff' : '#e57373';
      ctx.fillRect(x0, lane + 2, w, MUTE_LANE_H - 4);
      if (w > 50) {
        ctx.fillStyle = '#1b1d23';
        ctx.font = '9px system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillText('muted', x0 + 4, lane + MUTE_LANE_H / 2, w - 8);
      }
    }
  }

  private hitMuteLane(x: number, y: number): { track: Track; index: number | null; edge: 'left' | 'right' | null } | null {
    const ti = Math.floor(y / TRACK_H);
    const track = store.project.tracks[ti];
    if (!track || track.kind === 'soundboard') return null;
    const lane = ti * TRACK_H + TRACK_H - 1 - MUTE_LANE_H;
    if (y < lane) return null;
    const regions = track.muteRegions ?? [];
    for (let i = 0; i < regions.length; i++) {
      const x0 = this.xOf(regions[i][0]);
      const x1 = this.xOf(regions[i][1]);
      if (Math.abs(x - x0) <= 4) return { track, index: i, edge: 'left' };
      if (Math.abs(x - x1) <= 4) return { track, index: i, edge: 'right' };
      if (x > x0 && x < x1) return { track, index: i, edge: null };
    }
    return { track, index: null, edge: null };
  }

  /** Jingles triggered during the current recording, until they become clips when it stops. */
  private drawLiveJingles(ctx: CanvasRenderingContext2D, y: number): void {
    const t = store.transport;
    const live = [
      ...(t.recordedJingles ?? []),
      ...(t.jingles ?? []).flatMap((j) => (j.recordStart === undefined ? [] : [{ slotId: j.slotId, start: j.recordStart, length: j.played }])),
    ];
    for (const j of live) {
      const slot = store.project.soundboard.find((s) => s.id === j.slotId);
      const x0 = this.cx(this.xOf(j.start));
      const x1 = this.cx(this.xOf(j.start + j.length));
      ctx.fillStyle = 'rgba(229,57,53,0.25)';
      ctx.fillRect(x0, y + 4, Math.max(1, x1 - x0), TRACK_H - 9);
      ctx.fillStyle = slot?.color ?? '#90a4ae';
      ctx.fillRect(x0, y + 4, Math.max(1, x1 - x0), 3);
      ctx.fillStyle = '#ffcdd2';
      ctx.font = '11px system-ui, sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText(`♪ ${slot?.name ?? 'Jingle'}`, Math.max(4, x0 + 4), y + 10, Math.max(10, x1 - x0 - 8));
    }
  }

  /** Draws the waveform of a take that is still being recorded, starting at x0. */
  private drawLiveWaveform(ctx: CanvasRenderingContext2D, levels: PeakLevel[], x0: number, x1: number, y: number, hgt: number): void {
    const base = levels[0];
    if (!base) return;
    drawLevelsWaveform(ctx, levels, {
      x0: Math.max(0, Math.floor(x0)),
      x1: Math.ceil(x1),
      originX: x0,
      srcStart: 0,
      srcEnd: (base.data.length / 2) * base.samplesPerPeak,
      framesPerPx: this.sr / this.pxPerSec,
      mid: y + hgt / 2 + 6,
      half: (hgt - 16) / 2,
      top: y + 4,
      bottom: y + hgt - 1,
      color: '#ef9a9a',
    });
  }

  private clipGeometry(trackIndex: number, clip: Clip): { x: number; y: number; w: number; start: number; length: number; offset: number; trackIndex: number } {
    let start = clip.start;
    let length = clip.length;
    let offset = clip.offset;
    let ti = trackIndex;
    const d = this.drag;
    if (d?.kind === 'clip' && d.moved && d.ids.has(clip.id)) {
      start = Math.max(0, clip.start + d.delta);
      ti = Math.max(0, Math.min(store.project.tracks.length - 1, trackIndex + d.dTrack));
    } else if (d?.kind === 'trim' && d.clipId === clip.id) {
      ({ start, length, offset } = trimmed(d.orig, d.side, d.delta));
    }
    return { x: this.xOf(start), y: ti * TRACK_H + 4, w: (length / this.sr) * this.pxPerSec, start, length, offset, trackIndex: ti };
  }

  private drawClip(ctx: CanvasRenderingContext2D, track: Track, trackIndex: number, clip: Clip): void {
    const g = this.clipGeometry(trackIndex, clip);
    const hgt = TRACK_H - 9;
    if (g.x > this.width || g.x + g.w < 0) return;
    const selected = store.selection.clipIds.has(clip.id);
    const muted = track.mute || (store.project.tracks.some((t) => t.solo) && !track.solo);
    ctx.globalAlpha = muted ? 0.4 : 1;
    // visible part of the clip: at deep zoom a clip can be millions of pixels wide
    const vx0 = this.cx(g.x);
    const vx1 = this.cx(g.x + g.w);
    ctx.fillStyle = selected ? '#2f3b52' : '#262b36';
    ctx.fillRect(vx0, g.y, vx1 - vx0, hgt);
    ctx.fillStyle = track.color;
    ctx.fillRect(vx0, g.y, vx1 - vx0, 3);
    // waveform
    const peaks = store.requestPeaks(clip.file);
    if (peaks && peaks.levels.length) {
      // the waveform shows the clip as it sounds: fades and volume line applied
      const env = clip.envelope?.length ? clip.envelope : undefined;
      const fx = fadesOf(track, clip);
      const fades = fx.fadeIn > 0 || fx.fadeOut > 0;
      drawFileWaveform(ctx, store.waves, clip.file, peaks, {
        x0: Math.max(0, Math.floor(g.x)),
        x1: Math.min(this.width, Math.ceil(g.x + g.w)),
        originX: g.x,
        srcStart: g.offset,
        srcEnd: g.offset + g.length,
        framesPerPx: this.sr / this.pxPerSec,
        mid: g.y + hgt / 2 + 6,
        half: (hgt - 16) / 2,
        top: g.y + 4,
        bottom: g.y + hgt - 1,
        color: track.color,
        gain:
          env || fades
            ? (src) => (fades ? fadesAt(fx, clip.length, src - g.offset) : 1) * (env ? envelopeAmpAt(env, src) : 1)
            : undefined,
      });
    } else if (!peaks) {
      ctx.fillStyle = '#3a404d';
      ctx.fillRect(vx0, g.y + hgt / 2, vx1 - vx0, 1);
    }
    // fades: the faded-out part is shaded, the curve drawn on top
    const eff = fadesOf(track, clip);
    const fi = (clip.fadeIn / this.sr) * this.pxPerSec;
    const fo = (clip.fadeOut / this.sr) * this.pxPerSec;
    const efi = (eff.fadeIn / this.sr) * this.pxPerSec;
    const efo = (eff.fadeOut / this.sr) * this.pxPerSec;
    ctx.fillStyle = 'rgba(8,9,12,0.45)';
    // crossfades over an overlap are drawn in the accent colour
    ctx.strokeStyle = eff.autoIn ? 'rgba(255,202,40,0.9)' : 'rgba(255,255,255,0.7)';
    if (efi > 0) this.drawFade(ctx, g.x, g.x + efi, g.y + 3, g.y + hgt, 'in', eff.inShape);
    ctx.strokeStyle = eff.autoOut ? 'rgba(255,202,40,0.9)' : 'rgba(255,255,255,0.7)';
    if (efo > 0) this.drawFade(ctx, g.x + g.w - efo, g.x + g.w, g.y + 3, g.y + hgt, 'out', eff.outShape);
    // fade handles at the top corners of the hovered or dragged clip
    const fadeDrag = this.drag?.kind === 'fade' && this.drag.clipId === clip.id ? this.drag : null;
    if ((this.hoverClipId === clip.id || fadeDrag) && g.w > 2 * FADE_HANDLE_PX) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(g.x + fi - 3, g.y, 6, 6);
      ctx.fillRect(g.x + g.w - fo - 3, g.y, 6, 6);
      if (fadeDrag) {
        const len = fadeDrag.side === 'in' ? clip.fadeIn : clip.fadeOut;
        ctx.font = '10px system-ui, sans-serif';
        ctx.textBaseline = 'top';
        const label = `${fadeDrag.side === 'in' ? 'Fade in' : 'Fade out'} ${(len / this.sr).toFixed(2)} s`;
        const lx = fadeDrag.side === 'in' ? g.x + fi + 6 : g.x + g.w - fo - 6 - ctx.measureText(label).width;
        ctx.fillText(label, lx, g.y + 20);
      }
    }
    if (clip.showEnvelope) this.drawClipEnvelope(ctx, clip, g);
    // volume-line toggle, shown while hovering (and while the line is visible)
    if ((this.hoverClipId === clip.id || clip.showEnvelope) && g.w >= VOL_BTN.x + VOL_BTN.w + 8 && !this.drag) {
      const bx = g.x + VOL_BTN.x;
      const by = g.y + VOL_BTN.y;
      ctx.fillStyle = clip.showEnvelope ? 'rgba(105,240,174,0.28)' : 'rgba(15,16,20,0.45)';
      ctx.fillRect(bx, by, VOL_BTN.w, VOL_BTN.h);
      ctx.strokeStyle = clip.showEnvelope ? 'rgba(105,240,174,0.8)' : 'rgba(255,255,255,0.35)';
      ctx.strokeRect(bx + 0.5, by + 0.5, VOL_BTN.w - 1, VOL_BTN.h - 1);
      ctx.fillStyle = clip.showEnvelope ? '#b9f6ca' : 'rgba(255,255,255,0.75)';
      ctx.font = '9px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText('Vol', bx + 6, by + VOL_BTN.h / 2 + 0.5);
    }
    ctx.strokeStyle = selected ? '#9ab8ff' : '#11131a';
    ctx.strokeRect(vx0 + 0.5, g.y + 0.5, vx1 - vx0 - 1, hgt - 1);
    if (g.w > 60) {
      ctx.fillStyle = '#c9cdd6';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textBaseline = 'top';
      const jingle = track.kind === 'soundboard' ? store.project.soundboard.find((s) => jingleMediaFile(s.id, this.sr) === clip.file) : undefined;
      const name = jingle ? `♪ ${jingle.name}` : clip.file.split('/').pop() ?? '';
      ctx.fillText(`${name}${clip.gain ? `  ${clip.gain > 0 ? '+' : ''}${clip.gain} dB` : ''}`, Math.max(g.x, 0) + 5, g.y + 6, Math.max(10, g.w - 10));
    }
    ctx.globalAlpha = 1;
  }

  /**
   * A fade's gain line from (xa, ya) to (xb, yb), with the part above it shaded, cut to the
   * visible columns so it stays exact however far the view is zoomed in.
   */
  private drawFade(ctx: CanvasRenderingContext2D, xa: number, xb: number, top: number, bottom: number, dir: 'in' | 'out', shape: FadeShape): void {
    const l = this.cx(xa);
    const r = this.cx(xb);
    if (r <= l) return;
    const yAt = (x: number) => {
      const t = (x - xa) / (xb - xa);
      return bottom - (bottom - top) * fadeCurve(dir === 'in' ? t : 1 - t, shape);
    };
    // the curve, sampled every few pixels of what is visible
    const steps = Math.max(1, Math.min(64, Math.ceil((r - l) / 3)));
    const pts: Array<[number, number]> = [];
    for (let k = 0; k <= steps; k++) {
      const x = l + ((r - l) * k) / steps;
      pts.push([x, yAt(x)]);
    }
    ctx.beginPath();
    ctx.moveTo(l, top);
    ctx.lineTo(r, top);
    for (let k = pts.length - 1; k >= 0; k--) ctx.lineTo(pts[k][0], pts[k][1]);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
  }

  // ------------------------------------------------------------ interaction

  private hitClip(
    x: number,
    y: number,
  ): { track: Track; trackIndex: number; clip: Clip; edge: 'left' | 'right' | null; fade: 'in' | 'out' | null } | null {
    const ti = Math.floor(y / TRACK_H);
    const track = store.project.tracks[ti];
    if (!track) return null;
    for (let k = track.clips.length - 1; k >= 0; k--) {
      const clip = track.clips[k];
      const x0 = this.xOf(clip.start);
      const x1 = this.xOf(clip.start + clip.length);
      if (x >= x0 - 2 && x <= x1 + 2) {
        // top strip: fade handles, which sit where each fade ends (at the corner when there is none)
        let fade: 'in' | 'out' | null = null;
        const top = ti * TRACK_H + 4;
        if (y >= top - 2 && y < top + FADE_ZONE_PX && x1 - x0 > 2 * FADE_HANDLE_PX) {
          const dIn = Math.abs(x - (x0 + (clip.fadeIn / this.sr) * this.pxPerSec));
          const dOut = Math.abs(x - (x1 - (clip.fadeOut / this.sr) * this.pxPerSec));
          if (dIn <= FADE_HANDLE_PX || dOut <= FADE_HANDLE_PX) fade = dIn <= dOut ? 'in' : 'out';
        }
        if (!fade && (x < x0 || x > x1)) continue;
        const edge = fade ? null : x - x0 < EDGE_PX && x1 - x0 > 3 * EDGE_PX ? 'left' : x1 - x < EDGE_PX && x1 - x0 > 3 * EDGE_PX ? 'right' : null;
        return { track, trackIndex: ti, clip, edge, fade };
      }
    }
    return null;
  }

  /** Selection edge under the mouse: on the ruler, or on a track the selection covers. */
  private hitRangeEdge(x: number, trackIndex: number | null): { fixed: number; edge: number } | null {
    const r = store.selection.range;
    if (!r) return null;
    const ids = store.selection.rangeTracks;
    if (trackIndex !== null && ids && !ids.includes(store.project.tracks[trackIndex]?.id ?? '')) return null;
    const d0 = Math.abs(x - this.xOf(r[0]));
    const d1 = Math.abs(x - this.xOf(r[1]));
    if (Math.min(d0, d1) > RANGE_EDGE_PX) return null;
    return d0 <= d1 ? { fixed: r[1], edge: r[0] } : { fixed: r[0], edge: r[1] };
  }

  /** Snaps candidate positions (frames) to nearby edges; returns the offset to apply. */
  private snapDelta(candidates: number[], exclude: ReadonlySet<string>, e: MouseEvent, extra: number[] = []): number {
    this.snapLine = null;
    if (!this.snapping || e.altKey) return 0;
    const targets = snapTargets(store.project, exclude, [store.transport.position, ...extra]);
    const res = snap(candidates, targets, Math.round((SNAP_PX / this.pxPerSec) * this.sr));
    if (!res) return 0;
    this.snapLine = res.target;
    return res.delta;
  }

  /** Mouse position as a frame, snapped unless Alt is held. */
  private snappedFrame(x: number, e: MouseEvent, extra: number[] = []): number {
    const f = this.frameOf(x);
    return Math.max(0, f + this.snapDelta([f], new Set(), e, extra));
  }

  private bindEvents(): void {
    const local = (e: MouseEvent, el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    this.hscroll.addEventListener('input', () => {
      this.viewStart = Number(this.hscroll.value) / 1000;
      this.draw();
    });

    const onWheel = (e: WheelEvent, el: HTMLElement) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        this.zoom(e.deltaY < 0 ? 1.2 : 1 / 1.2, local(e, el).x);
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        const d = e.shiftKey ? e.deltaY : e.deltaX;
        this.viewStart = Math.max(0, this.viewStart + d / this.pxPerSec);
        this.draw();
      }
    };
    this.canvas.addEventListener('wheel', (e) => onWheel(e, this.canvas), { passive: false });
    this.rulerCanvas.addEventListener('wheel', (e) => onWheel(e, this.rulerCanvas), { passive: false });

    // Middle mouse button drag pans the view, horizontally and vertically, like in Reaper.
    const startPan = (e: MouseEvent) => {
      if (e.button !== 1) return;
      e.preventDefault(); // no autoscroll cursor or middle-click paste
      e.stopImmediatePropagation();
      this.drag = null;
      this.snapLine = null;
      this.pan = { startX: e.clientX, startY: e.clientY, viewStart: this.viewStart, scrollTop: this.scroll.scrollTop };
      document.body.classList.add('panning');
    };
    this.canvas.addEventListener('mousedown', startPan, { capture: true });
    this.rulerCanvas.addEventListener('mousedown', startPan, { capture: true });
    window.addEventListener('mousemove', (e) => {
      const p = this.pan;
      if (!p) return;
      this.viewStart = Math.max(0, p.viewStart - (e.clientX - p.startX) / this.pxPerSec);
      this.scroll.scrollTop = p.scrollTop - (e.clientY - p.startY);
      this.draw();
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button !== 1 || !this.pan) return;
      this.pan = null;
      document.body.classList.remove('panning');
    });
    window.addEventListener('blur', () => {
      this.pan = null;
      document.body.classList.remove('panning');
    });

    this.rulerCanvas.addEventListener('mousedown', (e) => {
      const { x, y } = local(e, this.rulerCanvas);
      if (y >= RULER_H) {
        const m = this.hitMarker(x);
        if (m) {
          store.select({ markerId: m.id, clipIds: new Set() });
          this.drag = { kind: 'marker', markerId: m.id, startX: e.clientX, origPos: m.position, dx: 0, moved: false };
          return;
        }
      }
      // drag a selection edge
      const edge = this.hitRangeEdge(x, null);
      if (edge) {
        this.drag = { kind: 'rangeEdge', fixed: edge.fixed, current: edge.edge, tracks: store.selection.rangeTracks ?? null, moved: false };
        return;
      }
      // click = seek, drag = select a time range across all tracks
      const f = this.snappedFrame(x, e);
      this.drag = { kind: 'range', startFrame: f, endFrame: f, startTrack: null, endTrack: null };
    });
    this.rulerCanvas.addEventListener('mousemove', (e) => {
      if (this.drag || this.pan) return;
      const { x, y } = local(e, this.rulerCanvas);
      const onEdge = !(y >= RULER_H && this.hitMarker(x)) && this.hitRangeEdge(x, null);
      this.rulerCanvas.style.cursor = onEdge ? 'ew-resize' : '';
    });
    this.rulerCanvas.addEventListener('dblclick', (e) => {
      const { x, y } = local(e, this.rulerCanvas);
      if (y < RULER_H) return;
      const m = this.hitMarker(x);
      if (m) {
        store.select({ markerId: m.id });
        store.setView('chapters');
      }
    });

    this.canvas.addEventListener('mouseleave', () => {
      if (this.hoverClipId && !this.drag) {
        this.hoverClipId = null;
        this.draw();
      }
    });

    this.canvas.addEventListener('mousemove', (e) => {
      if (this.drag || this.pan) return;
      const { x, y } = local(e, this.canvas);
      const hit = this.hitClip(x, y);
      const hover = hit?.clip.id ?? null;
      if (hover !== this.hoverClipId) {
        this.hoverClipId = hover;
        this.draw();
      }
      const lane = this.hitMuteLane(x, y);
      if (lane) {
        this.canvas.style.cursor = lane.edge ? 'ew-resize' : lane.index !== null ? 'pointer' : 'crosshair';
        this.canvas.title = lane.index !== null ? 'Muted region: drag edges to adjust, Delete or double-click to remove' : 'Drag to mute a region of this track';
        return;
      }
      const ti = Math.floor(y / TRACK_H);
      if (this.hitRangeEdge(x, ti)) {
        this.canvas.style.cursor = 'ew-resize';
        this.canvas.title = 'Drag to move this end of the selection';
        return;
      }
      if (hit?.fade) {
        this.canvas.style.cursor = 'ew-resize';
        this.canvas.title = hit.fade === 'in' ? 'Drag to fade in' : 'Drag to fade out';
        return;
      }
      if (this.hitVolButton(x, y)) {
        this.canvas.style.cursor = 'pointer';
        this.canvas.title = 'Show or hide this clip\'s volume line';
        return;
      }
      const env = this.hitEnvelope(x, y);
      if (env) {
        this.canvas.style.cursor = env.point !== null ? 'move' : 'ns-resize';
        this.canvas.title = env.point !== null ? 'Volume point: drag to move, double-click to remove' : 'Volume line: drag up or down, double-click to add a point';
        return;
      }
      this.canvas.title = this.inEnvelopeArea(x, y) ? 'Double-click to add a volume point' : '';
      this.canvas.style.cursor = hit?.edge ? 'ew-resize' : hit ? 'grab' : 'text';
    });

    this.canvas.addEventListener('dblclick', (e) => {
      const { x, y } = local(e, this.canvas);
      const lane = this.hitMuteLane(x, y);
      if (lane && lane.index !== null) {
        const index = lane.index;
        store.edit((p) => removeMuteRegion(p, lane.track.id, index));
        store.select({ muteRegion: null });
        return;
      }
      if (lane) return;
      // volume line: double-click a point to remove it, anywhere else on the track to add one on the line
      if (this.hitVolButton(x, y)) return;
      const env = this.hitEnvelope(x, y);
      if (env && env.point !== null) {
        const index = env.point;
        store.edit((p) => setClipEnvelope(p, env.clip.id, (env.clip.envelope ?? []).filter((_, i) => i !== index)));
        return;
      }
      const fadeHit = this.hitClip(x, y);
      if (fadeHit?.fade) {
        const key = fadeHit.fade === 'in' ? 'fadeInShape' : 'fadeOutShape';
        const cur = fadeHit.clip[key] ?? 'linear';
        const next = FADE_SHAPES[(FADE_SHAPES.findIndex((f) => f.id === cur) + 1) % FADE_SHAPES.length];
        store.edit((p) => updateClip(p, fadeHit.clip.id, { [key]: next.id }));
        toast(`Fade ${fadeHit.fade}: ${next.label}`);
        return;
      }
      const area = env ?? this.inEnvelopeArea(x, y);
      if (area && !fadeHit?.fade) {
        const pts = area.clip.envelope ?? [];
        const src = toSource(area.clip, this.frameOf(x));
        store.edit((p) => setClipEnvelope(p, area.clip.id, addPoint(pts, src, envelopeDbAt(pts, src)).points));
      }
    });

    this.canvas.addEventListener('mousedown', (e) => {
      const { x, y } = local(e, this.canvas);
      this.snapLine = null;
      const lane = this.hitMuteLane(x, y);
      if (lane) {
        const f = this.frameOf(x);
        const regions = lane.track.muteRegions ?? [];
        if (lane.index !== null) store.select({ muteRegion: { trackId: lane.track.id, index: lane.index }, clipIds: new Set(), range: null, rangeTracks: null, markerId: null });
        else store.select({ muteRegion: null, clipIds: new Set(), range: null, rangeTracks: null, markerId: null });
        if (lane.index === null) {
          this.drag = { kind: 'mute', trackId: lane.track.id, index: null, edge: 'new', anchor: f, current: f, moved: false };
        } else if (lane.edge) {
          const r = regions[lane.index];
          this.drag = { kind: 'mute', trackId: lane.track.id, index: lane.index, edge: lane.edge, anchor: lane.edge === 'left' ? r[1] : r[0], current: f, moved: false };
        }
        this.draw();
        return;
      }
      if (store.selection.muteRegion) store.select({ muteRegion: null });
      const ti = Math.floor(y / TRACK_H);
      // 1. selection edges
      const edge = this.hitRangeEdge(x, ti);
      if (edge) {
        this.drag = { kind: 'rangeEdge', fixed: edge.fixed, current: edge.edge, tracks: store.selection.rangeTracks ?? null, moved: false };
        return;
      }
      const hit = this.hitClip(x, y);
      // 2. fade handles
      if (hit?.fade) {
        store.select({ clipIds: new Set([hit.clip.id]), markerId: null });
        this.drag = { kind: 'fade', clipId: hit.clip.id, side: hit.fade, startX: e.clientX, orig: { ...hit.clip }, moved: false };
        return;
      }
      // 3. the clip's volume-line toggle
      const volClip = this.hitVolButton(x, y);
      if (volClip) {
        store.edit((p) => updateClip(p, volClip.id, { showEnvelope: !volClip.showEnvelope }));
        return;
      }
      // 4. volume line points and segments
      const env = this.hitEnvelope(x, y);
      if (env) {
        const orig = env.clip.envelope ?? [];
        const base = { clipId: env.clip.id, ti: env.ti, startY: e.clientY, moved: false };
        if (env.point !== null) {
          this.drag = { kind: 'envPoint', clipId: env.clip.id, ti: env.ti, index: env.point, orig, moved: false };
        } else if (!orig.length) {
          // no points yet: the first drag creates one and moves the whole line
          this.drag = { kind: 'envLine', ...base, indices: [0], orig: [{ pos: env.src, db: 0 }] };
        } else {
          // the two points around the mouse (one at either end of the line)
          let i1 = orig.findIndex((p) => p.pos > env.src);
          if (i1 < 0) i1 = orig.length;
          const indices = [i1 - 1, i1].filter((i) => i >= 0 && i < orig.length);
          this.drag = { kind: 'envLine', ...base, indices, orig };
        }
        this.draw();
        return;
      }
      // 5. clips: trim edges or move
      if (hit) {
        const sel = new Set(e.shiftKey ? store.selection.clipIds : []);
        if (e.shiftKey && sel.has(hit.clip.id)) sel.delete(hit.clip.id);
        else sel.add(hit.clip.id);
        if (!e.shiftKey && store.selection.clipIds.has(hit.clip.id)) for (const id of store.selection.clipIds) sel.add(id);
        store.select({ clipIds: sel, range: null, rangeTracks: null, markerId: null });
        if (hit.edge) {
          this.drag = { kind: 'trim', clipId: hit.clip.id, side: hit.edge, startX: e.clientX, orig: { ...hit.clip }, delta: 0 };
        } else {
          // every selected clip moves along; limit the track offset so none leaves the track list
          const ids = sel.has(hit.clip.id) ? sel : new Set([hit.clip.id]);
          const rows = store.project.tracks.flatMap((t, i) => (t.clips.some((c) => ids.has(c.id)) ? [i] : []));
          this.drag = {
            kind: 'clip',
            clipId: hit.clip.id,
            ids,
            startX: e.clientX,
            startY: e.clientY,
            delta: 0,
            dTrack: 0,
            minDTrack: -Math.min(...rows),
            maxDTrack: store.project.tracks.length - 1 - Math.max(...rows),
            moved: false,
          };
        }
      } else {
        // 6. empty space: select a time range on the tracks dragged across
        const f = this.snappedFrame(x, e);
        store.select({ clipIds: new Set(), markerId: null });
        const row = Math.max(0, Math.min(store.project.tracks.length - 1, ti));
        this.drag = { kind: 'range', startFrame: f, endFrame: f, startTrack: row, endTrack: row };
      }
    });

    window.addEventListener('mousemove', (e) => {
      const d = this.drag;
      if (!d) return;
      const pos = local(e, this.canvas);
      const framesOf = (px: number) => Math.round((px / this.pxPerSec) * this.sr);
      if (d.kind === 'clip') {
        const dx = e.clientX - d.startX;
        d.dTrack = Math.max(d.minDTrack, Math.min(d.maxDTrack, Math.round((e.clientY - d.startY) / TRACK_H)));
        if (Math.abs(dx) > 3 || d.dTrack) d.moved = true;
        // moving to another track with little sideways movement keeps the position, so tracks stay in sync
        const locked = d.dTrack !== 0 && Math.abs(dx) < TRACK_MOVE_LOCK_PX;
        let delta = locked ? 0 : framesOf(dx);
        this.snapLine = null;
        // snap the dragged clip's start or end to edges of the clips that stay put
        const clip = store.project.tracks.flatMap((t) => t.clips).find((c) => c.id === d.clipId);
        if (clip && d.moved && !locked) delta += this.snapDelta([clip.start + delta, clip.start + clip.length + delta], d.ids, e);
        // no selected clip may move before zero
        const minStart = Math.min(...store.project.tracks.flatMap((t) => t.clips.filter((c) => d.ids.has(c.id)).map((c) => c.start)));
        d.delta = Math.max(-minStart, delta);
        this.draw();
      } else if (d.kind === 'trim') {
        let delta = framesOf(e.clientX - d.startX);
        const edgeAt = (dl: number) => {
          const t = trimmed(d.orig, d.side, dl);
          return d.side === 'left' ? t.start : t.start + t.length;
        };
        delta += this.snapDelta([edgeAt(delta)], new Set([d.clipId]), e);
        d.delta = delta;
        this.draw();
      } else if (d.kind === 'fade') {
        d.moved = true;
        const o = d.orig;
        const raw = framesOf(e.clientX - d.startX);
        const edge = d.side === 'in' ? o.start + o.fadeIn + raw : o.start + o.length - o.fadeOut + raw;
        const snapped = edge + this.snapDelta([edge], new Set([d.clipId]), e);
        const patch =
          d.side === 'in'
            ? { fadeIn: Math.max(0, Math.min(o.length - o.fadeOut, snapped - o.start)) }
            : { fadeOut: Math.max(0, Math.min(o.length - o.fadeIn, o.start + o.length - snapped)) };
        store.editLive((p) => updateClip(p, d.clipId, patch));
        this.draw();
      } else if (d.kind === 'range') {
        d.endFrame = this.snappedFrame(pos.x, e);
        if (d.startTrack !== null) d.endTrack = Math.max(0, Math.min(store.project.tracks.length - 1, Math.floor(pos.y / TRACK_H)));
        this.draw();
      } else if (d.kind === 'rangeEdge') {
        d.current = this.snappedFrame(pos.x, e);
        d.moved = true;
        this.draw();
      } else if (d.kind === 'envPoint') {
        d.moved = true;
        const clip = store.project.tracks[d.ti]?.clips.find((c) => c.id === d.clipId);
        if (clip) {
          const prev = d.orig[d.index - 1]?.pos ?? clip.offset;
          const next = d.orig[d.index + 1]?.pos ?? clip.offset + clip.length;
          const pts = d.orig.map((p) => ({ ...p }));
          pts[d.index] = { pos: Math.max(prev, Math.min(next, toSource(clip, this.frameOf(pos.x)))), db: this.dbOfY(pos.y, d.ti) };
          store.editLive((p) => setClipEnvelope(p, d.clipId, pts));
        }
      } else if (d.kind === 'envLine') {
        d.moved = true;
        const dy = e.clientY - d.startY;
        const pts = d.orig.map((p, i) => (d.indices.includes(i) ? { pos: p.pos, db: this.dbOfY(this.yOfDb(p.db, d.ti) + dy, d.ti) } : { ...p }));
        store.editLive((p) => setClipEnvelope(p, d.clipId, pts));
      } else if (d.kind === 'marker') {
        d.dx = e.clientX - d.startX;
        if (Math.abs(d.dx) > 3) d.moved = true;
        this.draw();
      } else if (d.kind === 'mute') {
        d.current = this.frameOf(pos.x);
        d.moved = true;
        this.draw();
      }
    });

    window.addEventListener('mouseup', () => {
      const d = this.drag;
      this.drag = null;
      this.snapLine = null;
      if (!d) return;
      if (d.kind === 'clip' && d.moved) {
        store.edit((p) => {
          let q = p;
          for (const id of d.ids) {
            const ti = q.tracks.findIndex((t) => t.clips.some((c) => c.id === id));
            if (ti < 0) continue;
            const found = q.tracks[ti].clips.find((c) => c.id === id)!;
            const toTrack = d.dTrack ? q.tracks[Math.max(0, Math.min(q.tracks.length - 1, ti + d.dTrack))]?.id : undefined;
            q = moveClip(q, id, found.start + d.delta, toTrack);
          }
          return q;
        });
      } else if (d.kind === 'trim' && d.delta !== 0) {
        store.edit((p) => updateClip(p, d.clipId, trimmed(d.orig, d.side, d.delta)));
      } else if (d.kind === 'fade' || d.kind === 'envPoint' || d.kind === 'envLine') {
        store.commitLive();
      } else if (d.kind === 'range') {
        const a = Math.min(d.startFrame, d.endFrame);
        const b = Math.max(d.startFrame, d.endFrame);
        if (((b - a) / this.sr) * this.pxPerSec < 4) {
          store.select({ range: null, rangeTracks: null });
          seek(a);
        } else {
          store.select({ range: [a, b], rangeTracks: this.tracksBetween(d.startTrack, d.endTrack) });
        }
      } else if (d.kind === 'rangeEdge' && d.moved) {
        const a = Math.min(d.fixed, d.current);
        const b = Math.max(d.fixed, d.current);
        store.select(b > a ? { range: [a, b], rangeTracks: d.tracks } : { range: null, rangeTracks: null });
      } else if (d.kind === 'mute' && d.moved) {
        const a = Math.min(d.anchor, d.current);
        const b = Math.max(d.anchor, d.current);
        if (d.edge === 'new') {
          if (((b - a) / this.sr) * this.pxPerSec >= 3) store.edit((p) => addMuteRegion(p, d.trackId, a, b));
        } else if (d.index !== null) {
          const index = d.index;
          store.edit((p) => updateMuteRegion(p, d.trackId, index, a, b));
        }
        store.select({ muteRegion: null });
      } else if (d.kind === 'marker' && d.moved) {
        const pos = Math.max(0, d.origPos + Math.round((d.dx / this.pxPerSec) * this.sr));
        store.edit((p) => updateMarker(p, d.markerId, { position: pos }));
      }
      this.draw();
    });
  }

  private hitMarker(x: number) {
    let best: { id: string; position: number; d: number } | null = null;
    for (const m of store.project.markers) {
      const mx = this.xOf(m.position);
      const d = x - mx;
      if (d >= -3 && d <= 12 && (!best || Math.abs(d) < best.d)) best = { id: m.id, position: m.position, d: Math.abs(d) };
    }
    return best ? store.project.markers.find((m) => m.id === best!.id)! : null;
  }
}

function coughKey(trackId: string): string {
  const n = store.project.tracks.filter((t) => t.kind !== 'soundboard').findIndex((t) => t.id === trackId) + 1;
  return n >= 1 && n <= 9 ? ` (Shift+${n})` : '';
}

function trimmed(orig: Clip, side: 'left' | 'right', delta: number): Pick<Clip, 'start' | 'length' | 'offset'> {
  const minLen = 64;
  if (side === 'right') {
    return { start: orig.start, offset: orig.offset, length: Math.max(minLen, orig.length + delta) };
  }
  // left edge: can't go before the start of the source file
  const d = Math.max(-orig.offset, -orig.start, Math.min(orig.length - minLen, delta));
  return { start: orig.start + d, offset: orig.offset + d, length: orig.length - d };
}

function formatDb(db: number): string {
  return db <= -60 ? '-inf dB' : `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

function readSnapSetting(): boolean {
  try {
    return (localStorage.getItem(SNAP_KEY) ?? localStorage.getItem('soundpod.timeline.snap')) !== '0';
  } catch {
    return true;
  }
}

/** Effective fades per track object (tracks are replaced on every edit, so this never goes stale). */
const fadeCache = new WeakMap<Track, Map<string, EffectiveFades>>();

function fadesOf(track: Track, clip: Clip): EffectiveFades {
  let m = fadeCache.get(track);
  if (!m) {
    m = trackFades(track);
    fadeCache.set(track, m);
  }
  return m.get(clip.id) ?? trackFades({ ...track, clips: [clip] }).get(clip.id)!;
}
