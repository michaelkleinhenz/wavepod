// The API the preload script exposes to the renderer as `window.soundpod`.
import type {
  AudioDevice,
  DeviceConfig,
  DeviceProfile,
  EngineStatus,
  ExportOptions,
  ExportProgress,
  ExportResult,
  Fx,
  VstParamInfo,
  VstPluginInfo,
  VstPluginRef,
  LoudnessReport,
  Project,
  RecordedTake,
  TransportUpdate,
  WaveformPeaks,
} from './types';

export interface OpenedProject {
  project: Project;
  dir: string;
}

export interface ImportedAudio {
  file: string;
  length: number;
}

export type MenuCommand =
  | 'new-project'
  | 'open-project'
  | 'import-audio'
  | 'import-chapters'
  | 'export'
  | 'undo'
  | 'redo'
  | 'view-setup'
  | 'view-edit'
  | 'view-chapters'
  | 'show-project-folder';

export interface SoundPodApi {
  // devices
  getStatus(): Promise<EngineStatus>;
  listDevices(): Promise<AudioDevice[]>;
  applyConfig(config: Partial<DeviceConfig>): Promise<EngineStatus>;
  getProfile(deviceId: number): Promise<DeviceProfile | null>;

  // transport
  play(from?: number): Promise<void>;
  stop(): Promise<RecordedTake[]>;
  record(): Promise<string[]>;
  seek(position: number): Promise<void>;

  // project
  currentProject(): Promise<OpenedProject>;
  newProject(): Promise<OpenedProject | null>;
  openProject(): Promise<OpenedProject | null>;
  updateProject(project: Project): Promise<void>;
  getPeaks(file: string): Promise<WaveformPeaks | null>;
  showProjectFolder(): Promise<void>;

  // files
  pickAudioFiles(): Promise<string[]>;
  readFile(path: string): Promise<Uint8Array>;
  /** Writes decoded audio as a WAV into the project's media folder. */
  importAudio(name: string, channels: Float32Array[], sampleRate: number): Promise<ImportedAudio>;
  openTextFile(title: string, extensions: string[]): Promise<{ path: string; text: string } | null>;
  saveTextFile(defaultName: string, text: string): Promise<string | null>;

  // soundboard
  loadSound(id: string, channels: Float32Array[]): Promise<void>;
  playSound(id: string): Promise<void>;
  stopSounds(): Promise<void>;

  // export
  chooseExportBase(defaultName: string): Promise<string | null>;
  exportProject(opts: ExportOptions): Promise<ExportResult>;
  measureLoudness(): Promise<LoudnessReport[]>;
  revealFile(path: string): Promise<void>;

  // VST3 plug-ins (hosted in a separate process; editors are never shown)
  vstStatus(): Promise<{ available: boolean; dirs: string[] }>;
  vstScan(force?: boolean): Promise<VstPluginInfo[]>;
  /** Loads a plug-in once to read its parameters and initial state. */
  vstDescribe(plugin: VstPluginRef): Promise<{ params: Array<VstParamInfo & { value: number }>; state: string; latency: number }>;
  /** The plug-in's own text for a parameter value, e.g. "-12.0 dB". */
  vstFormat(fx: Fx, paramId: number, value: number): Promise<string>;

  // events (return an unsubscribe function)
  onTransport(cb: (u: TransportUpdate) => void): () => void;
  onStatus(cb: (s: EngineStatus) => void): () => void;
  /** Takes are already merged into `project` (and saved) by the main process. */
  onRecordingFinished(cb: (r: { takes: RecordedTake[]; project: Project }) => void): () => void;
  onExportProgress(cb: (p: ExportProgress) => void): () => void;
  onMenu(cb: (cmd: MenuCommand) => void): () => void;

  platform: string;
}

export const IPC = {
  invoke: 'soundpod:invoke',
  transport: 'soundpod:transport',
  status: 'soundpod:status',
  recordingFinished: 'soundpod:recordingFinished',
  exportProgress: 'soundpod:exportProgress',
  menu: 'soundpod:menu',
} as const;

/** Methods that go through the generic invoke channel. */
export type InvokeMethod = Exclude<
  keyof SoundPodApi,
  'onTransport' | 'onStatus' | 'onRecordingFinished' | 'onExportProgress' | 'onMenu' | 'platform'
>;

export const INVOKE_METHODS: InvokeMethod[] = [
  'getStatus',
  'listDevices',
  'applyConfig',
  'getProfile',
  'play',
  'stop',
  'record',
  'seek',
  'currentProject',
  'newProject',
  'openProject',
  'updateProject',
  'getPeaks',
  'showProjectFolder',
  'pickAudioFiles',
  'readFile',
  'importAudio',
  'openTextFile',
  'saveTextFile',
  'loadSound',
  'playSound',
  'stopSounds',
  'chooseExportBase',
  'exportProject',
  'measureLoudness',
  'revealFile',
  'vstStatus',
  'vstScan',
  'vstDescribe',
  'vstFormat',
];
