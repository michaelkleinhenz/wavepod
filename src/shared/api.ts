// The API the preload script exposes to the renderer as `window.wavepod`.
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
  McpSettings,
  McpStatus,
  MidiSettings,
  OscSettings,
  OscStatus,
  AuphonicInfo,
  AuphonicSettingsInput,
  RemoteCommand,
  Project,
  RecordedTake,
  TransportUpdate,
  WaveformPeaks,
} from './types';
import type { TemplateSummary } from '../core/template';
import type { FxPresetEntry } from '../core/fx/presets';
import type { AlignResult } from '../core/align';

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
  | 'new-from-template'
  | 'save-template'
  | 'show-templates-folder'
  | 'import-audio'
  | 'import-chapters'
  | 'export'
  | 'undo'
  | 'ripple-cut'
  | 'copy'
  | 'paste'
  | 'paste-ripple'
  | 'mute-selection'
  | 'select-all'
  | 'normalize-clips'
  | 'loudness-analysis'
  | 'prepare-for-editing'
  | 'redo'
  | 'view-setup'
  | 'view-edit'
  | 'view-chapters'
  | 'show-project-folder'
  | 'restore-backup'
  | 'shortcuts'
  | 'auphonic';

/** One entry of the in-app menu bar that stands in for the native one on Linux and Windows. */
export interface MenuModelItem {
  id: string;
  type: 'normal' | 'separator' | 'checkbox';
  label: string;
  /** Shortcut as shown, e.g. "Ctrl+Shift+N". */
  accelerator?: string;
  checked?: boolean;
  enabled: boolean;
}

export interface MenuModelTop {
  label: string;
  items: MenuModelItem[];
}

export interface WavePodApi {
  // devices
  getStatus(): Promise<EngineStatus>;
  listDevices(): Promise<AudioDevice[]>;
  applyConfig(config: Partial<DeviceConfig>): Promise<EngineStatus>;
  getProfile(deviceId: number): Promise<DeviceProfile | null>;

  // MIDI controller mappings (app settings, shared by all projects)
  getMidiSettings(): Promise<MidiSettings>;
  /** Stores the mappings and returns them as saved (validated). */
  setMidiSettings(settings: MidiSettings): Promise<MidiSettings>;

  // MCP server for AI agents (app settings, local only, off by default)
  getMcpStatus(): Promise<McpStatus>;
  /** Stores the settings and starts, restarts or stops the server. */
  setMcpSettings(settings: McpSettings): Promise<McpStatus>;

  // Auphonic hand-off
  getAuphonicSettings(): Promise<AuphonicInfo>;
  setAuphonicSettings(input: AuphonicSettingsInput): Promise<AuphonicInfo>;
  /** The account's multitrack presets. */
  auphonicPresets(): Promise<Array<{ uuid: string; name: string }>>;
  /** Renders stems, creates the production and uploads; progress comes as export progress. */
  sendToAuphonic(): Promise<{ uuid: string; url: string; started: boolean }>;
  /** Opens a production page on auphonic.com in the browser. */
  openAuphonic(url: string): Promise<void>;

  // OSC remote control (app settings, off by default)
  getOscStatus(): Promise<OscStatus>;
  /** Stores the settings and starts, restarts or stops the OSC server. */
  setOscSettings(settings: OscSettings): Promise<OscStatus>;

  /** What the soundcheck needs from the main process: input device name and free disk space. */
  soundcheckInfo(): Promise<{ inputDeviceName?: string; freeBytes: number | null }>;
  /** Ask before stopping a recording (Edit menu setting, on by default). */
  confirmStopRecording(): Promise<boolean>;
  /** Lets the user pick one of the project's backups; returns it, or null if cancelled. */
  restoreBackup(): Promise<Project | null>;

