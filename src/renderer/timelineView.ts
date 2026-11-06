// Record & Edit view: track headers, canvas timeline with waveforms, markers, selection and transport following.
import { LevelMeter } from './levelMeter';
import { selectionSpan } from '../core/navigation';
import type { AutomationLane, AutomationPoint, Clip, EnvelopePoint, Marker, PeakLevel, Project, Track } from '../shared/types';
import { DRAMA_FOLDERS, FOLDER_GAIN_MAX, FOLDER_GAIN_MIN, addDramaFolders, addFolder, audibleTracks, removeFolder, setTrackFolder, timelineRows, updateFolder, type TimelineRow } from '../core/folders';
import { askName } from './nameDialog';
import { addAutomationPoint, automationValueAt, formatPan, parsePan, setTrackAutomation, showTrackAutomation } from '../core/automation';
import { showContextMenu } from './contextMenu';
import { dbToGain, formatTick, formatTimestamp } from '../shared/time';
import { rippleMinDelta, rippleMove, rippleSet, type RippleSet } from '../core/rippleMove';
import { fitText, layoutMarkerLabels, type LabelLayout } from '../core/markerLabels';
import { addTrack, moveClip, removeTrack, updateClip, updateMarker, updateTrack } from '../core/project';
import { projectLength } from '../core/project';
import { FADE_SHAPES, fadeCurve, type FadeShape } from '../core/dsp';
import { fadesAt, overlapSpans, trackFades, type EffectiveFades } from '../core/crossfade';
import { jingleMediaFile } from '../core/soundboard';
import { clear, h, toast } from './dom';
import { iconButton, setTip } from './icons';
import { LIBRARY_DRAG_TYPE, insertLibrarySound } from './soundLibraryPanel';
import { regionFromSelection, alignSelectedClip, coughDown, coughUp, dropMarker, importAudioFiles, importDroppedFiles, muteSelection, prepareForEditing, rippleCut, scrub, seek, splitAtPlayhead } from './actions';
import { addMuteRegion, removeMuteRegion, updateMuteRegion } from '../core/muteRegions';
import { ENV_MAX_DB, addPoint, ampToDb, envAmp, envelopeAmpAt, envelopeDbAt, setClipEnvelope, toSource } from '../core/envelope';
import { snap, snapTargets } from '../core/snap';
import { edgeScrollSpeed } from '../core/edgeScroll';
import { normalizeClips } from './loudnessDialog';
import { store } from './store';
import { openClipMenu } from './clipMenu';
import { editableNumber, editableValue, isEditingValue } from './valueEdit';
import { drawFileWaveform, drawLevelsWaveform } from './waveform';

/** Where a clip is drawn: its (possibly dragged or trimmed) place on the timeline. */
interface ClipGeo {
  x: number;
  y: number;
  w: number;
  start: number;
  length: number;
  offset: number;
  trackIndex: number;
}

const TRACK_H = 84;
const OVERVIEW_H = 30;
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
/** The playhead can be grabbed this close to its line (handle on the ruler: a bit wider). */
const PLAYHEAD_GRAB_PX = 4;
const PLAYHEAD_HANDLE_PX = 6;
/** Size of the playhead handle at the top of the ruler. */
const PLAYHEAD_HANDLE_W = 6;
const PLAYHEAD_HANDLE_H = 7;
// Falls back to the key used while the app was called SoundPod.
const SNAP_KEY = 'wavepod.timeline.snap';
/** While a clip is dragged to another track, horizontal movement below this keeps its position (sync). */
const TRACK_MOVE_LOCK_PX = 20;
/** While recording, the view scrolls to keep the cursor at this share of its width from the left. */
const RECORD_FOLLOW_ANCHOR = 0.75;
/** Deepest zoom: one sample this many pixels wide. */
const MAX_PX_PER_SAMPLE = 64;
/** Ruler tick steps in seconds, from a few samples up to an hour. */
const TICK_STEPS = [
  0.00001, 0.00002, 0.00005, 0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800,
  3600,
];
/** Volume-line toggle shown at the top left of a hovered clip (offsets from the clip's top left). */
const VOL_BTN = { x: 4, y: 17, w: 26, h: 13 };
/** The clip's filter button, right of the volume-line toggle. */
const FX_BTN = { x: VOL_BTN.x + VOL_BTN.w + 4, y: VOL_BTN.y, w: 28, h: VOL_BTN.h };
const clipFxCount = (clip: Clip) => clip.fx?.filter((f) => f.enabled).length ?? 0;
/** Colours of the track automation lanes (the clip volume line is green). */
const LANE_COLOR: Record<AutomationLane, string> = { volume: '#ffb74d', pan: '#82b1ff' };
const LANE_NAME: Record<AutomationLane, string> = { volume: 'Volume', pan: 'Pan' };
/** The lane shown on a track's row, if any. */
const shownLane = (t: Track | undefined): AutomationLane | null => t?.automation?.shown ?? null;

type Drag =
  | { kind: 'clip'; clipId: string; ids: Set<string>; startX: number; startY: number; delta: number; dTrack: number; minDTrack: number; maxDTrack: number; moved: boolean; ripple?: RippleSet; clickFrame: number }
  | { kind: 'trim'; clipId: string; side: 'left' | 'right'; startX: number; orig: Clip; delta: number }
  | { kind: 'fade'; clipId: string; side: 'in' | 'out'; startX: number; orig: Clip; moved: boolean }
  | { kind: 'range'; startFrame: number; endFrame: number; startTrack: number | null; endTrack: number | null }
  | { kind: 'rangeEdge'; fixed: number; current: number; tracks: string[] | null; moved: boolean }
  | { kind: 'envPoint'; clipId: string; ti: number; index: number; orig: EnvelopePoint[]; moved: boolean }
  | { kind: 'envLine'; clipId: string; ti: number; indices: number[]; orig: EnvelopePoint[]; startY: number; moved: boolean }
  // track automation (volume or pan lane shown on the track's row)
  | { kind: 'autoPoint'; trackId: string; lane: AutomationLane; ti: number; index: number; orig: AutomationPoint[]; moved: boolean }
  | { kind: 'autoLine'; trackId: string; lane: AutomationLane; ti: number; indices: number[]; orig: AutomationPoint[]; startY: number; moved: boolean }
  | { kind: 'marker'; markerId: string; startX: number; origPos: number; dx: number; moved: boolean }
  | { kind: 'mute'; trackId: string; index: number | null; edge: 'left' | 'right' | 'new'; anchor: number; current: number; moved: boolean }
  | { kind: 'playhead'; startX: number; grabOffset: number; current: number; moved: boolean }
  // Shift+drag: a rubber band across tracks and time that selects every clip it touches
  | { kind: 'marquee'; startX: number; startY: number; a: number; b: number; y0: number; y1: number; clipId: string | null; ids: Set<string>; moved: boolean };

/** Drags that scroll the view when the mouse nears or leaves its left or right edge (Reaper style). */
const AUTOSCROLL_X = new Set<Drag['kind']>(['clip', 'trim', 'fade', 'range', 'rangeEdge', 'marker', 'mute', 'marquee', 'autoPoint']);
/** Drags that also scroll the tracks up or down at the top and bottom edge. */
const AUTOSCROLL_Y = new Set<Drag['kind']>(['clip', 'range', 'marquee']);

export class TimelineView {
  readonly el = h('div', { class: 'view edit-view' });
  private toolbar = h('div', { class: 'toolbar' });
  private rulerCanvas = h('canvas', { class: 'ruler-canvas' });
  private scroll = h('div', { class: 'tracks-scroll' });
  private headers = h('div', { class: 'track-headers' });
  private canvas = h('canvas', { class: 'tracks-canvas' });
  /** Overview strip (navigator): the whole episode, with the visible part framed; click or drag to move there. */
  private overview = h('canvas', { class: 'overview' });
  private trackMeters = new Map<string, LevelMeter>();
  private folderMeters = new Map<string, LevelMeter>();
  private folderBtn: HTMLButtonElement | null = null;
  /** Timeline rows (folders and the tracks shown) for the current project, rebuilt when it changes. */
  private layoutCache: { project: Project; rows: TimelineRow[]; rowOf: Map<string, number>; audible: Set<string> } | null = null;

  /** Seconds at the left edge. */
  viewStart = 0;
  pxPerSec = 40;
  private width = 800;
  private drag: Drag | null = null;
  /** The view when the current drag started, so its movement counts in what the view scrolled since. */
  private dragOrigin: { drag: Drag; viewStart: number; scrollTop: number } | null = null;
  /** Edge autoscroll running during a drag: the last mouse event and the animation frame. */
  private autoScroll: { e: MouseEvent; raf: number; last: number } | null = null;
  /** Applies a mouse move to the current drag (set up in bindEvents; autoscroll replays the last move). */
  private onDragMove: (e: MouseEvent) => void = () => {};
  /** Middle-mouse pan in progress (Reaper style): where it started and the view at that moment. */
  private pan: { startX: number; startY: number; viewStart: number; scrollTop: number } | null = null;
  private lastFollowPos = 0;
  /** Snap dragged edges to clip edges, markers and the playhead. */
  private snapping = readSnapSetting();
  /** Position the current drag snapped to, drawn as a guide line. */
  private snapLine: number | null = null;
  /** Where files dragged over the timeline would land (track null: new tracks below). */
  private dropHint: { frame: number; trackIndex: number | null } | null = null;
  /** Label next to the mouse while dragging files: which track and time they land on. */
  private dropTag = h('div', { class: 'drop-tag' });
  /** Clip under the mouse, whose fade handles are shown. */
  private hoverClipId: string | null = null;
  /** Marker labels as last drawn in the ruler, for hover text. */
  private markerLabels: (LabelLayout & { title: string })[] = [];
  private snapBtn = iconButton('snap', { label: 'Snapping' }, null, 'snap-btn');
  /** Opens the filter stack of a track. */
  onOpenFx: (trackId: string) => void = () => {};
  /** Opens the filter stack of a single clip. */
  onOpenClipFx: (clipId: string) => void = () => {};
  /** Whether the filter panel currently shows this clip. */
  isClipFxOpen: (clipId: string) => boolean = () => false;
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
    this.el.append(this.toolbar, rulerRow, this.scroll, h('div', { class: 'hscroll-row' }, h('div', { class: 'overview-label muted', style: { width: `${HEADER_W}px` } }, 'Overview'), this.overview), this.footer);
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
      (this.folderBtn = btn('folder', { label: 'Track folders', detail: 'Group tracks (Dialogue, SFX, Atmo, Music) with one mute, solo and volume for the group' }, () => this.folderMenu())),
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
      btn(
        'align',
        { label: 'Align to track…', detail: 'Double-ender: line up the selected clip (a guest’s own recording) with what another track recorded during the call' },
        () => void alignSelectedClip(),
      ),
      this.snapBtn,
      h('span', { class: 'sep' }),
      btn('chapter', { label: 'Chapter marker', shortcut: 'M', detail: 'Add a chapter marker at the playhead' }, () => dropMarker('chapter'), 'chapter'),
      btn('editMark', { label: 'Edit marker', shortcut: 'E', detail: 'Add an edit marker at the playhead' }, () => dropMarker('edit'), 'editmark'),
      btn('region', { label: 'Region from selection', detail: 'Make the selected range a region: a part of the episode that can be exported as its own file' }, regionFromSelection),
      h('span', { class: 'sep' }),
      btn('zoomOut', { label: 'Zoom out', shortcut: '-' }, () => this.zoomAtPlayhead(1 / 1.5)),
      btn('zoomIn', { label: 'Zoom in', shortcut: '+' }, () => this.zoomAtPlayhead(1.5)),
      btn('fit', { label: 'Zoom to fit', detail: 'Zoom to fit the whole episode' }, () => this.zoomToFit()),
      btn('zoomSel', { label: 'Zoom to selection', shortcut: 'Shift+Z', detail: 'Zoom to the selected range or clips; again to zoom back' }, () =>
        void this.toggleZoomToSelection(selectionSpan(store.project, store.selection.range, store.selection.clipIds))),
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted hint-keys' }, 'Space play · R record · L repeat · M chapter · S split · Ctrl+X ripple cut · ? all shortcuts'),
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

