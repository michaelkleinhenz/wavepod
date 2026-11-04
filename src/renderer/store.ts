// Renderer state: the project (with undo), engine status, transport and selection.
import type { ClipboardData } from '../core/clipboard';
import type { WavePodApi } from '../shared/api';
import type { AudioDevice, DeviceProfile, EngineStatus, LivePeaks, Project, TransportUpdate, WaveformPeaks } from '../shared/types';
import { PeakPyramid } from '../core/peaks';
import { WaveCache } from './waveCache';
import { History } from '../core/project';
import { PLAYBACK_SPEEDS } from '../core/timeStretch';

declare global {
  interface Window {
    wavepod: WavePodApi;
  }
}

export const api = (): WavePodApi => window.wavepod;

export type View = 'setup' | 'edit' | 'chapters';

export interface Selection {
  clipIds: Set<string>;
  /** Time range in frames, for ripple delete / export range. */
  range: [number, number] | null;
  /** Tracks the range was dragged across; null/undefined = all tracks (dragged on the ruler). */
  rangeTracks?: string[] | null;
  markerId: string | null;
  /** A selected cough/mute region. */
  muteRegion?: { trackId: string; index: number } | null;
}

type Listener = (what: Set<ChangeKind>) => void;
export type ChangeKind = 'project' | 'transport' | 'status' | 'selection' | 'view' | 'peaks' | 'devices' | 'midi' | 'mcp' | 'osc';

class Store {
  project!: Project;
  dir = '';
  history = new History();
  status: EngineStatus | null = null;
  devices: AudioDevice[] = [];
  profile: DeviceProfile | null = null;
  transport: TransportUpdate = { state: 'stopped', position: 0, inputPeaks: [], outputPeaks: [0, 0], recordedFrames: 0 };
  /** Position where the current recording started. */
  recordStart = 0;
  /** Where the last recording stopped (or the current one is now), for "jump to recording position". */
  recordPosition: number | null = null;
  /** Clips or a range copied with Ctrl+C / cut with Ctrl+X (this session only). */
  clipboard: ClipboardData | null = null;
  /** A running "preview cut": stop at `end`, then return to `origin`. */
  preview: { end: number; origin: number; started?: boolean } | null = null;
  selection: Selection = { clipIds: new Set(), range: null, markerId: null };
  /** Repeat: playback loops the selected time range. Remembered across launches. */
  repeat = readRepeatSetting();
  /** Listening speed (pitch kept, playback only). Remembered on this computer. */
  speed = readSpeedSetting();
  view: View = 'edit';
  /** Waveform data of media files: coarse peak levels, plus fine levels and samples in tiles. */
  waves = new WaveCache(api, () => this.notify('peaks'));
  /** Waveform of the takes being recorded, per track id, at all resolutions. */
  livePeaks = new Map<string, PeakPyramid>();
  /** Cough buttons currently held: track id -> timeline frame where the mute starts. */
  coughs = new Map<string, number>();
  /** Decayed meter values per input channel for display. */
  meterHold: number[] = [];
  /** Decayed playback level per track id, for the meters of unarmed tracks. */
  trackMeterHold = new Map<string, number>();

  private listeners = new Set<Listener>();
  private pending = new Set<ChangeKind>();
  private scheduled = false;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify(kind: ChangeKind): void {
    this.pending.add(kind);
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      const kinds = new Set(this.pending);
      this.pending.clear();
      for (const l of this.listeners) l(kinds);
    });
  }

  /** Replaces the project without recording undo history (loading, engine updates). */
  setProject(project: Project, dir?: string): void {
    this.project = project;
    if (dir !== undefined && dir !== this.dir) {
      this.dir = dir;
      this.history.clear();
      this.waves.clear();
      this.recordPosition = null;
      this.selection = { clipIds: new Set(), range: null, markerId: null };
    }
    this.notify('project');
  }

  /** Applies an undoable edit and syncs it to the main process. */
  edit(fn: (p: Project) => Project): void {
    const next = fn(this.project);
    if (next === this.project) return;
    this.history.push(this.project);
    this.project = next;
    void api().updateProject(next);
    this.notify('project');
  }

  /** Non-undoable change that should still be saved (e.g. arming, view tweaks). */
  patch(fn: (p: Project) => Project): void {
    this.project = fn(this.project);
    void api().updateProject(this.project);
    this.notify('project');
  }

  private liveBase: Project | null = null;

  /** True while a slider drag is applying changes that will become one undo step. */
  get liveEditing(): boolean {
    return this.liveBase !== null;
  }

  /** Applies a change immediately (e.g. while dragging a slider) without an undo step yet. */
  editLive(fn: (p: Project) => Project): void {
    if (!this.liveBase) this.liveBase = this.project;
    this.project = fn(this.project);
    void api().updateProject(this.project);
    this.notify('project');
  }

  /** Turns the live changes since the first editLive() into one undo step. */
  commitLive(): void {
    if (this.liveBase && this.liveBase !== this.project) this.history.push(this.liveBase);
    this.liveBase = null;
    this.notify('project');
  }

  /** Takes over a project another client (an AI agent over MCP) changed in the main process, as one undo step. */
  applyExternal(project: Project): void {
    if (this.liveBase) this.commitLive();
    this.history.push(this.project);
    this.project = project;
    this.notify('project');
  }

  undo(): void {
    const p = this.history.undo(this.project);
    if (!p) return;
    this.project = p;
    void api().updateProject(p);
    this.notify('project');
  }

  redo(): void {
    const p = this.history.redo(this.project);
    if (!p) return;
    this.project = p;
    void api().updateProject(p);
    this.notify('project');
  }

  select(patch: Partial<Selection>): void {
    this.selection = { ...this.selection, ...patch };
    this.notify('selection');
  }

  setView(view: View): void {
    this.view = view;
    this.notify('view');
  }

  addLivePeaks(updates: LivePeaks[]): void {
    for (const u of updates) {
      let live = this.livePeaks.get(u.trackId);
      if (!live || live.base !== u.samplesPerPeak) {
        live = new PeakPyramid(u.samplesPerPeak);
        this.livePeaks.set(u.trackId, live);
      }
      // updates arrive in order; pad a gap with silence and skip what is already there
      while (live.count < u.from) live.push(0, 0);
      for (let i = (live.count - u.from) * 2; i + 1 < u.data.length; i += 2) live.push(u.data[i], u.data[i + 1]);
    }
  }

  requestPeaks(file: string): WaveformPeaks | null {
    return this.waves.peaks(file);
  }

  get sampleRate(): number {
    return this.project.sampleRate;
  }
}

export const store = new Store();

const REPEAT_KEY = 'wavepod.transport.repeat';

function readRepeatSetting(): boolean {
  try {
    return localStorage.getItem(REPEAT_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveRepeatSetting(on: boolean): void {
  try {
    localStorage.setItem(REPEAT_KEY, on ? '1' : '0');
  } catch {
    // not remembered, still works for this session
  }
}

const SPEED_KEY = 'wavepod.playbackSpeed';

function readSpeedSetting(): number {
  try {
    const v = Number(localStorage.getItem(SPEED_KEY));
    return (PLAYBACK_SPEEDS as readonly number[]).includes(v) ? v : 1;
  } catch {
    return 1;
  }
}

export function saveSpeedSetting(speed: number): void {
  try {
    localStorage.setItem(SPEED_KEY, String(speed));
  } catch {
    // not remembered, still works for this session
  }
}
