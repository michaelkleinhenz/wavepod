// Record & Edit view: track headers, canvas timeline with waveforms, markers, selection and transport following.
import type { Clip, Track } from '../shared/types';
import { formatTimestamp } from '../shared/time';
import { addTrack, moveClip, removeTrack, updateClip, updateMarker, updateTrack } from '../core/project';
import { projectLength } from '../core/project';
import { fadeGain, toDb } from '../core/dsp';
import { jingleMediaFile } from '../core/soundboard';
import { clear, h, toast } from './dom';
import { deleteSelection, dropMarker, importAudioFiles, seek, splitAtPlayhead } from './actions';
import { store } from './store';

const TRACK_H = 84;
const RULER_H = 26;
const MARKER_H = 24;
const HEADER_W = 250;
const EDGE_PX = 6;

type Drag =
  | { kind: 'clip'; clipId: string; trackIndex: number; startX: number; startY: number; origStart: number; dx: number; dTrack: number; moved: boolean }
  | { kind: 'trim'; clipId: string; side: 'left' | 'right'; startX: number; orig: Clip; dx: number }
  | { kind: 'range'; startFrame: number; endFrame: number; startX: number }
  | { kind: 'marker'; markerId: string; startX: number; origPos: number; dx: number; moved: boolean };

export class TimelineView {
  readonly el = h('div', { class: 'view edit-view' });
  private toolbar = h('div', { class: 'toolbar' });
  private rulerCanvas = h('canvas', { class: 'ruler-canvas' });
  private scroll = h('div', { class: 'tracks-scroll' });
  private headers = h('div', { class: 'track-headers' });
  private canvas = h('canvas', { class: 'tracks-canvas' });
  private hscroll = h('input', { type: 'range', class: 'hscroll', min: '0', max: '1000', value: '0' });
  private trackMeters = new Map<string, HTMLElement>();

  /** Seconds at the left edge. */
  viewStart = 0;
  pxPerSec = 40;
  private width = 800;
  private drag: Drag | null = null;
  private lastFollowPos = 0;

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

  private totalSeconds(): number {
    const end = Math.max(projectLength(store.project), store.transport.position);
    return Math.max(60, end / this.sr + 30);
  }

  zoom(factor: number, anchorX = this.width / 2): void {
    const anchorSec = anchorX / this.pxPerSec + this.viewStart;
    this.pxPerSec = Math.min(4000, Math.max(0.5, this.pxPerSec * factor));
    this.viewStart = Math.max(0, anchorSec - anchorX / this.pxPerSec);
    this.draw();
  }

  zoomToFit(): void {
    const len = projectLength(store.project) / this.sr;
    this.pxPerSec = Math.max(0.5, (this.width - 20) / Math.max(10, len));
    this.viewStart = 0;
    this.draw();
  }

  // ------------------------------------------------------------ DOM

  private buildToolbar(): void {
    const btn = (label: string, title: string, onclick: () => void, cls = '') => h('button', { class: `small ${cls}`, title, onclick }, label);
    this.toolbar.append(
      btn('+ Track', 'Add an empty track', () => store.edit((p) => addTrack(p))),
      btn('Import audio…', 'Import audio files as new tracks at the playhead (Ctrl+I)', () => void importAudioFiles()),
      h('span', { class: 'sep' }),
      btn('Split', 'Split clips at the playhead (S)', splitAtPlayhead),
      btn('Ripple delete', 'Remove the selected time range from all tracks and close the gap (Shift+Delete)', () => {
        if (!store.selection.range) toast('Drag across the ruler (or an empty part of a track) to select a range first');
        else deleteSelection(true);
      }),
      btn('Fade', 'Add short fades to selected clips (F)', () => this.fadeSelected()),
      h('span', { class: 'sep' }),
      btn('⚑ Chapter', 'Add a chapter marker at the playhead (M)', () => dropMarker('chapter'), 'chapter'),
      btn('✎ Edit mark', 'Add an edit marker at the playhead (E)', () => dropMarker('edit'), 'editmark'),
      h('span', { class: 'sep' }),
      btn('−', 'Zoom out (-)', () => this.zoomAtPlayhead(1 / 1.5)),
      btn('+', 'Zoom in (+)', () => this.zoomAtPlayhead(1.5)),
      btn('Fit', 'Zoom to fit the whole episode', () => this.zoomToFit()),
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted hint-keys' }, 'Space play · R record · M chapter · E edit mark · S split · Del delete'),
    );
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
      const meter = h('div', { class: 'meter-fill' });
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
            h('div', { class: 'meter small' }, meter),
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
      const el = this.trackMeters.get(t.id);
      if (!el) continue;
      const v = Math.max(0, ...t.inputChannels.map((c) => peaks[c] ?? 0));
      const db = toDb(v, -60);
      el.style.width = `${((db + 60) / 60) * 100}%`;
      el.classList.toggle('hot', db > -6);
      el.classList.toggle('clip', db > -0.5);
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
    if (this.drag || (t.state === 'stopped' && !moved)) return;
    const x = this.xOf(t.position);
    if (x > this.width * 0.92 || x < 0) {
      this.viewStart = Math.max(0, t.position / this.sr - (this.width * 0.1) / this.pxPerSec);
    }
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
    this.hscroll.max = String(Math.round(maxStart * 100));
    this.hscroll.value = String(Math.round(Math.min(this.viewStart, maxStart) * 100));
  }