  private layout(): { rows: TimelineRow[]; rowOf: Map<string, number>; audible: Set<string> } {
    const project = store.project;
    if (!project) return { rows: [], rowOf: new Map(), audible: new Set() };
    if (this.layoutCache?.project !== project) {
      const rows = timelineRows(project);
      const rowOf = new Map<string, number>();
      rows.forEach((r, i) => {
        if (r.kind === 'track') rowOf.set(r.track.id, i);
      });
      this.layoutCache = { project, rows, rowOf, audible: new Set(audibleTracks(project).map((t) => t.id)) };
    }
    return this.layoutCache;
  }

  /** Rows of the timeline, top to bottom: folder rows and the tracks that are not folded away. */
  private get rows(): TimelineRow[] {
    return this.layout().rows;
  }

  /** The track on a row (undefined on folder rows and below the last row). */
  private trackAt(row: number): Track | undefined {
    const r = this.rows[row];
    return r?.kind === 'track' ? r.track : undefined;
  }

  /** The row a track is drawn on, -1 while its folder is collapsed. */
  private rowOfTrack(trackId: string): number {
    return this.layout().rowOf.get(trackId) ?? -1;
  }

  /** The tracks rows a..b cover; a collapsed folder's row covers all its tracks. */
  private tracksInRows(a: number, b: number): Track[] {
    const rows = this.rows;
    const lo = Math.max(0, Math.min(a, b));
    const hi = Math.min(rows.length - 1, Math.max(a, b));
    return rows.slice(lo, hi + 1).flatMap((r) => (r.kind === 'track' ? [r.track] : r.folder.collapsed ? r.members : []));
  }

  /** The row `d` rows away from `row` for a dragged clip; folder rows are stepped over. */
  private shiftRow(row: number, d: number): number {
    const rows = this.rows;
    const r = Math.max(0, Math.min(rows.length - 1, row + d));
    if (rows[r]?.kind === 'track') return r;
    const dir = d >= 0 ? 1 : -1;
    for (let k = r + dir; k >= 0 && k < rows.length; k += dir) if (rows[k].kind === 'track') return k;
    for (let k = r - dir; k >= 0 && k < rows.length; k -= dir) if (rows[k].kind === 'track') return k;
    return row;
  }