  // transport
  play(from?: number): Promise<void>;
  stop(): Promise<RecordedTake[]>;
  record(): Promise<string[]>;
  seek(position: number): Promise<void>;
  /** Tape-style scrub to `position` while the playhead is dragged (also while stopped); null ends it. */
  scrub(position: number | null): Promise<void>;
  /** Playback speed, 1 to 2, pitch kept (recording and export always run at 1x). */
  setPlaybackSpeed(speed: number): Promise<void>;
  /** Output preset: Pre-show (only the soundboard is heard) or Show. */
  setPreShow(on: boolean): Promise<void>;
  /** Range in frames that playback repeats (the selection while Repeat is on), or null. */
  setLoop(range: [number, number] | null): Promise<void>;

  // project
  currentProject(): Promise<OpenedProject>;
  newProject(): Promise<OpenedProject | null>;
  openProject(): Promise<OpenedProject | null>;
  updateProject(project: Project): Promise<void>;
  /** Coarse waveform levels of a media file (computed and cached next to it on first use). */
  getPeaks(file: string): Promise<WaveformPeaks | null>;
  /** PEAK_TILE buckets of a finer level, starting at bucket tile * PEAK_TILE (null if unavailable). */
  getPeakTile(file: string, samplesPerPeak: number, tile: number): Promise<Int8Array | null>;
  /** SAMPLE_TILE mono samples starting at frame tile * SAMPLE_TILE, for drawing at sample level. */
  getSampleTile(file: string, tile: number): Promise<Float32Array | null>;

  // templates (tracks, input channels, filters and soundboard, without recorded audio)
  listTemplates(): Promise<TemplateSummary[]>;
  /** Saves the open project's setup as a template; one with the same name is replaced. */
  saveTemplate(name: string): Promise<TemplateSummary>;
  deleteTemplate(id: string): Promise<void>;
  newProjectFromTemplate(id: string): Promise<OpenedProject>;
  showTemplatesFolder(): Promise<void>;
  showProjectFolder(): Promise<void>;

  // app menu, drawn by the renderer where the native menu bar can't follow the app's theme
  /** Empty on macOS, which keeps its native menu. */
  getMenu(): Promise<MenuModelTop[]>;
  menuClick(id: string): Promise<void>;

  // files
  pickAudioFiles(): Promise<string[]>;
  readFile(path: string): Promise<Uint8Array>;
  /** Writes decoded audio as a WAV into the project's media folder. */
  importAudio(name: string, channels: Float32Array[], sampleRate: number): Promise<ImportedAudio>;
  openTextFile(title: string, extensions: string[]): Promise<{ path: string; text: string } | null>;
  saveTextFile(defaultName: string, text: string): Promise<string | null>;
  /** Lets the user choose a JPEG or PNG and copies it into the project's images folder; returns its relative path. */
  pickImage(title: string): Promise<string | null>;

  // soundboard
  loadSound(id: string, channels: Float32Array[]): Promise<void>;
  playSound(id: string): Promise<void>;
  stopSounds(): Promise<void>;

  // export
  chooseExportBase(defaultName: string): Promise<string | null>;
  exportProject(opts: ExportOptions): Promise<ExportResult>;
  /** Loudness of the mix and (unless `mixOnly`) of every track with clips. */
  measureLoudness(mixOnly?: boolean): Promise<LoudnessReport[]>;
  /** Loudness of single clips (with their fades and clip gain, before track processing). */
  measureClips(clipIds: string[]): Promise<LoudnessReport[]>;
  revealFile(path: string): Promise<void>;
  /** Where a clip should start to line up with a reference track (double-ender alignment). */
  alignClip(clipId: string, refTrackId: string): Promise<AlignResult>;

  // VST3 plug-ins (hosted in a separate process; editors are never shown)
  vstStatus(): Promise<{ available: boolean; dirs: string[] }>;
  vstScan(force?: boolean): Promise<VstPluginInfo[]>;
  /** Loads a plug-in once to read its parameters and initial state. */
  vstDescribe(plugin: VstPluginRef): Promise<{ params: Array<VstParamInfo & { value: number }>; state: string; latency: number }>;
  /** The plug-in's own text for a parameter value, e.g. "-12.0 dB". */
  vstFormat(fx: Fx, paramId: number, value: number): Promise<string>;
  /** The normalized value (0..1) for typed text such as "-12 dB", or null if it can't be read. */
  vstParse(fx: Fx, paramId: number, text: string): Promise<number | null>;