  private ctx(c: HTMLCanvasElement): CanvasRenderingContext2D {
    const ctx = c.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  private tickStep(): number {
    const minPx = 80;
    for (const s of [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]) if (s * this.pxPerSec >= minPx) return s;
    return 7200;
  }

  private drawRuler(): void {
    const ctx = this.ctx(this.rulerCanvas);
    const w = this.width;
    ctx.fillStyle = '#1d2027';
    ctx.fillRect(0, 0, w, RULER_H + MARKER_H);
    ctx.fillStyle = '#23262e';
    ctx.fillRect(0, RULER_H, w, MARKER_H);
    const step = this.tickStep();
    const first = Math.floor(this.viewStart / step) * step;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    for (let s = first; s < this.viewStart + w / this.pxPerSec; s += step) {
      const x = Math.round((s - this.viewStart) * this.pxPerSec) + 0.5;
      ctx.strokeStyle = '#4a4f5c';
      ctx.beginPath();
      ctx.moveTo(x, RULER_H - 10);
      ctx.lineTo(x, RULER_H);
      ctx.stroke();
      ctx.fillStyle = '#9aa1b0';
      ctx.fillText(formatTimestamp(s, step < 1).replace(/^00:/, ''), x + 3, 4);
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
      ctx.fillRect(this.xOf(r[0]), 0, this.xOf(r[1]) - this.xOf(r[0]), RULER_H);
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
  }

  private liveRange(): [number, number] | null {
    if (this.drag?.kind === 'range') {
      const a = Math.min(this.drag.startFrame, this.drag.endFrame);
      const b = Math.max(this.drag.startFrame, this.drag.endFrame);
      return b > a ? [a, b] : null;
    }
    return store.selection.range;
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
    for (let s = Math.floor(this.viewStart / step) * step; s < this.viewStart + w / this.pxPerSec; s += step) {
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
      for (const clip of t.clips) this.drawClip(ctx, t, i, clip);
      if (recording && t.kind === 'soundboard') this.drawLiveJingles(ctx, y);
      if (recording && t.armed && t.inputChannels.length) {
        const x0 = this.xOf(store.recordStart);
        const x1 = this.xOf(store.transport.position);
        ctx.fillStyle = 'rgba(229,57,53,0.25)';
        ctx.fillRect(x0, y + 4, Math.max(1, x1 - x0), TRACK_H - 9);
        const live = store.livePeaks.get(t.id);
        if (live) this.drawLiveWaveform(ctx, live, x0, Math.min(x1, w), y + 4, TRACK_H - 9);
        ctx.fillStyle = '#ffcdd2';
        ctx.font = '11px system-ui, sans-serif';
        ctx.textBaseline = 'top';
        ctx.fillText('● recording', Math.max(4, x0 + 4), y + 8);
      }
      ctx.fillStyle = '#0f1014';
      ctx.fillRect(0, y + TRACK_H - 1, w, 1);
    });
    const range = this.liveRange();
    if (range) {
      ctx.fillStyle = 'rgba(120,160,255,0.22)';
      ctx.fillRect(this.xOf(range[0]), 0, this.xOf(range[1]) - this.xOf(range[0]), height);
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
      const x0 = this.xOf(j.start);
      const x1 = this.xOf(j.start + j.length);
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
  private drawLiveWaveform(ctx: CanvasRenderingContext2D, live: { samplesPerPeak: number; data: number[] }, x0: number, x1: number, y: number, hgt: number): void {
    const mid = y + hgt / 2 + 6;
    const amp = (hgt - 16) / 2 / 127;
    const framesPerPx = this.sr / this.pxPerSec;
    const nPeaks = Math.floor(live.data.length / 2);
    ctx.fillStyle = '#ef9a9a';
    for (let x = Math.max(0, Math.floor(x0)); x < x1; x++) {
      const rel = (x - x0) * framesPerPx;
      const a = Math.floor(rel / live.samplesPerPeak);
      if (a >= nPeaks) break;
      const b = Math.min(nPeaks, Math.ceil((rel + framesPerPx) / live.samplesPerPeak));
      let mn = 0;
      let mx = 0;
      for (let k = a; k < Math.max(a + 1, b); k++) {
        const lo = live.data[k * 2] ?? 0;
        const hi = live.data[k * 2 + 1] ?? 0;
        if (lo < mn) mn = lo;
        if (hi > mx) mx = hi;
      }
      const top = mid - mx * amp;
      ctx.fillRect(x, top, 1, Math.max(1, mid - mn * amp - top));
    }
  }

  private clipGeometry(trackIndex: number, clip: Clip): { x: number; y: number; w: number; start: number; length: number; offset: number; trackIndex: number } {
    let start = clip.start;
    let length = clip.length;
    let offset = clip.offset;
    let ti = trackIndex;
    const d = this.drag;
    if (d?.kind === 'clip' && (d.clipId === clip.id || (store.selection.clipIds.has(clip.id) && store.selection.clipIds.has(d.clipId)))) {
      start = Math.max(0, clip.start + Math.round((d.dx / this.pxPerSec) * this.sr));
      if (d.clipId === clip.id) ti = Math.max(0, Math.min(store.project.tracks.length - 1, trackIndex + d.dTrack));
    } else if (d?.kind === 'trim' && d.clipId === clip.id) {
      const delta = Math.round((d.dx / this.pxPerSec) * this.sr);
      ({ start, length, offset } = trimmed(d.orig, d.side, delta));
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
    ctx.fillStyle = selected ? '#2f3b52' : '#262b36';
    ctx.fillRect(g.x, g.y, g.w, hgt);
    ctx.fillStyle = track.color;
    ctx.fillRect(g.x, g.y, g.w, 3);
    // waveform
    const peaks = store.requestPeaks(clip.file);
    if (peaks && peaks.data.length) {
      const mid = g.y + hgt / 2 + 6;
      const amp = (hgt - 16) / 2 / 127;
      ctx.fillStyle = track.color;
      const x0 = Math.max(0, Math.floor(g.x));
      const x1 = Math.min(this.width, Math.ceil(g.x + g.w));
      const framesPerPx = this.sr / this.pxPerSec;
      const nPeaks = peaks.data.length / 2;
      for (let x = x0; x < x1; x++) {
        const relA = (x - g.x) * framesPerPx;
        const relB = relA + framesPerPx;
        const a = Math.floor((g.offset + Math.max(0, relA)) / peaks.samplesPerPeak);
        const b = Math.min(nPeaks, Math.ceil((g.offset + Math.min(g.length, relB)) / peaks.samplesPerPeak));
        let mn = 0;
        let mx = 0;
        for (let k = a; k < Math.max(a + 1, b) && k < nPeaks; k++) {
          const lo = peaks.data[k * 2];
          const hi = peaks.data[k * 2 + 1];
          if (lo < mn) mn = lo;
          if (hi > mx) mx = hi;
        }
        const env = fadeEnvelope(clip, relA);
        const top = mid - mx * amp * env;
        const bot = mid - mn * amp * env;
        ctx.fillRect(x, top, 1, Math.max(1, bot - top));
      }
    } else if (!peaks) {
      ctx.fillStyle = '#3a404d';
      ctx.fillRect(g.x, g.y + hgt / 2, g.w, 1);
    }
    // fades
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    if (clip.fadeIn > 0) {
      ctx.beginPath();
      ctx.moveTo(g.x, g.y + hgt);
      ctx.lineTo(g.x + (clip.fadeIn / this.sr) * this.pxPerSec, g.y + 3);
      ctx.stroke();
    }
    if (clip.fadeOut > 0) {
      ctx.beginPath();
      ctx.moveTo(g.x + g.w - (clip.fadeOut / this.sr) * this.pxPerSec, g.y + 3);
      ctx.lineTo(g.x + g.w, g.y + hgt);
      ctx.stroke();
    }
    ctx.strokeStyle = selected ? '#9ab8ff' : '#11131a';
    ctx.strokeRect(g.x + 0.5, g.y + 0.5, g.w - 1, hgt - 1);
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

  // ------------------------------------------------------------ interaction

  private hitClip(x: number, y: number): { track: Track; trackIndex: number; clip: Clip; edge: 'left' | 'right' | null } | null {
    const ti = Math.floor(y / TRACK_H);
    const track = store.project.tracks[ti];
    if (!track) return null;
    for (let k = track.clips.length - 1; k >= 0; k--) {
      const clip = track.clips[k];
      const x0 = this.xOf(clip.start);
      const x1 = this.xOf(clip.start + clip.length);
      if (x >= x0 && x <= x1) {
        const edge = x - x0 < EDGE_PX && x1 - x0 > 3 * EDGE_PX ? 'left' : x1 - x < EDGE_PX && x1 - x0 > 3 * EDGE_PX ? 'right' : null;
        return { track, trackIndex: ti, clip, edge };
      }
    }
    return null;
  }

  private bindEvents(): void {
    const local = (e: MouseEvent, el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    this.hscroll.addEventListener('input', () => {
      this.viewStart = Number(this.hscroll.value) / 100;
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
      // click = seek, drag = select a time range across all tracks
      const f = this.frameOf(x);
      this.drag = { kind: 'range', startFrame: f, endFrame: f, startX: e.clientX };
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

    this.canvas.addEventListener('mousemove', (e) => {
      if (this.drag) return;
      const { x, y } = local(e, this.canvas);
      const hit = this.hitClip(x, y);
      this.canvas.style.cursor = hit?.edge ? 'ew-resize' : hit ? 'grab' : 'text';
    });

    this.canvas.addEventListener('mousedown', (e) => {
      const { x, y } = local(e, this.canvas);
      const hit = this.hitClip(x, y);
      if (hit) {
        const sel = new Set(e.shiftKey ? store.selection.clipIds : []);
        if (e.shiftKey && sel.has(hit.clip.id)) sel.delete(hit.clip.id);
        else sel.add(hit.clip.id);
        if (!e.shiftKey && store.selection.clipIds.has(hit.clip.id)) for (const id of store.selection.clipIds) sel.add(id);
        store.select({ clipIds: sel, range: null, markerId: null });
        if (hit.edge) {
          this.drag = { kind: 'trim', clipId: hit.clip.id, side: hit.edge, startX: e.clientX, orig: { ...hit.clip }, dx: 0 };
        } else {
          this.drag = { kind: 'clip', clipId: hit.clip.id, trackIndex: hit.trackIndex, startX: e.clientX, startY: e.clientY, origStart: hit.clip.start, dx: 0, dTrack: 0, moved: false };
        }
      } else {
        const f = this.frameOf(x);
        store.select({ clipIds: new Set(), markerId: null });
        this.drag = { kind: 'range', startFrame: f, endFrame: f, startX: e.clientX };
      }
    });

    window.addEventListener('mousemove', (e) => {
      const d = this.drag;
      if (!d) return;
      if (d.kind === 'clip') {
        d.dx = e.clientX - d.startX;
        d.dTrack = Math.round((e.clientY - d.startY) / TRACK_H);
        if (Math.abs(d.dx) > 3 || d.dTrack) d.moved = true;
        this.draw();
      } else if (d.kind === 'trim') {
        d.dx = e.clientX - d.startX;
        this.draw();
      } else if (d.kind === 'range') {
        d.endFrame = this.frameOf(local(e, this.canvas).x);
        this.draw();
      } else if (d.kind === 'marker') {
        d.dx = e.clientX - d.startX;
        if (Math.abs(d.dx) > 3) d.moved = true;
        this.draw();
      }
    });

    window.addEventListener('mouseup', () => {
      const d = this.drag;
      this.drag = null;
      if (!d) return;
      if (d.kind === 'clip' && d.moved) {
        const deltaFrames = Math.round((d.dx / this.pxPerSec) * this.sr);
        const ids = store.selection.clipIds.size ? [...store.selection.clipIds] : [d.clipId];
        store.edit((p) => {
          let q = p;
          for (const id of ids) {
            const found = q.tracks.flatMap((t) => t.clips).find((c) => c.id === id);
            if (!found) continue;
            const toTrack = id === d.clipId && d.dTrack ? q.tracks[Math.max(0, Math.min(q.tracks.length - 1, d.trackIndex + d.dTrack))]?.id : undefined;
            q = moveClip(q, id, found.start + deltaFrames, toTrack);
          }
          return q;
        });
      } else if (d.kind === 'trim' && d.dx !== 0) {
        const delta = Math.round((d.dx / this.pxPerSec) * this.sr);
        store.edit((p) => updateClip(p, d.clipId, trimmed(d.orig, d.side, delta)));
      } else if (d.kind === 'range') {
        const a = Math.min(d.startFrame, d.endFrame);
        const b = Math.max(d.startFrame, d.endFrame);
        if ((b - a) / this.sr * this.pxPerSec < 4) {
          store.select({ range: null });
          seek(a);
        } else {
          store.select({ range: [a, b] });
        }
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

function trimmed(orig: Clip, side: 'left' | 'right', delta: number): Pick<Clip, 'start' | 'length' | 'offset'> {
  const minLen = 64;
  if (side === 'right') {
    return { start: orig.start, offset: orig.offset, length: Math.max(minLen, orig.length + delta) };
  }
  // left edge: can't go before the start of the source file
  const d = Math.max(-orig.offset, -orig.start, Math.min(orig.length - minLen, delta));
  return { start: orig.start + d, offset: orig.offset + d, length: orig.length - d };
}

function fadeEnvelope(clip: Clip, rel: number): number {
  return fadeGain(rel, clip.length, clip.fadeIn, clip.fadeOut);
}