  renderHeaders(): void {
    // don't pull a value field away while it is being typed into; it re-renders when it closes
    if (isEditingValue(this.headers)) return;
    clear(this.headers);
    this.trackMeters.clear();
    const status = store.status;
    const nIn = status?.inputChannelCount ?? 0;
    const labels = store.profile?.inputs ?? [];
    const labelOf = (i: number) => labels.find((l) => l.index === i)?.label ?? `In ${i + 1}`;
    const inputOptions: Array<{ value: string; label: string }> = [{ value: '', label: 'No input' }];
    for (let i = 0; i < nIn; i++) inputOptions.push({ value: String(i), label: `${i + 1}: ${labelOf(i)}` });
    for (let i = 0; i + 1 < nIn; i += 2) inputOptions.push({ value: `${i},${i + 1}`, label: `${i + 1}/${i + 2}: ${labelOf(i).replace(/ L$/, '')} (stereo)` });

    this.folderMeters.clear();
    this.rows.forEach((row) => {
      if (row.kind === 'folder') return void this.headers.append(this.folderHeader(row));
      const t = row.track;
      const cur = t.inputChannels.join(',');
      if (cur && !inputOptions.some((o) => o.value === cur)) inputOptions.push({ value: cur, label: `${cur} (unavailable)` });
      const meter = new LevelMeter(`trk:${t.id}`);
      this.trackMeters.set(t.id, meter);
      // a muted folder mutes its tracks; their own M shows that without changing the track's setting
      const byFolder = (key: string) => (key === 'mute' && row.folder?.mute ? ' by-folder' : key === 'solo' && row.folder?.solo ? ' by-folder' : '');
      const toggle = (key: 'armed' | 'mute' | 'solo', label: string, title: string) =>
        h(
          'button',
          {
            class: `toggle ${key}${t[key] ? ' on' : ''}${byFolder(key)}`,
            title: byFolder(key) ? `${title} (the folder "${row.folder!.name}" is ${key === 'mute' ? 'muted' : 'soloed'})` : title,
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
          {
            class: `track-header${row.folder ? ' in-folder' : ''}`,
            style: `height: ${TRACK_H}px; --track-color: ${t.color}${row.folder ? `; --folder-color: ${row.folder.color}` : ''}`,
            oncontextmenu: (e: MouseEvent) => {
              // text fields keep their own copy/paste menu
              if ((e.target as HTMLElement).closest('input:not([type=range]), select')) return;
              e.preventDefault();
              this.trackFolderMenu(t, e.clientX, e.clientY);
            },
          },
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
          h(
            'div',
            { class: 'th-row' },
            t.kind === 'soundboard'
              ? h('span', { class: 'muted th-hint' }, 'Jingles played while recording')
              : h(
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
            ...this.panControls(t),
            this.automationButton(t),
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
            editableNumber(h('span', { class: 'gain-label', title: 'Track gain (click to type a value)' }, `${t.gain > 0 ? '+' : ''}${t.gain.toFixed(1)} dB`), {
              min: -24,
              max: 12,
              unit: 'dB',
              precision: 0.1,
              get: () => t.gain,
              commit: (gain) => store.edit((p) => updateTrack(p, t.id, { gain })),
              onClose: () => this.renderHeaders(),
            }),
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
    if (!this.rows.length) {
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

  /** A folder's header: fold/unfold, name, group mute and solo, group volume and a meter over its tracks. */
  private folderHeader(row: Extract<TimelineRow, { kind: 'folder' }>): HTMLElement {
    const f = row.folder;
    const meter = new LevelMeter(`fld:${f.id}`);
    this.folderMeters.set(f.id, meter);
    const set = (patch: Parameters<typeof updateFolder>[2], undo = true) => (undo ? store.edit : store.patch).call(store, (p: Project) => updateFolder(p, f.id, patch));
    const toggle = (key: 'mute' | 'solo', label: string, title: string) =>
      h('button', { class: `toggle ${key}${f[key] ? ' on' : ''}`, title, onclick: () => set({ [key]: !f[key] }, false) }, label);
    const n = row.members.length;
    return h(
      'div',
      {
        class: `track-header folder-header${f.collapsed ? ' collapsed' : ''}`,
        style: `height: ${TRACK_H}px; --track-color: ${f.color}`,
        oncontextmenu: (e: MouseEvent) => {
          if ((e.target as HTMLElement).closest('input:not([type=range])')) return;
          e.preventDefault();
          this.folderContextMenu(f.id, e.clientX, e.clientY);
        },
      },
      h(
        'div',
        { class: 'th-row' },
        h(
          'button',
          { class: 'toggle fold', title: f.collapsed ? 'Unfold: show the tracks in this folder' : 'Fold: hide the tracks in this folder', onclick: () => set({ collapsed: !f.collapsed }, false) },
          f.collapsed ? '▸' : '▾',
        ),
        h('input', {
          class: 'track-name folder-name',
          value: f.name,
          title: 'Folder name',
          onchange: (e: Event) => set({ name: (e.target as HTMLInputElement).value.trim() || f.name }),
        }),
        toggle('mute', 'M', 'Mute every track in this folder'),
        toggle('solo', 'S', 'Solo this folder: every track in it plays'),
        h(
          'button',
          {
            class: 'toggle remove',
            title: 'Remove the folder (its tracks stay)',
            onclick: () => store.edit((p) => removeFolder(p, f.id)),
          },
          '×',
        ),
      ),
      h(
        'div',
        { class: 'th-row' },
        h('span', { class: 'muted th-hint folder-count' }, n ? `Folder · ${n} track${n === 1 ? '' : 's'}${f.collapsed ? ' (folded)' : ''}` : 'Folder · empty'),
        h(
          'button',
          {
            class: 'fx-btn',
            title: 'Add an empty track to this folder',
            onclick: () => store.edit((p) => addTrack(p, { name: `${f.name} ${n + 1}`, folderId: f.id })),
          },
          '+ Track',
        ),
      ),
      h(
        'div',
        { class: 'th-row' },
        h('span', { class: 'folder-vol-label' }, 'Group'),
        editableNumber(h('span', { class: 'gain-label', title: 'Group volume, added to every track in the folder (click to type a value)' }, `${f.gain > 0 ? '+' : ''}${f.gain.toFixed(1)} dB`), {
          min: FOLDER_GAIN_MIN,
          max: FOLDER_GAIN_MAX,
          unit: 'dB',
          precision: 0.1,
          get: () => f.gain,
          commit: (gain) => set({ gain }),
          onClose: () => this.renderHeaders(),
        }),
        h('input', {
          type: 'range',
          class: 'gain',
          min: String(FOLDER_GAIN_MIN),
          max: String(FOLDER_GAIN_MAX),
          step: '0.5',
          value: String(f.gain),
          title: 'Group volume for every track in the folder (double-click to reset)',
          ondblclick: () => set({ gain: 0 }),
          onchange: (e: Event) => set({ gain: Number((e.target as HTMLInputElement).value) }),
        }),
        meter.el,
      ),
    );
  }

  /** Toolbar menu: new folders. */
  private folderMenu(): void {
    const r = (this.folderBtn ?? this.toolbar).getBoundingClientRect();
    const have = new Set((store.project.folders ?? []).map((f) => f.name.toLowerCase()));
    showContextMenu(
      [
        { label: 'New folder…', run: () => void this.newFolder([]) },
        {
          label: `Audio drama folders (${DRAMA_FOLDERS.join(', ')})`,
          enabled: DRAMA_FOLDERS.some((n) => !have.has(n.toLowerCase())),
          title: 'Adds the folders that are not there yet',
          run: () => store.edit((p) => addDramaFolders(p)),
        },
        { kind: 'separator' },
        { label: 'Fold all folders', enabled: !!store.project.folders?.some((f) => !f.collapsed), run: () => this.foldAll(true) },
        { label: 'Unfold all folders', enabled: !!store.project.folders?.some((f) => f.collapsed), run: () => this.foldAll(false) },
      ],
      r.left,
      r.bottom + 2,
    );
  }

  private foldAll(collapsed: boolean): void {
    store.patch((p) => (p.folders ?? []).reduce((q, f) => updateFolder(q, f.id, { collapsed }), p));
  }

  private async newFolder(trackIds: string[]): Promise<void> {
    const name = await askName({ title: 'New track folder', value: `Folder ${(store.project.folders?.length ?? 0) + 1}`, ok: 'Create' });
    if (name) store.edit((p) => addFolder(p, { name, trackIds }));
  }

  /** Right-click on a track header: which folder the track is in. */
  private trackFolderMenu(t: Track, x: number, y: number): void {
    const folders = store.project.folders ?? [];
    showContextMenu(
      [
        { kind: 'header', label: `Move "${t.name}" to folder` },
        ...folders.map((f) => ({ label: f.name, checked: t.folderId === f.id, run: () => store.edit((p) => setTrackFolder(p, t.id, f.id)) })),
        { label: 'No folder', checked: !t.folderId, run: () => store.edit((p) => setTrackFolder(p, t.id, null)) },
        { kind: 'separator' },
        { label: 'New folder with this track…', run: () => void this.newFolder([t.id]) },
      ],
      x,
      y,
    );
  }

  private folderContextMenu(folderId: string, x: number, y: number): void {
    const f = store.project.folders?.find((q) => q.id === folderId);
    if (!f) return;
    const others = store.project.tracks.filter((t) => t.folderId !== f.id && t.kind !== 'soundboard');
    showContextMenu(
      [
        { label: f.collapsed ? 'Unfold' : 'Fold', run: () => store.patch((p) => updateFolder(p, f.id, { collapsed: !f.collapsed })) },
        { label: 'Add an empty track', run: () => store.edit((p) => addTrack(p, { name: `${f.name} ${folderMembersCount(p, f.id) + 1}`, folderId: f.id })) },
        ...(others.length ? [{ kind: 'header' as const, label: 'Move a track here' }, ...others.slice(0, 24).map((t) => ({ label: t.name, run: () => store.edit((p) => setTrackFolder(p, t.id, f.id)) }))] : []),
        { kind: 'separator' },
        { label: 'Remove folder (keep its tracks)', run: () => store.edit((p) => removeFolder(p, f.id)) },
      ],
      x,
      y,
    );
  }

  /** Pan value (click to type) and slider; while the pan lane has points they follow it instead. */
  private panControls(t: Track): HTMLElement[] {
    const automated = !!t.automation?.pan?.length;
    const label = h(
      'span',
      { class: `pan-label${automated ? ' automated' : ''}`, title: automated ? 'Pan follows the pan automation' : 'Pan (click to type, e.g. L 40, C, R 25)' },
      automated ? 'lane' : formatPan(t.pan),
    );
    if (!automated) {
      editableValue(label, {
        initial: () => formatPan(t.pan),
        parse: parsePan,
        commit: (pan) => store.edit((p) => updateTrack(p, t.id, { pan })),
        onClose: () => this.renderHeaders(),
      });
    }
    const slider = h('input', {
      type: 'range',
      class: 'pan',
      min: '-100',
      max: '100',
      step: '1',
      value: String(Math.round(t.pan * 100)),
      disabled: automated,
      title: automated ? 'Pan follows the pan automation (Auto ▾ › Clear pan automation to set it here)' : 'Pan: left … right (double-click to centre)',
      ondblclick: () => store.edit((p) => updateTrack(p, t.id, { pan: 0 })),
      onchange: (e: Event) => store.edit((p) => updateTrack(p, t.id, { pan: Number((e.target as HTMLInputElement).value) / 100 })),
    });
    return [label, slider];
  }

  /** Picks the automation lane drawn on the track's row, and clears lanes. */
  private automationButton(t: Track): HTMLElement {
    const shown = shownLane(t);
    const has = (lane: AutomationLane) => !!t.automation?.[lane]?.length;
    const used = (['volume', 'pan'] as AutomationLane[]).filter(has);
    const btn = h(
      'button',
      {
        class: `fx-btn auto-btn${used.length ? ' active' : ''}${shown ? ` open lane-${shown}` : ''}`,
        title: `Volume and pan automation${used.length ? ` (${used.map((l) => LANE_NAME[l].toLowerCase()).join(' and ')} automated)` : ''}`,
        onclick: (e: MouseEvent) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const show = (lane: AutomationLane | null) => store.patch((p) => showTrackAutomation(p, t.id, lane));
          showContextMenu(
            [
              { kind: 'header', label: 'Show on the track' },
              { label: 'Clips only', checked: !shown, run: () => show(null) },
              { label: `Volume automation${has('volume') ? ' •' : ''}`, checked: shown === 'volume', run: () => show('volume') },
              { label: `Pan automation${has('pan') ? ' •' : ''}`, checked: shown === 'pan', run: () => show('pan') },
              { kind: 'separator' },
              { label: 'Clear volume automation', enabled: has('volume'), run: () => store.edit((p) => setTrackAutomation(p, t.id, 'volume', [])) },
              { label: 'Clear pan automation', enabled: has('pan'), run: () => store.edit((p) => setTrackAutomation(p, t.id, 'pan', [])) },
            ],
            r.left,
            r.bottom + 2,
          );
        },
      },
      shown ? (shown === 'volume' ? 'Vol' : 'Pan') : 'Auto',
    );
    return btn;
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
    // a folder shows the loudest of its tracks
    for (const f of store.project.folders ?? []) {
      const meter = this.folderMeters.get(f.id);
      if (!meter) continue;
      const members = store.project.tracks.filter((t) => t.folderId === f.id);
      const v = Math.max(0, ...members.map((t) => store.trackMeterHold.get(t.id) ?? 0));
      const p = Math.max(0, ...members.map((t) => store.transport.trackPeaks?.[t.id] ?? 0));
      meter.update(v, p);
    }
  }

  private resize(): void {
    const w = Math.max(100, this.scroll.clientWidth - HEADER_W);
    this.width = w;
    const dpr = window.devicePixelRatio || 1;
    const hTracks = Math.max(this.rows.length, 1) * TRACK_H;
    for (const [c, height] of [
      [this.rulerCanvas, RULER_H + MARKER_H],
      [this.canvas, hTracks],
      [this.overview, OVERVIEW_H],
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
    if (t.state === 'recording') {
      // While recording the timeline scrolls with the cursor: once it reaches the anchor it stays
      // there and the takes grow under it, so the view itself shows the recording is running. It is
      // also brought back when scrolled away (not while the view is being panned by hand). Drags
      // count in what the view scrolled, so they keep working while it moves.
      if (this.pan) return;
      const x = this.xOf(t.position);
      const anchor = this.width * RECORD_FOLLOW_ANCHOR;
      if (x > anchor || x < 0) this.viewStart = Math.max(0, t.position / this.sr - anchor / this.pxPerSec);
      return;
    }
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
    this.drawOverview();
  }

  /** Seconds per overview pixel: the whole episode fits, or the view if it reaches further. */
  private overviewScale(): number {
    const total = Math.max(this.totalSeconds(), this.viewStart + this.width / this.pxPerSec);
    return total / Math.max(1, this.width);
  }

  private drawOverview(): void {
    const ctx = this.ctx(this.overview);
    const w = this.width;
    const spp = this.overviewScale();
    const xs = (frames: number) => frames / this.sr / spp;
    ctx.fillStyle = '#16181e';
    ctx.fillRect(0, 0, w, OVERVIEW_H);
    const tracks = store.project.tracks;
    const laneH = Math.max(2, Math.min(8, (OVERVIEW_H - 6) / Math.max(1, tracks.length)));
    const top = Math.max(3, (OVERVIEW_H - laneH * tracks.length) / 2);
    tracks.forEach((t, i) => {
      for (const c of t.clips) {
        ctx.fillStyle = c.color ?? t.color;
        ctx.globalAlpha = t.mute ? 0.35 : 0.85;
        ctx.fillRect(xs(c.start), top + i * laneH, Math.max(1, xs(c.length)), Math.max(1, laneH - 1));
      }
    });
    ctx.globalAlpha = 1;
    for (const m of store.project.markers) {
      ctx.fillStyle = m.kind === 'chapter' ? '#ffca28' : '#ef5350';
      ctx.fillRect(Math.round(xs(m.position)), 0, 1, OVERVIEW_H);
    }
    // the visible part of the timeline
    const vx = this.viewStart / spp;
    const vw = Math.max(4, this.width / this.pxPerSec / spp);
    ctx.fillStyle = 'rgba(154,184,255,0.14)';
    ctx.fillRect(vx, 0, vw, OVERVIEW_H);
    ctx.strokeStyle = 'rgba(154,184,255,0.85)';
    ctx.strokeRect(Math.round(vx) + 0.5, 0.5, Math.round(vw) - 1, OVERVIEW_H - 1);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(Math.round(xs(store.transport.position)), 0, 1, OVERVIEW_H);
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
    // markers: each label gets the room up to the next marker and is shortened with an ellipsis past that
    const LABEL_FONT = '11px system-ui, sans-serif';
    ctx.font = LABEL_FONT;
    const markerXs = store.project.markers.map((m) => ({ id: m.id, x: Math.round(this.xOf(this.markerPos(m))) + 0.5, title: m.title }));
    const titles = new Map(store.project.markers.map((m) => [m.id, m.title]));
    const measure = (t: string) => ctx.measureText(t).width;
    this.markerLabels = layoutMarkerLabels(markerXs, measure, { offset: 11, gap: 4 }).map((l) => ({ ...l, title: titles.get(l.id) ?? '' }));
    // regions: bands in the marker lane, behind the markers
    ctx.textBaseline = 'middle';
    for (const r of store.project.regions ?? []) {
      const x0 = this.cx(this.xOf(r.start));
      const x1 = this.cx(this.xOf(r.end));
      if (x1 < 0 || x0 > w) continue;
      ctx.fillStyle = 'rgba(149,117,205,0.28)';
      ctx.fillRect(x0, RULER_H + 1, x1 - x0, MARKER_H - 2);
      ctx.fillStyle = '#9575cd';
      ctx.fillRect(Math.round(x0), RULER_H + 1, 2, MARKER_H - 2);
      ctx.fillRect(Math.round(x1) - 2, RULER_H + 1, 2, MARKER_H - 2);
      ctx.fillRect(x0, RULER_H + MARKER_H - 3, x1 - x0, 2);
      ctx.fillStyle = '#d1c4e9';
      ctx.font = '10px system-ui, sans-serif';
      const label = `▭ ${r.title}`;
      const lx = Math.max(0, x0) + 5;
      // keep the title clear of a marker flag and label at the region start, and stop before the next marker
      const atStart = this.markerLabels.find((l) => Math.abs(l.x - 11 - x0) < 6);
      const tx = atStart ? Math.max(lx, atStart.x + atStart.width + 8) : lx;
      const nextMarker = this.markerLabels.find((l) => l.x - 11 > tx);
      const room = Math.min(x1, nextMarker ? nextMarker.x - 11 : Infinity) - tx - 6;
      const text = room > 20 ? fitText(label, room, (t) => ctx.measureText(t).width) : '';
      if (text) ctx.fillText(text, tx, RULER_H + MARKER_H / 2 - 1);
    }
    // markers
    for (const m of store.project.markers) {
      const x = markerXs.find((p) => p.id === m.id)!.x;
      if (x < -200 || x > w + 2) continue;
      ctx.fillStyle = m.kind === 'chapter' ? '#ffca28' : '#ef5350';
      ctx.beginPath();
      ctx.moveTo(x, RULER_H + 2);
      ctx.lineTo(x + 8, RULER_H + 2);
      ctx.lineTo(x + 8, RULER_H + MARKER_H - 4);
      ctx.lineTo(x, RULER_H + MARKER_H - 2);
      ctx.closePath();
      ctx.fill();
    }
    for (const l of this.markerLabels) {
      if (!l.text || l.x > w + 2) continue;
      const selected = store.selection.markerId === l.id;
      ctx.fillStyle = selected ? '#fff' : '#d8dbe2';
      ctx.font = `${selected ? 'bold ' : ''}${LABEL_FONT}`;
      // bold is wider: fit the selected label again in its own room
      const text = selected ? fitText(l.title, l.room, measure) : l.text;
      if (selected) {
        l.text = text;
        l.width = measure(text);
        l.truncated = text !== l.title;
      }
      if (text && l.x + l.width > -2) ctx.fillText(text, l.x, RULER_H + MARKER_H / 2);
    }
    ctx.font = LABEL_FONT;
    this.drawPlayhead(ctx, RULER_H + MARKER_H, true);
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
    return this.tracksInRows(a, b).map((t) => t.id);
  }

  /** Playhead position as shown: where it is being dragged to, otherwise the transport's. */
  private shownPlayhead(): number {
    return this.drag?.kind === 'playhead' ? this.drag.current : store.transport.position;
  }

  private drawPlayhead(ctx: CanvasRenderingContext2D, height: number, handle = false): void {
    const x = Math.round(this.xOf(this.shownPlayhead())) + 0.5;
    if (x < -PLAYHEAD_HANDLE_W || x > this.width + PLAYHEAD_HANDLE_W) return;
    const color = store.transport.state === 'recording' ? '#ff5252' : '#ffffff';
    ctx.strokeStyle = color;
    ctx.lineWidth = this.drag?.kind === 'playhead' ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
    ctx.lineWidth = 1;
    if (handle) {
      // grab handle at the top of the ruler
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x - PLAYHEAD_HANDLE_W, 0);
      ctx.lineTo(x + PLAYHEAD_HANDLE_W, 0);
      ctx.lineTo(x, PLAYHEAD_HANDLE_H);
      ctx.closePath();
      ctx.fill();
    }
  }

  /** Whether x is on the playhead line (not while recording: the engine ignores seeks then). */
  private hitPlayhead(x: number, tolerance: number): boolean {
    if (store.transport.state === 'recording') return false;
    return Math.abs(x - this.xOf(store.transport.position)) <= tolerance;
  }

  /** The handle at the top of the ruler is easier to grab than the line. */
  private playheadTolerance(rulerY: number): number {
    return rulerY < PLAYHEAD_HANDLE_H + 3 ? PLAYHEAD_HANDLE_PX : PLAYHEAD_GRAB_PX;
  }

  private startPlayheadDrag(e: MouseEvent, x: number): void {
    const pos = store.transport.position;
    this.drag = { kind: 'playhead', startX: e.clientX, grabOffset: x - this.xOf(pos), current: pos, moved: false };
    document.body.classList.add('scrubbing');
    this.draw();
  }

  /** Playhead under a mouse at x (keeping the grab offset), snapped like dragged edges. */
  private playheadFrameAt(x: number, d: Extract<Drag, { kind: 'playhead' }>, e: MouseEvent): number {
    const f = Math.max(0, this.frameOf(x - d.grabOffset));
    this.snapLine = null;
    if (!this.snapping || e.altKey) return f;
    // like clip snapping, but the playhead can't snap to itself; selection edges are useful targets too
    const targets = snapTargets(store.project, new Set(), store.selection.range ?? []);
    const res = snap([f], targets, Math.round((SNAP_PX / this.pxPerSec) * this.sr));
    if (!res) return f;
    this.snapLine = res.target;
    return Math.max(0, res.target);
  }

  /** The Shift+drag rubber band. */
  private drawMarquee(ctx: CanvasRenderingContext2D): void {
    const d = this.drag;
    if (d?.kind !== 'marquee' || !d.moved) return;
    const x0 = this.cx(this.xOf(Math.min(d.a, d.b)));
    const x1 = this.cx(this.xOf(Math.max(d.a, d.b)));
    const y0 = Math.min(d.y0, d.y1);
    const y1 = Math.max(d.y0, d.y1);
    ctx.fillStyle = 'rgba(120,160,255,0.14)';
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.strokeStyle = 'rgba(154,184,255,0.9)';
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.round(x1 - x0), Math.round(y1 - y0));
    ctx.setLineDash([]);
  }

  private drawTracks(): void {
    const ctx = this.ctx(this.canvas);
    const w = this.width;
    const rows = this.rows;
    const height = Math.max(rows.length, 1) * TRACK_H;
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
    rows.forEach((row, i) => {
      const y = i * TRACK_H;
      if (row.kind === 'folder') return this.drawFolderRow(ctx, row, y);
      const t = row.track;
      ctx.fillStyle = i % 2 ? '#191b21' : '#1b1d23';
      ctx.fillRect(0, y, w, TRACK_H - 2);
      // faint wash of the track colour so the lane lines up with its tinted header
      ctx.globalAlpha = 0.05;
      ctx.fillStyle = t.color;
      ctx.fillRect(0, y, w, TRACK_H - 2);
      ctx.globalAlpha = 1;
      this.drawRowClips(ctx, i);
      if (recording && t.kind === 'soundboard') this.drawLiveJingles(ctx, y);
      this.drawMuteRegions(ctx, t, y);
      const lane = shownLane(t);
      if (lane) this.drawAutomation(ctx, t, i, lane);
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
      ctx.fillStyle = '#0b0c0f';
      ctx.fillRect(0, y + TRACK_H - 2, w, 2);
    });
    const range = this.liveRange();
    if (range) {
      const ids = this.liveRangeTracks();
      const x0 = this.cx(this.xOf(range[0]));
      const x1 = this.cx(this.xOf(range[1]));
      rows.forEach((r, i) => {
        // a folder row is lit when the selection covers its tracks
        const covered = r.kind === 'track' ? [r.track] : r.members;
        if (!covered.length || (ids && !covered.some((t) => ids.includes(t.id)))) return;
        ctx.fillStyle = 'rgba(120,160,255,0.22)';
        ctx.fillRect(x0, i * TRACK_H, x1 - x0, TRACK_H - 1);
        ctx.fillStyle = 'rgba(154,184,255,0.8)';
        ctx.fillRect(Math.round(x0), i * TRACK_H, 1, TRACK_H - 1);
        ctx.fillRect(Math.round(x1) - 1, i * TRACK_H, 1, TRACK_H - 1);
      });
    }
    this.drawMarquee(ctx);
    // marker lines
    for (const m of store.project.markers) {
      const x = Math.round(this.xOf(this.markerPos(m))) + 0.5;
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
    this.drawDropHint(ctx, height);
  }

  /**
   * A folder's row: a band in the folder colour with each member's clips as a thin strip, so a
   * folded folder still shows where its tracks have material.
   */
  private drawFolderRow(ctx: CanvasRenderingContext2D, row: Extract<TimelineRow, { kind: 'folder' }>, y: number): void {
    const w = this.width;
    const f = row.folder;
    const silent = f.mute || (!f.solo && !row.members.some((t) => this.layout().audible.has(t.id)) && row.members.length > 0);
    ctx.fillStyle = '#14161b';
    ctx.fillRect(0, y, w, TRACK_H - 2);
    ctx.globalAlpha = 0.1;
    ctx.fillStyle = f.color;
    ctx.fillRect(0, y, w, TRACK_H - 2);
    ctx.globalAlpha = 1;
    ctx.fillStyle = f.color;
    ctx.fillRect(0, y, w, 2);
    const n = row.members.length;
    if (n) {
      const top = y + 8;
      const avail = TRACK_H - 18;
      const laneH = Math.max(2, Math.min(12, avail / n - 1));
      const used = n * (laneH + 1);
      const y0 = top + Math.max(0, (avail - used) / 2);
      ctx.globalAlpha = silent ? 0.3 : f.collapsed ? 0.85 : 0.5;
      row.members.forEach((t, k) => {
        const ly = y0 + k * (laneH + 1);
        if (ly + laneH > y + TRACK_H - 6) return;
        ctx.fillStyle = t.color;
        for (const c of t.clips) {
          const x0 = this.cx(this.xOf(c.start));
          const x1 = this.cx(this.xOf(c.start + c.length));
          if (x1 < 0 || x0 > w) continue;
          ctx.fillRect(x0, ly, Math.max(1, x1 - x0), laneH);
        }
      });
      ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = '#6b7080';
      ctx.font = '11px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText('Empty folder: right-click a track header › Move to folder', 10, y + TRACK_H / 2);
    }
    ctx.fillStyle = '#0b0c0f';
    ctx.fillRect(0, y + TRACK_H - 2, w, 2);
  }

  /** A marker's position, following a marker drag or a ripple move across all tracks. */
  private markerPos(m: Marker): number {
    const d = this.drag;
    if (d?.kind === 'marker' && d.markerId === m.id) return d.origPos + Math.round((d.dx / this.pxPerSec) * this.sr);
    if (d?.kind === 'clip' && d.moved && d.ripple?.markerIds.has(m.id)) return m.position + d.delta;
    return m.position;
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

  // ------------------------------------------------------------ track automation

  /** Height of a lane value: the fader scale for volume, left at the top and right at the bottom for pan. */
  private yOfValue(lane: AutomationLane, v: number, ti: number): number {
    if (lane === 'volume') return this.yOfDb(v, ti);
    return this.envTop(ti) + ((v + 1) / 2) * (this.envBottom(ti) - this.envTop(ti));
  }

  private valueOfY(lane: AutomationLane, y: number, ti: number): number {
    if (lane === 'volume') return this.dbOfY(y, ti);
    const frac = Math.max(0, Math.min(1, (y - this.envTop(ti)) / (this.envBottom(ti) - this.envTop(ti))));
    const v = Math.round((frac * 2 - 1) * 100) / 100;
    // centre is sticky, so a voice can be put back in the middle exactly
    return Math.abs(v) <= 0.03 ? 0 : v;
  }

  /** Value of a lane without points: unity for volume, the track's fixed pan. */
  private laneFallback(t: Track, lane: AutomationLane): number {
    return lane === 'volume' ? 0 : t.pan;
  }

  private formatLaneValue(lane: AutomationLane, v: number): string {
    return lane === 'volume' ? formatDb(v) : formatPan(v);
  }

  /** The lane shown on a track's row: the line across the whole timeline, its points and a scale. */
  private drawAutomation(ctx: CanvasRenderingContext2D, t: Track, ti: number, lane: AutomationLane): void {
    const points = t.automation?.[lane] ?? [];
    const fallback = this.laneFallback(t, lane);
    const w = this.width;
    const top = this.envTop(ti);
    const bottom = this.envBottom(ti);
    const color = LANE_COLOR[lane];
    ctx.save();
    // dim the clips a little so the line reads on top of the waveforms
    ctx.fillStyle = 'rgba(14,15,19,0.38)';
    ctx.fillRect(0, ti * TRACK_H, w, TRACK_H - 2);
    // guide: centre for pan, 0 dB for volume
    const guide = lane === 'pan' ? this.yOfValue('pan', 0, ti) : this.yOfDb(0, ti);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(0, Math.round(guide) + 0.5);
    ctx.lineTo(w, Math.round(guide) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
    // the line: one value per pixel (volume curves on the fader scale), plus the exact corners at the points
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let k = 0;
    for (let x = 0; x <= w; x++) {
      for (; k < points.length && this.xOf(points[k].pos) <= x; k++) {
        const px = this.xOf(points[k].pos);
        if (px >= 0) ctx.lineTo(px, this.yOfValue(lane, points[k].value, ti));
      }
      const y = this.yOfValue(lane, automationValueAt(points, this.frameOf(x), fallback), ti);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.lineWidth = 1;
    const d = this.drag;
    const active = (d?.kind === 'autoPoint' || d?.kind === 'autoLine') && d.trackId === t.id && d.lane === lane && d.moved ? d : null;
    ctx.font = '10px system-ui, sans-serif';
    for (let i = 0; i < points.length; i++) {
      const x = this.xOf(points[i].pos);
      if (x < -5 || x > w + 5) continue;
      const y = this.yOfValue(lane, points[i].value, ti);
      ctx.fillStyle = color;
      ctx.strokeStyle = '#0f1014';
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      const label = active && (active.kind === 'autoPoint' ? active.index === i : active.indices[0] === i);
      if (label) {
        ctx.fillStyle = '#fff3e0';
        ctx.textBaseline = 'bottom';
        ctx.fillText(this.formatLaneValue(lane, points[i].value), x + 6, y - 2);
      }
    }
    // lane name at the right edge (clip names sit at the left), scale at the left edge
    ctx.fillStyle = color;
    ctx.textBaseline = 'top';
    const name = `${LANE_NAME[lane]} automation`;
    ctx.fillText(name, w - ctx.measureText(name).width - 6, ti * TRACK_H + 3);
    if (lane === 'pan') {
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.fillText('L', 4, top - 1);
      ctx.textBaseline = 'bottom';
      ctx.fillText('R', 4, bottom + 1);
    }
    ctx.restore();
  }

  /** Point or line of a shown automation lane under the mouse. */
  private hitAutomation(x: number, y: number): { track: Track; ti: number; lane: AutomationLane; point: number | null; frame: number } | null {
    const area = this.inAutomationArea(x, y, ENV_HIT_PX);
    if (!area) return null;
    const { track, ti, lane } = area;
    const points = track.automation?.[lane] ?? [];
    let best: number | null = null;
    let bestD = Infinity;
    for (let i = 0; i < points.length; i++) {
      const dx = Math.abs(x - this.xOf(points[i].pos));
      const dy = Math.abs(y - this.yOfValue(lane, points[i].value, ti));
      if (dx <= ENV_HIT_PX && dy <= ENV_HIT_PX && dx + dy < bestD) {
        best = i;
        bestD = dx + dy;
      }
    }
    const frame = this.frameOf(x);
    if (best !== null) return { ...area, point: best, frame };
    const lineY = this.yOfValue(lane, automationValueAt(points, frame, this.laneFallback(track, lane)), ti);
    if (Math.abs(y - lineY) <= ENV_HIT_PX - 1) return { ...area, point: null, frame };
    return null;
  }

  /** The track whose shown automation lane contains (x, y). */
  private inAutomationArea(x: number, y: number, slack = 0): { track: Track; ti: number; lane: AutomationLane } | null {
    if (x < 0 || x > this.width) return null;
    const ti = Math.floor(y / TRACK_H);
    const track = this.trackAt(ti);
    const lane = shownLane(track);
    if (!track || !lane) return null;
    if (y < Math.max(ti * TRACK_H + FADE_ZONE_PX + 4, this.envTop(ti) - slack) || y > this.envBottom(ti) + slack) return null;
    return { track, ti, lane };
  }

  /** The clip whose visible volume line area contains (x, y). */
  private inEnvelopeArea(x: number, y: number, slack = 0): { clip: Clip; ti: number } | null {
    const ti = Math.floor(y / TRACK_H);
    const track = this.trackAt(ti);
    if (!track || shownLane(track)) return null;
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
    const track = this.trackAt(ti);
    if (!track || shownLane(track)) return null;
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

  /** The filter button at the top left of a clip, next to the volume-line toggle. */
  private hitFxButton(x: number, y: number): Clip | null {
    const ti = Math.floor(y / TRACK_H);
    const track = this.trackAt(ti);
    if (!track) return null;
    const top = ti * TRACK_H + 4;
    for (let k = track.clips.length - 1; k >= 0; k--) {
      const clip = track.clips[k];
      const x0 = this.xOf(clip.start);
      const w = (clip.length / this.sr) * this.pxPerSec;
      if (w < FX_BTN.x + FX_BTN.w + 8) continue;
      if (x >= x0 + FX_BTN.x && x <= x0 + FX_BTN.x + FX_BTN.w && y >= top + FX_BTN.y && y <= top + FX_BTN.y + FX_BTN.h) return clip;
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
    const track = this.trackAt(ti);
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

  private clipGeometry(trackIndex: number, clip: Clip): ClipGeo {
    let start = clip.start;
    let length = clip.length;
    let offset = clip.offset;
    let ti = trackIndex;
    const d = this.drag;
    if (d?.kind === 'clip' && d.moved && d.ids.has(clip.id)) {
      start = Math.max(0, clip.start + d.delta);
      ti = this.shiftRow(trackIndex, d.dTrack);
    } else if (d?.kind === 'trim' && d.clipId === clip.id) {
      ({ start, length, offset } = trimmed(d.orig, d.side, d.delta));
    }
    return { x: this.xOf(start), y: ti * TRACK_H + 4, w: (length / this.sr) * this.pxPerSec, start, length, offset, trackIndex: ti };
  }

  /**
   * The clips drawn in row `i`, at their (possibly dragged or trimmed) geometry, with clips being
   * dragged last so they sit on top. `track` is the row's track as it would be after the drop, so
   * crossfades over overlaps show while dragging.
   */
  private rowClips(i: number): { track: Track; items: Array<{ clip: Clip; g: ClipGeo }> } {
    const base = this.trackAt(i)!;
    const d = this.drag;
    if (!((d?.kind === 'clip' && d.moved) || d?.kind === 'trim')) {
      return { track: base, items: base.clips.map((clip) => ({ clip, g: this.clipGeometry(i, clip) })) };
    }
    const still: Array<{ clip: Clip; g: ClipGeo }> = [];
    const moving: Array<{ clip: Clip; g: ClipGeo }> = [];
    this.rows.forEach((r, ti) => {
      if (r.kind !== 'track') return;
      for (const clip of r.track.clips) {
        const g = this.clipGeometry(ti, clip);
        if (g.trackIndex === i) (this.isDragged(clip.id) ? moving : still).push({ clip, g });
      }
    });
    const items = [...still, ...moving];
    const view: Track = { ...base, clips: items.map(({ clip, g }) => ({ ...clip, start: g.start, length: g.length, offset: g.offset })) };
    return { track: view, items };
  }

  /**
   * Draws one track row's clips. Where clips overlap, the overlap is drawn again with both clips
   * see-through, their waveforms over each other and the crossfade curves crossing (like Reaper).
   */
  private drawRowClips(ctx: CanvasRenderingContext2D, i: number): void {
    const { track, items } = this.rowClips(i);
    const vis = items.filter(({ g }) => g.x <= this.width && g.x + g.w >= 0);
    if (!vis.length) return;
    for (const it of vis) {
      this.drawClipBody(ctx, track, it.clip, it.g, 1);
      this.drawClipWave(ctx, track, it.clip, it.g, 1);
      this.drawClipFades(ctx, track, it.clip, it.g, true);
    }
    const hgt = TRACK_H - 9;
    const y = i * TRACK_H + 4;
    for (const span of overlapSpans(vis.map(({ g }) => g))) {
      const sx0 = this.cx(this.xOf(span.from));
      const sx1 = this.cx(this.xOf(span.to));
      if (sx1 - sx0 < 0.5) continue;
      const lim: [number, number] = [sx0, sx1];
      ctx.save();
      ctx.beginPath();
      ctx.rect(sx0, y, sx1 - sx0, hgt);
      ctx.clip();
      ctx.fillStyle = i % 2 ? '#191b21' : '#1b1d23';
      ctx.fillRect(sx0, y, sx1 - sx0, hgt);
      const over = span.clips.map((k) => vis[k]);
      for (const it of over) this.drawClipBody(ctx, track, it.clip, it.g, 0.55);
      for (const it of over) this.drawClipWave(ctx, track, it.clip, it.g, 0.7, lim);
      for (const it of over) this.drawClipFades(ctx, track, it.clip, it.g, false);
      ctx.restore();
    }
    for (const it of vis) this.drawClipChrome(ctx, track, it.clip, it.g);
  }

  private clipMuted(track: Track): boolean {
    // muted or soloed away, by the track itself or by its folder
    return !this.layout().audible.has(track.id);
  }

  private clipSelected(clip: Clip): boolean {
    const d = this.drag;
    return d?.kind === 'marquee' && d.moved ? d.ids.has(clip.id) : store.selection.clipIds.has(clip.id);
  }

  /** The clip's background, colour tint and top bar, at `alpha` (see-through in overlaps). */
  private drawClipBody(ctx: CanvasRenderingContext2D, track: Track, clip: Clip, g: ClipGeo, alpha: number): void {
    const hgt = TRACK_H - 9;
    const a = (this.clipMuted(track) ? 0.4 : 1) * alpha;
    // visible part of the clip: at deep zoom a clip can be millions of pixels wide
    const vx0 = this.cx(g.x);
    const vx1 = this.cx(g.x + g.w);
    ctx.globalAlpha = a;
    ctx.fillStyle = this.clipSelected(clip) ? '#2f3b52' : '#262b36';
    ctx.fillRect(vx0, g.y, vx1 - vx0, hgt);
    if (clip.color) {
      // a coloured clip gets a tinted body and its colour as the top bar
      ctx.globalAlpha = a * 0.22;
      ctx.fillStyle = clip.color;
      ctx.fillRect(vx0, g.y, vx1 - vx0, hgt);
      ctx.globalAlpha = a;
    }
    ctx.fillStyle = clip.color ?? track.color;
    ctx.fillRect(vx0, g.y, vx1 - vx0, clip.color ? 5 : 3);
    ctx.globalAlpha = 1;
  }

  /** The clip's waveform as it sounds; `lim` narrows the drawn columns (an overlap span). */
  private drawClipWave(ctx: CanvasRenderingContext2D, track: Track, clip: Clip, g: ClipGeo, alpha: number, lim?: [number, number]): void {
    const hgt = TRACK_H - 9;
    ctx.globalAlpha = (this.clipMuted(track) ? 0.4 : 1) * alpha;
    const peaks = store.requestPeaks(clip.file);
    if (peaks && peaks.levels.length) {
      // the waveform shows the clip as it sounds: clip gain (normalisation), fades (including
      // crossfades) and volume line applied
      const env = clip.envelope?.length ? clip.envelope : undefined;
      const fx = fadesOf(track, clip);
      const fades = fx.fadeIn > 0 || fx.fadeOut > 0;
      const cg = clip.gain ? dbToGain(clip.gain) : 1;
      drawFileWaveform(ctx, store.waves, clip.file, peaks, {
        x0: Math.max(lim ? Math.floor(lim[0]) : 0, Math.floor(g.x)),
        x1: Math.min(lim ? Math.ceil(lim[1]) : this.width, Math.ceil(g.x + g.w)),
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
          env || fades || cg !== 1
            ? (src) => cg * (fades ? fadesAt(fx, g.length, src - g.offset) : 1) * (env ? envelopeAmpAt(env, src) : 1)
            : undefined,
      });
    } else if (!peaks) {
      ctx.fillStyle = '#3a404d';
      const vx0 = this.cx(g.x);
      ctx.fillRect(vx0, g.y + hgt / 2, this.cx(g.x + g.w) - vx0, 1);
    }
    ctx.globalAlpha = 1;
  }

  /** Fade curves; with `shade` the faded-out part above them is darkened too. */
  private drawClipFades(ctx: CanvasRenderingContext2D, track: Track, clip: Clip, g: ClipGeo, shade: boolean): void {
    const hgt = TRACK_H - 9;
    ctx.globalAlpha = this.clipMuted(track) ? 0.4 : 1;
    const eff = fadesOf(track, clip);
    const efi = (eff.fadeIn / this.sr) * this.pxPerSec;
    const efo = (eff.fadeOut / this.sr) * this.pxPerSec;
    ctx.fillStyle = 'rgba(8,9,12,0.45)';
    // crossfades over an overlap are drawn in the accent colour
    ctx.strokeStyle = eff.autoIn ? 'rgba(255,202,40,0.9)' : 'rgba(255,255,255,0.7)';
    if (efi > 0) this.drawFade(ctx, g.x, g.x + efi, g.y + 3, g.y + hgt, 'in', eff.inShape, shade);
    ctx.strokeStyle = eff.autoOut ? 'rgba(255,202,40,0.9)' : 'rgba(255,255,255,0.7)';
    if (efo > 0) this.drawFade(ctx, g.x + g.w - efo, g.x + g.w, g.y + 3, g.y + hgt, 'out', eff.outShape, shade);
    ctx.globalAlpha = 1;
  }

  /** Everything drawn over the clip: fade handles, volume line, outline and labels. */
  private drawClipChrome(ctx: CanvasRenderingContext2D, track: Track, clip: Clip, g: ClipGeo): void {
    const hgt = TRACK_H - 9;
    const selected = this.clipSelected(clip);
    ctx.globalAlpha = this.clipMuted(track) ? 0.4 : 1;
    const vx0 = this.cx(g.x);
    const vx1 = this.cx(g.x + g.w);
    const fi = (clip.fadeIn / this.sr) * this.pxPerSec;
    const fo = (clip.fadeOut / this.sr) * this.pxPerSec;
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
    // a track automation lane on the row takes the place of the clip volume lines
    const laneShown = !!shownLane(this.trackAt(g.trackIndex));
    if (clip.showEnvelope && !laneShown) this.drawClipEnvelope(ctx, clip, g);
    // volume-line toggle, shown while hovering (and while the line is visible)
    if (!laneShown && (this.hoverClipId === clip.id || clip.showEnvelope) && g.w >= VOL_BTN.x + VOL_BTN.w + 8 && !this.drag) {
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
    // filter button, shown while hovering (and while the clip has filters or its panel is open)
    const fxCount = clipFxCount(clip);
    const fxOpen = this.isClipFxOpen(clip.id);
    if ((this.hoverClipId === clip.id || fxCount > 0 || fxOpen) && g.w >= FX_BTN.x + FX_BTN.w + 8 && !this.drag) {
      const bx = g.x + FX_BTN.x;
      const by = g.y + FX_BTN.y;
      const on = fxCount > 0;
      ctx.fillStyle = fxOpen ? 'rgba(129,199,132,0.4)' : on ? 'rgba(129,199,132,0.22)' : 'rgba(15,16,20,0.45)';
      ctx.fillRect(bx, by, FX_BTN.w, FX_BTN.h);
      ctx.strokeStyle = on || fxOpen ? 'rgba(129,199,132,0.85)' : 'rgba(255,255,255,0.35)';
      ctx.strokeRect(bx + 0.5, by + 0.5, FX_BTN.w - 1, FX_BTN.h - 1);
      ctx.fillStyle = on ? '#c8e6c9' : 'rgba(255,255,255,0.75)';
      ctx.font = '9px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      const label = on ? `FX ${fxCount}` : 'FX';
      ctx.fillText(label, bx + (FX_BTN.w - ctx.measureText(label).width) / 2, by + FX_BTN.h / 2 + 0.5);
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
      if (clip.note) {
        ctx.font = 'italic 11px system-ui, sans-serif';
        ctx.textBaseline = 'bottom';
        const text = `✎ ${clip.note.split('\n')[0]}`;
        const tx = Math.max(g.x, 0) + 5;
        const tw = Math.min(ctx.measureText(text).width, Math.max(10, vx1 - tx - 8));
        ctx.fillStyle = 'rgba(15,16,20,0.7)';
        ctx.fillRect(tx - 3, g.y + hgt - 19, tw + 6, 16);
        ctx.fillStyle = '#fff3c4';
        ctx.fillText(text, tx, g.y + hgt - 4, Math.max(10, vx1 - tx - 8));
      }
    }
    ctx.globalAlpha = 1;
  }

  /**
   * A fade's gain line from (xa, ya) to (xb, yb), with the part above it shaded, cut to the
   * visible columns so it stays exact however far the view is zoomed in.
   */
  private drawFade(ctx: CanvasRenderingContext2D, xa: number, xb: number, top: number, bottom: number, dir: 'in' | 'out', shape: FadeShape, shade = true): void {
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
    if (shade) {
      ctx.beginPath();
      ctx.moveTo(l, top);
      ctx.lineTo(r, top);
      for (let k = pts.length - 1; k >= 0; k--) ctx.lineTo(pts[k][0], pts[k][1]);
      ctx.closePath();
      ctx.fill();
    }
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
    const track = this.trackAt(ti);
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
    if (trackIndex !== null && ids && !ids.includes(this.trackAt(trackIndex)?.id ?? '')) return null;
    const d0 = Math.abs(x - this.xOf(r[0]));
    const d1 = Math.abs(x - this.xOf(r[1]));
    if (Math.min(d0, d1) > RANGE_EDGE_PX) return null;
    return d0 <= d1 ? { fixed: r[1], edge: r[0] } : { fixed: r[0], edge: r[1] };
  }

  /**
   * Where a drag-and-drop lands: the track under the mouse (null below the tracks, for new tracks)
   * and the time under the mouse, snapped to clip edges, markers and the playhead unless Alt is held.
   * Over the track headers the clip starts at the left edge of the view.
   */
  private dropTarget(e: DragEvent): { at: number; trackId: string | null; trackIndex: number | null; folderId?: string } {
    const r = this.canvas.getBoundingClientRect();
    const ti = Math.floor((e.clientY - r.top) / TRACK_H);
    const track = ti >= 0 ? this.trackAt(ti) : undefined;
    const x = e.clientX - r.left;
    const at = x <= 0 ? this.frameOf(0) : this.snappedFrame(x, e);
    // on a folder's row: a new track in that folder
    const row = ti >= 0 ? this.rows[ti] : undefined;
    if (row?.kind === 'folder') return { at, trackId: null, trackIndex: ti, folderId: row.folder.id };
    return { at, trackId: track?.id ?? null, trackIndex: track ? ti : null };
  }

  private showDropHint(t: { at: number; trackIndex: number | null; folderId?: string }, count: number, e: DragEvent): void {
    const prev = this.dropHint;
    this.dropHint = { frame: t.at, trackIndex: t.trackIndex };
    if (!prev || prev.frame !== t.at || prev.trackIndex !== t.trackIndex) this.draw();
    const track = t.trackIndex === null ? null : this.trackAt(t.trackIndex);
    const what = count > 1 ? `${count} files` : 'Clip';
    const folder = t.folderId ? store.project.folders?.find((f) => f.id === t.folderId) : undefined;
    const where = track ? `on ${track.name}` : `${count > 1 ? 'on new tracks' : 'on a new track'}${folder ? ` in ${folder.name}` : ''}`;
    this.dropTag.textContent = `${what} ${where} at ${formatTimestamp(t.at / this.sr, false)}`;
    this.dropTag.style.left = `${e.clientX + 14}px`;
    this.dropTag.style.top = `${e.clientY + 16}px`;
    if (!this.dropTag.isConnected) document.body.append(this.dropTag);
  }

  private clearDropHint(): void {
    this.scroll.classList.remove('drop-target');
    this.dropTag.remove();
    if (!this.dropHint) return;
    this.dropHint = null;
    this.snapLine = null;
    this.draw();
  }

  /** The drop position while files are dragged over the tracks: a line, and the target track lit up. */
  private drawDropHint(ctx: CanvasRenderingContext2D, height: number): void {
    const d = this.dropHint;
    if (!d) return;
    if (d.trackIndex !== null) {
      ctx.fillStyle = 'rgba(120,160,255,0.16)';
      ctx.fillRect(0, d.trackIndex * TRACK_H, this.width, TRACK_H - 2);
    }
    const x = Math.round(this.xOf(d.frame)) + 0.5;
    ctx.strokeStyle = this.snapLine === d.frame ? '#ffd54f' : '#9ab8ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, d.trackIndex === null ? 0 : d.trackIndex * TRACK_H);
    ctx.lineTo(x, d.trackIndex === null ? height : (d.trackIndex + 1) * TRACK_H - 2);
    ctx.stroke();
    ctx.lineWidth = 1;
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

  /** The view at the start of drag `d`. */
  private originOf(d: Drag) {
    if (this.dragOrigin?.drag !== d) this.dragOrigin = { drag: d, viewStart: this.viewStart, scrollTop: this.scroll.scrollTop };
    return this.dragOrigin;
  }

  /** Horizontal mouse movement of drag `d` since `startX`, plus what the view scrolled meanwhile, in pixels. */
  private dragDx(d: Drag, e: MouseEvent, startX: number): number {
    return e.clientX - startX + (this.viewStart - this.originOf(d).viewStart) * this.pxPerSec;
  }

  /** Vertical mouse movement of drag `d` since `startY`, plus what the tracks scrolled meanwhile, in pixels. */
  private dragDy(d: Drag, e: MouseEvent, startY: number): number {
    return e.clientY - startY + (this.scroll.scrollTop - this.originOf(d).scrollTop);
  }

  /** Autoscroll speeds (pixels per second) for the current drag with the mouse at `e`. */
  private autoScrollSpeed(e: MouseEvent): { vx: number; vy: number } {
    const d = this.drag;
    if (!d) return { vx: 0, vy: 0 };
    let vx = 0;
    let vy = 0;
    if (AUTOSCROLL_X.has(d.kind)) {
      vx = edgeScrollSpeed(e.clientX - this.canvas.getBoundingClientRect().left, this.width);
      if (vx < 0 && this.viewStart <= 0) vx = 0;
    }
    if (AUTOSCROLL_Y.has(d.kind) && !(d.kind === 'range' && d.startTrack === null)) {
      const r = this.scroll.getBoundingClientRect();
      vy = edgeScrollSpeed(e.clientY - r.top, this.scroll.clientHeight);
      const maxTop = this.scroll.scrollHeight - this.scroll.clientHeight;
      if ((vy < 0 && this.scroll.scrollTop <= 0) || (vy > 0 && this.scroll.scrollTop >= maxTop)) vy = 0;
    }
    return { vx, vy };
  }

  /** Starts, feeds or stops the edge autoscroll after a mouse move during a drag. */
  private updateAutoScroll(e: MouseEvent): void {
    const { vx, vy } = this.autoScrollSpeed(e);
    if (!vx && !vy) return this.stopAutoScroll();
    if (this.autoScroll) {
      this.autoScroll.e = e;
      return;
    }
    const tick = (now: number) => {
      const a = this.autoScroll;
      if (!a) return;
      const s = this.autoScrollSpeed(a.e);
      if (!s.vx && !s.vy) return this.stopAutoScroll();
      const dt = Math.min(0.05, Math.max(0, (now - a.last) / 1000));
      a.last = now;
      if (s.vx) this.viewStart = Math.max(0, this.viewStart + (s.vx * dt) / this.pxPerSec);
      if (s.vy) this.scroll.scrollTop += s.vy * dt;
      // the mouse stays put while the timeline slides under it: replay the move at the new view
      this.onDragMove(a.e);
      a.raf = requestAnimationFrame(tick);
    };
    this.autoScroll = { e, raf: requestAnimationFrame(tick), last: performance.now() };
  }

  private stopAutoScroll(): void {
    if (this.autoScroll) cancelAnimationFrame(this.autoScroll.raf);
    this.autoScroll = null;
  }

  private bindEvents(): void {
    const local = (e: MouseEvent, el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    // overview: click centres the view there, dragging the frame scrolls
    this.overview.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const spp = this.overviewScale();
      const visible = this.width / this.pxPerSec;
      const vx = this.viewStart / spp;
      const x0 = local(e, this.overview).x;
      // grabbing the frame keeps the grab point; clicking elsewhere centres the view first
      const grab = x0 >= vx && x0 <= vx + visible / spp ? x0 * spp - this.viewStart : visible / 2;
      const moveTo = (x: number) => {
        this.viewStart = Math.max(0, Math.min(this.totalSeconds(), x * spp - grab));
        this.draw();
      };
      moveTo(x0);
      const onMove = (ev: MouseEvent) => moveTo(local(ev, this.overview).x);
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
    this.overview.addEventListener('wheel', (e) => onWheel(e, this.overview), { passive: false });

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
    // drag-and-drop audio files (from the file manager or the sound library): onto a track to add
    // them there at the drop position, below the tracks for new tracks
    const dragTypes = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []);
    const hasFiles = (e: DragEvent) => dragTypes(e).includes('Files') || dragTypes(e).includes(LIBRARY_DRAG_TYPE);
    this.scroll.addEventListener('dragover', (e) => {
      if (!hasFiles(e) || !store.project) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'copy';
      this.scroll.classList.add('drop-target');
      const hint = this.dropTarget(e);
      const count = dragTypes(e).includes(LIBRARY_DRAG_TYPE) ? 1 : Array.from(e.dataTransfer!.items).filter((i) => i.kind === 'file').length;
      this.showDropHint(hint, count, e);
    });
    this.scroll.addEventListener('dragleave', (e) => {
      if (e.relatedTarget instanceof Node && this.scroll.contains(e.relatedTarget)) return;
      this.clearDropHint();
    });
    this.scroll.addEventListener('drop', (e) => {
      this.clearDropHint();
      if (!hasFiles(e) || !store.project) return;
      e.preventDefault();
      const { at, trackId, folderId } = this.dropTarget(e);
      // a sound dragged from the sound library
      const sound = e.dataTransfer!.getData(LIBRARY_DRAG_TYPE);
      if (sound) return void insertLibrarySound(sound, { at, trackId, folderId });
      const files = Array.from(e.dataTransfer!.files);
      if (!files.length) return;
      void importDroppedFiles(files, at, trackId, folderId);
    });
    // a file dropped anywhere else must not replace the app with the file (Chromium opens it)
    window.addEventListener('dragover', (e) => {
      if (e.defaultPrevented || !dragTypes(e).includes('Files')) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'none';
    });
    window.addEventListener('drop', (e) => {
      if (dragTypes(e).includes('Files')) e.preventDefault();
    });
    window.addEventListener('dragend', () => this.clearDropHint());

    this.rulerCanvas.addEventListener('wheel', (e) => onWheel(e, this.rulerCanvas), { passive: false });

    // Middle mouse button drag pans the view, horizontally and vertically, like in Reaper.
    const startPan = (e: MouseEvent) => {
      if (e.button !== 1) return;
      e.preventDefault(); // no autoscroll cursor or middle-click paste
      e.stopImmediatePropagation();
      if (this.drag?.kind === 'playhead' && this.drag.moved) scrub(null);
      this.drag = null;
      this.stopAutoScroll();
      this.snapLine = null;
      document.body.classList.remove('scrubbing');
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
      // grab the playhead (its handle or line) to drag it, also while playing
      if (e.button === 0 && this.hitPlayhead(x, this.playheadTolerance(y)) && !(y >= RULER_H && this.hitMarker(x))) {
        this.startPlayheadDrag(e, x);
        return;
      }
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
      const onMarker = y >= RULER_H && this.hitMarker(x);
      const onPlayhead = !onMarker && this.hitPlayhead(x, this.playheadTolerance(y));
      const onEdge = !onMarker && this.hitRangeEdge(x, null);
      this.rulerCanvas.style.cursor = onPlayhead || onEdge ? 'ew-resize' : '';
      const label = y >= RULER_H && !onPlayhead ? this.markerLabelAt(x) : null;
      this.rulerCanvas.title = onPlayhead ? 'Drag to move the playhead' : label ? label.title : '';
    });
    this.rulerCanvas.addEventListener('dblclick', (e) => {
      const { x, y } = local(e, this.rulerCanvas);
      if (y < RULER_H) return;
      const m = this.hitMarker(x);
      if (m) {
        store.select({ markerId: m.id });
        store.setView('chapters');
        return;
      }
      // double-click a region: select its time range
      const f = this.frameOf(x);
      const r = (store.project.regions ?? []).find((g) => f >= g.start && f <= g.end);
      if (r) store.select({ range: [r.start, r.end], rangeTracks: null, clipIds: new Set(), markerId: null });
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
      if (e.shiftKey) {
        this.canvas.style.cursor = 'crosshair';
        this.canvas.title = 'Drag to select every clip in the rectangle, click a clip to add or remove it';
        return;
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
      if (!hit?.edge && this.hitPlayhead(x, PLAYHEAD_GRAB_PX)) {
        this.canvas.style.cursor = 'ew-resize';
        this.canvas.title = 'Drag to move the playhead';
        return;
      }
      if (this.hitFxButton(x, y)) {
        this.canvas.style.cursor = 'pointer';
        this.canvas.title = 'Filters for this clip only (they run after the track\'s filters)';
        return;
      }
      if (this.hitVolButton(x, y)) {
        this.canvas.style.cursor = 'pointer';
        this.canvas.title = 'Show or hide this clip\'s volume line';
        return;
      }
      const auto = this.hitAutomation(x, y);
      if (auto) {
        const what = LANE_NAME[auto.lane];
        this.canvas.style.cursor = auto.point !== null ? 'move' : 'ns-resize';
        this.canvas.title = auto.point !== null ? `${what} point: drag to move, double-click to remove` : `${what} automation: drag up or down, double-click to add a point`;
        return;
      }
      const env = this.hitEnvelope(x, y);
      if (env) {
        this.canvas.style.cursor = env.point !== null ? 'move' : 'ns-resize';
        this.canvas.title = env.point !== null ? 'Volume point: drag to move, double-click to remove' : 'Volume line: drag up or down, double-click to add a point';
        return;
      }
      const autoArea = this.inAutomationArea(x, y);
      this.canvas.title = autoArea ? `Double-click to add a ${LANE_NAME[autoArea.lane].toLowerCase()} point` : this.inEnvelopeArea(x, y) ? 'Double-click to add a volume point' : hit?.clip.note ? `${hit.clip.note}\n\nRight-click for clip options` : hit ? 'Right-click for clip options' : '';
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
      // automation lane: double-click a point to remove it, anywhere else on the row to add one on the line
      const auto = this.hitAutomation(x, y);
      const autoArea = auto ?? this.inAutomationArea(x, y);
      if (autoArea) {
        const { track, lane } = autoArea;
        const pts = track.automation?.[lane] ?? [];
        if (auto && auto.point !== null) {
          const index = auto.point;
          store.edit((p) => setTrackAutomation(p, track.id, lane, pts.filter((_, i) => i !== index)));
        } else {
          const f = this.frameOf(x);
          store.edit((p) => setTrackAutomation(p, track.id, lane, addAutomationPoint(lane, pts, f, automationValueAt(pts, f, this.laneFallback(track, lane))).points));
        }
        return;
      }
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

    this.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const { x, y } = local(e, this.canvas);
      const hit = this.hitClip(x, y);
      if (!hit) return;
      this.drag = null;
      openClipMenu({
        clipId: hit.clip.id,
        at: this.frameOf(x),
        pageX: e.clientX,
        pageY: e.clientY,
        zoomTo: (span) => this.toggleZoomToSelection(span),
        openLoudness: () => this.onOpenLoudness(),
      });
    });

    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button === 2) return; // right-click opens the clip menu
      const { x, y } = local(e, this.canvas);
      this.snapLine = null;
      // 0. Shift+drag draws a rubber band that selects every clip it touches (Shift+click still toggles a clip)
      if (e.shiftKey && !e.ctrlKey && !e.metaKey && e.button === 0) {
        const under = this.hitClip(x, y);
        const f = this.frameOf(x);
        this.drag = { kind: 'marquee', startX: e.clientX, startY: e.clientY, a: f, b: f, y0: y, y1: y, clipId: under?.clip.id ?? null, ids: new Set(), moved: false };
        return;
      }
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
      // 3. the playhead line (clip edges right at the playhead, e.g. after a split, stay trimmable)
      if (!hit?.edge && e.button === 0 && this.hitPlayhead(x, PLAYHEAD_GRAB_PX)) {
        this.startPlayheadDrag(e, x);
        return;
      }
      // 3a. the clip's filter button
      const fxClip = this.hitFxButton(x, y);
      if (fxClip && e.button === 0) {
        this.onOpenClipFx(fxClip.id);
        this.draw();
        return;
      }
      // 3b. the clip's volume-line toggle
      const volClip = this.hitVolButton(x, y);
      if (volClip) {
        store.edit((p) => updateClip(p, volClip.id, { showEnvelope: !volClip.showEnvelope }));
        return;
      }
      // 4. track automation points and segments
      const auto = this.hitAutomation(x, y);
      if (auto && e.button === 0) {
        const { track, lane, ti } = auto;
        const orig = track.automation?.[lane] ?? [];
        const base = { trackId: track.id, lane, ti, moved: false };
        if (auto.point !== null) {
          this.drag = { kind: 'autoPoint', ...base, index: auto.point, orig };
        } else if (!orig.length) {
          // no points yet: the first drag creates one and moves the whole line
          this.drag = { kind: 'autoLine', ...base, startY: e.clientY, indices: [0], orig: [{ pos: auto.frame, value: this.laneFallback(track, lane) }] };
        } else {
          // the two points around the mouse (one at either end of the line)
          let i1 = orig.findIndex((p) => p.pos > auto.frame);
          if (i1 < 0) i1 = orig.length;
          const indices = [i1 - 1, i1].filter((i) => i >= 0 && i < orig.length);
          this.drag = { kind: 'autoLine', ...base, startY: e.clientY, indices, orig };
        }
        this.draw();
        return;
      }
      // 4a. volume line points and segments
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
      if (hit && !hit.edge && (e.ctrlKey || e.metaKey)) {
        // ripple move: Ctrl-drag takes later clips on the track along, Ctrl+Shift-drag everything later
        const ids = store.selection.clipIds.has(hit.clip.id) ? new Set(store.selection.clipIds) : new Set([hit.clip.id]);
        store.select({ clipIds: ids, range: null, rangeTracks: null, markerId: null });
        const ripple = rippleSet(store.project, ids, e.shiftKey ? 'all' : 'track');
        this.drag = { kind: 'clip', clipId: hit.clip.id, ids: ripple.clipIds, startX: e.clientX, startY: e.clientY, delta: 0, dTrack: 0, minDTrack: 0, maxDTrack: 0, moved: false, ripple, clickFrame: this.snappedFrame(x, e) };
      } else if (hit) {
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
          const rows = this.rows.flatMap((r, i) => (r.kind === 'track' && r.track.clips.some((c) => ids.has(c.id)) ? [i] : []));
          this.drag = {
            kind: 'clip',
            clipId: hit.clip.id,
            ids,
            startX: e.clientX,
            startY: e.clientY,
            delta: 0,
            dTrack: 0,
            minDTrack: -Math.min(...rows),
            maxDTrack: this.rows.length - 1 - Math.max(...rows),
            moved: false,
            clickFrame: this.snappedFrame(x, e),
          };
        }
      } else {
        // 6. empty space: select a time range on the tracks dragged across
        const f = this.snappedFrame(x, e);
        store.select({ clipIds: new Set(), markerId: null });
        const row = Math.max(0, Math.min(this.rows.length - 1, ti));
        this.drag = { kind: 'range', startFrame: f, endFrame: f, startTrack: row, endTrack: row };
      }
    });

    // remember the view a drag starts at (after the mousedown handlers above set it up)
    window.addEventListener('mousedown', () => {
      if (this.drag) this.originOf(this.drag);
    });

    this.onDragMove = (e: MouseEvent) => {
      const d = this.drag;
      if (!d) return;
      this.originOf(d);
      const pos = local(e, this.canvas);
      const framesOf = (px: number) => Math.round((px / this.pxPerSec) * this.sr);
      if (d.kind === 'clip') {
        const dx = this.dragDx(d, e, d.startX);
        d.dTrack = Math.max(d.minDTrack, Math.min(d.maxDTrack, Math.round(this.dragDy(d, e, d.startY) / TRACK_H)));
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
        d.delta = Math.max(d.ripple ? rippleMinDelta(store.project, d.ripple) : -minStart, delta);
        this.draw();
      } else if (d.kind === 'trim') {
        let delta = framesOf(this.dragDx(d, e, d.startX));
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
        const raw = framesOf(this.dragDx(d, e, d.startX));
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
        if (d.startTrack !== null) d.endTrack = Math.max(0, Math.min(this.rows.length - 1, Math.floor(pos.y / TRACK_H)));
        this.draw();
      } else if (d.kind === 'rangeEdge') {
        d.current = this.snappedFrame(pos.x, e);
        d.moved = true;
        this.draw();
      } else if (d.kind === 'envPoint') {
        d.moved = true;
        const clip = this.trackAt(d.ti)?.clips.find((c) => c.id === d.clipId);
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
      } else if (d.kind === 'autoPoint') {
        d.moved = true;
        const prev = d.orig[d.index - 1]?.pos ?? 0;
        const next = d.orig[d.index + 1]?.pos ?? Infinity;
        const pts = d.orig.map((p) => ({ ...p }));
        const f = this.snappedFrame(pos.x, e);
        pts[d.index] = { pos: Math.max(prev, Math.min(next, f)), value: this.valueOfY(d.lane, pos.y, d.ti) };
        store.editLive((p) => setTrackAutomation(p, d.trackId, d.lane, pts));
      } else if (d.kind === 'autoLine') {
        d.moved = true;
        const dy = e.clientY - d.startY;
        const pts = d.orig.map((p, i) => (d.indices.includes(i) ? { pos: p.pos, value: this.valueOfY(d.lane, this.yOfValue(d.lane, p.value, d.ti) + dy, d.ti) } : { ...p }));
        store.editLive((p) => setTrackAutomation(p, d.trackId, d.lane, pts));
      } else if (d.kind === 'marker') {
        d.dx = this.dragDx(d, e, d.startX);
        if (Math.abs(d.dx) > 3) d.moved = true;
        this.draw();
      } else if (d.kind === 'mute') {
        d.current = this.frameOf(pos.x);
        d.moved = true;
        this.draw();
      } else if (d.kind === 'marquee') {
        if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 4) return;
        d.moved = true;
        d.b = this.frameOf(pos.x);
        d.y1 = Math.max(0, Math.min(this.rows.length * TRACK_H - 1, pos.y));
        const lo = Math.min(d.a, d.b);
        const hi = Math.max(d.a, d.b);
        d.ids = new Set(
          this.tracksInRows(Math.floor(d.y0 / TRACK_H), Math.floor(d.y1 / TRACK_H)).flatMap((t) => t.clips.filter((c) => c.start <= hi && c.start + c.length >= lo).map((c) => c.id)),
        );
        this.draw();
      } else if (d.kind === 'playhead') {
        if (!d.moved && Math.abs(e.clientX - d.startX) < 2) return;
        d.moved = true;
        d.current = this.playheadFrameAt(pos.x, d, e);
        // tape-style scrub: the engine plays the timeline at the speed and direction of the mouse
        scrub(d.current);
        this.draw();
      }
    };
    window.addEventListener('mousemove', (e) => {
      if (!this.drag) return;
      this.onDragMove(e);
      this.updateAutoScroll(e);
    });

    window.addEventListener('mouseup', () => {
      const d = this.drag;
      this.drag = null;
      this.dragOrigin = null;
      this.stopAutoScroll();
      this.snapLine = null;
      document.body.classList.remove('scrubbing');
      if (!d) return;
      if (d.kind === 'playhead' && d.moved) {
        scrub(null);
        seek(d.current);
      }
      if (d.kind === 'marquee') {
        if (d.moved) {
          store.select({ clipIds: d.ids, range: null, rangeTracks: null, markerId: null, muteRegion: null });
        } else if (d.clipId) {
          // Shift+click on a clip adds it to the selection or takes it out
          const sel = new Set(store.selection.clipIds);
          if (sel.has(d.clipId)) sel.delete(d.clipId);
          else sel.add(d.clipId);
          store.select({ clipIds: sel, range: null, rangeTracks: null, markerId: null });
        } else {
          // Shift+click on empty space: move the playhead, keep the clips selected
          store.select({ range: null, rangeTracks: null });
          seek(d.a);
        }
      }
      if (d.kind === 'clip' && d.moved && d.ripple) {
        const ripple = d.ripple;
        store.edit((p) => rippleMove(p, ripple, d.delta));
      } else if (d.kind === 'clip' && d.moved) {
        // target tracks by row (folder rows are stepped over); clips on folded-away tracks keep their track
        const toTrackOf = new Map<string, string | undefined>();
        for (const t of store.project.tracks) {
          const row = this.rowOfTrack(t.id);
          for (const c of t.clips) if (d.ids.has(c.id)) toTrackOf.set(c.id, d.dTrack && row >= 0 ? this.trackAt(this.shiftRow(row, d.dTrack))?.id : undefined);
        }
        store.edit((p) => {
          let q = p;
          for (const id of d.ids) {
            const found = q.tracks.flatMap((t) => t.clips).find((c) => c.id === id);
            if (!found) continue;
            q = moveClip(q, id, found.start + d.delta, toTrackOf.get(id));
          }
          return q;
        });
      } else if (d.kind === 'clip') {
        // a click on a clip without dragging it also puts the playhead there, as in Reaper
        seek(d.clickFrame);
      } else if (d.kind === 'trim' && d.delta !== 0) {
        store.edit((p) => updateClip(p, d.clipId, trimmed(d.orig, d.side, d.delta)));
      } else if (d.kind === 'fade' || d.kind === 'envPoint' || d.kind === 'envLine' || d.kind === 'autoPoint' || d.kind === 'autoLine') {
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

  /** The marker whose flag or label is under `x` in the marker lane. */
  private markerLabelAt(x: number) {
    const flag = this.hitMarker(x);
    if (flag) return this.markerLabels.find((l) => l.id === flag.id) ?? null;
    return this.markerLabels.find((l) => l.text && x >= l.x && x <= l.x + l.width) ?? null;
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

function folderMembersCount(p: Project, folderId: string): number {
  return p.tracks.filter((t) => t.folderId === folderId).length;
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