  // filter presets (user presets are app-wide, in the Presets folder next to Templates)
  /** Factory presets or the plug-in's own programs, then the user's presets for this kind of filter. */
  listFxPresets(fx: Fx): Promise<FxPresetEntry[]>;
  /** The filter set to a preset (not applied to the project; the caller makes it an undo step). */
  applyFxPreset(fx: Fx, id: string): Promise<Fx>;
  /** Saves the filter's settings as a user preset (same name for the same filter = replaced). */
  saveFxPreset(fx: Fx, name: string): Promise<{ entry: FxPresetEntry; replaced: boolean; fx: Fx }>;
  renameFxPreset(id: string, name: string): Promise<FxPresetEntry>;
  deleteFxPreset(id: string): Promise<void>;
  showPresetsFolder(): Promise<void>;

  // events (return an unsubscribe function)
  onTransport(cb: (u: TransportUpdate) => void): () => void;
  onStatus(cb: (s: EngineStatus) => void): () => void;
  /** Takes are already merged into `project` (and saved) by the main process; `preparedForEditing` = tracks were unarmed afterwards. */
  onRecordingFinished(cb: (r: { takes: RecordedTake[]; project: Project; preparedForEditing: boolean; problems: number }) => void): () => void;
  onExportProgress(cb: (p: ExportProgress) => void): () => void;
  onMenu(cb: (cmd: MenuCommand) => void): () => void;
  /** OSC remote-control commands. */
  onRemote(cb: (cmd: RemoteCommand) => void): () => void;
  /** An AI agent changed the project over MCP; it is already applied in the main process. */
  onProjectEdited(cb: (e: { project: Project; summary: string }) => void): () => void;

  platform: string;
}

export const IPC = {
  invoke: 'wavepod:invoke',
  transport: 'wavepod:transport',
  status: 'wavepod:status',
  recordingFinished: 'wavepod:recordingFinished',
  exportProgress: 'wavepod:exportProgress',
  menu: 'wavepod:menu',
  remote: 'wavepod:remote',
  projectEdited: 'wavepod:projectEdited',
} as const;

/** Methods that go through the generic invoke channel. */
export type InvokeMethod = Exclude<
  keyof WavePodApi,
  'onTransport' | 'onStatus' | 'onRecordingFinished' | 'onExportProgress' | 'onMenu' | 'onRemote' | 'onProjectEdited' | 'platform'
>;

export const INVOKE_METHODS: InvokeMethod[] = [
  'getStatus',
  'listDevices',
  'applyConfig',
  'getProfile',
  'getMidiSettings',
  'setMidiSettings',
  'getMcpStatus',
  'setMcpSettings',
  'getAuphonicSettings',
  'setAuphonicSettings',
  'auphonicPresets',
  'sendToAuphonic',
  'openAuphonic',
  'getOscStatus',
  'setOscSettings',
  'soundcheckInfo',
  'confirmStopRecording',
  'restoreBackup',
  'play',
  'stop',
  'record',
  'seek',
  'scrub',
  'setPlaybackSpeed',
  'setPreShow',
  'setLoop',
  'currentProject',
  'newProject',
  'openProject',
  'updateProject',
  'getPeaks',
  'getPeakTile',
  'getSampleTile',
  'listTemplates',
  'saveTemplate',
  'deleteTemplate',
  'newProjectFromTemplate',
  'showTemplatesFolder',
  'showProjectFolder',
  'getMenu',
  'menuClick',
  'pickAudioFiles',
  'readFile',
  'importAudio',
  'openTextFile',
  'saveTextFile',
  'pickImage',
  'loadSound',
  'playSound',
  'stopSounds',
  'chooseExportBase',
  'exportProject',
  'measureLoudness',
  'measureClips',
  'revealFile',
  'alignClip',
  'vstStatus',
  'vstScan',
  'vstDescribe',
  'vstFormat',
  'vstParse',
  'listFxPresets',
  'applyFxPreset',
  'saveFxPreset',
  'renameFxPreset',
  'deleteFxPreset',
  'showPresetsFolder',
];
