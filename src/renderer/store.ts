// Renderer state: the project (with undo), engine status, transport and selection.
import type { SoundPodApi } from '../shared/api';
import type { AudioDevice, DeviceProfile, EngineStatus, LivePeaks, Project, TransportUpdate, WaveformPeaks } from '../shared/types';
import { History } from '../core/project';

declare global {
  interface Window {
    soundpod: SoundPodApi;
  }
}

export const api = (): SoundPodApi => window.soundpod;

export type View = 'setup' | 'edit' | 'chapters';

export interface Selection {
  clipIds: Set<string>;
  /** Time range in frames, for ripple delete / export range. */
  range: [number, number] | null;
  markerId: string | null;
  /** A selected cough/mute region. */
  muteRegion?: { trackId: string; index: number } | null;
}

type Listener = (what: Set<ChangeKind>) => void;
export type ChangeKind = 'project' | 'transport' | 'status' | 'selection' | 'view' | 'peaks' | 'devices';

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
  selection: Selection = { clipIds: new Set(), range: null, markerId: null };
  view: View = 'edit';
  peaks = new Map<string, WaveformPeaks | 'loading' | null>();
  /** Waveform of the takes being recorded, per track id (min,max pairs). */
  livePeaks = new Map<string, { samplesPerPeak: number; data: number[] }>();
  /** Cough buttons currently held: track id -> timeline frame where the mute starts. */
  coughs = new Map<string, number>();
  /** Decayed meter values per input channel for display. */
  meterHold: number[] = [];

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
      this.peaks.clear();
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
      let entry = this.livePeaks.get(u.trackId);
      if (!entry || entry.samplesPerPeak !== u.samplesPerPeak) {
        entry = { samplesPerPeak: u.samplesPerPeak, data: [] };
        this.livePeaks.set(u.trackId, entry);
      }
      const at = u.from * 2;
      if (entry.data.length < at) entry.data.length = at;
      for (let i = 0; i < u.data.length; i++) entry.data[at + i] = u.data[i];
    }
  }

  requestPeaks(file: string): WaveformPeaks | null {
    const cached = this.peaks.get(file);
    if (cached === 'loading') return null;
    if (cached !== undefined) return cached;
    this.peaks.set(file, 'loading');
    api()
      .getPeaks(file)
      .then((p) => {
        this.peaks.set(file, p);
        this.notify('peaks');
      })
      .catch(() => this.peaks.set(file, null));
    return null;
  }

  get sampleRate(): number {
    return this.project.sampleRate;
  }
}

export const store = new Store();
