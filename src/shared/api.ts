// The API the preload script exposes to the renderer as `window.wavepod`.
import type {
  RecordingAlert,
  ImpulseRef,
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
  RemoteInfo,
  RemoteSessionInfo,
  RemoteSettingsInput,
  RemoteTakeInfo,
  RemoteCommand,
  Project,
  RecordedTake,
  RecordOptions,
  TransportUpdate,
  WaveformPeaks,
  CleanupItem,
  CleanupOptions,
  FileTranscript,
  TranscribeProgress,
  TranscriptionInfo,
  TranscriptionSettingsInput,
  SpeechInfo,
  SpeechSettings,
  SpokenWords,
} from './types';
import type { ElevenVoice, SpeechEditMode } from '../core/speech';
import type { TemplateSummary } from '../core/template';
import type { FxPresetEntry } from '../core/fx/presets';
import type { AlignOutcome } from '../core/alignEdit';
import type { FavouriteSound, FavouriteSoundInfo, SoundLibraryInfo } from '../core/soundLibrary';

export interface OpenedProject {
  project: Project;
  dir: string;
  /**
   * Revision of the project in the main process. It goes up whenever the main process changes the
   * project itself (opening, a finished recording, an AI agent's edit); edits the window sends with
   * an older revision were made on a project that no longer exists and are ignored.
   */
  rev: number;
}

/** Whether project.json holds the latest changes (autosave runs shortly after every change). */
export interface SaveState {
  state: 'saved' | 'unsaved' | 'error';
  /** Why the last save failed. */
  error?: string;
}

/** An episode folder in the WavePod folder, for the Project tab. */
export interface RecentProject {
  name: string;
  dir: string;
  /** When project.json was last written (ms since epoch). */
  modified: number;
}

/** A Zencastr session ZIP unpacked into a temporary folder, with the new episode it goes into. */
export interface ZencastrImport {
  opened: OpenedProject;
  /** Session name from the ZIP's file name. */
  title: string;
  /** Absolute paths of the extracted files; `start` in seconds. */
  tracks: Array<{ name: string; soundboard?: boolean; parts: Array<{ path: string; start: number }> }>;
  skipped: string[];
}

/** An impulse response in the user's folder. */
export interface ImpulseFile extends ImpulseRef {
  seconds: number;
  channels: number;
  sampleRate: number;
}

export interface ImportedAudio {
  file: string;
  length: number;
}

export type MenuCommand =
  | 'import-video'
  | 'export-video'
  | 'video'
  | 'watch-through'
  | 'new-project'
  | 'open-project'
  | 'save'
  | 'save-as'
  | 'new-from-template'
  | 'save-template'
  | 'show-templates-folder'
  | 'import-audio'
  | 'import-chapters'
  | 'import-zencastr'
  | 'export'
  | 'undo'
  | 'ripple-cut'
  | 'copy'
  | 'paste'
  | 'paste-ripple'
  | 'mute-selection'
  | 'select-all'
  | 'normalize-clips'
  | 'fuse-clips'
  | 'loudness-analysis'
  | 'prepare-for-editing'
  | 'punch-in'
  | 'redo'
  | 'view-setup'
  | 'view-edit'
  | 'view-chapters'
  | 'show-project-folder'
  | 'restore-backup'
  | 'shortcuts'
  | 'help'
  | 'about'
  | 'beta-notice'
  | 'speed-up'
  | 'speed-down'
  | 'speed-normal'
  | 'auphonic'
  | 'settings'
  | 'transcript'
  | 'sound-library'
  | 'script'
  | 'script-window'
  | 'import-script'
  | 'transcribe'
  | 'cleanup'
  | 'loop-record'
  | 'next-take'
  | 'previous-take'
  | 'remote-guests';

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

  // Remote guests (LiveKit)
  getRemoteSettings(): Promise<RemoteInfo>;
  setRemoteSettings(input: RemoteSettingsInput): Promise<RemoteInfo>;
  /** Checks the LiveKit URL, key and secret; returns how many rooms are open. */
  testRemote(): Promise<number>;
  /** Starts the episode's remote session: the window gets a port for audio and a host token. */
  remoteStart(): Promise<RemoteSessionInfo>;
  remoteStop(): Promise<void>;
  /** Adds a remote guest track and returns its invite link. */
  remoteInvite(name: string): Promise<{ trackId: string; link: string }>;
  /** A fresh invite link for a remote track. */
  remoteLink(trackId: string): Promise<string>;
  /** Lets a waiting guest in. */
  remoteAdmit(identity: string): Promise<void>;
  /** Puts a guest back in the waiting room. */
  remoteHoldBack(identity: string): Promise<void>;
  remoteRemove(identity: string): Promise<void>;
  remoteTakes(): Promise<RemoteTakeInfo[]>;

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
  /** Fires a test of the recording emergency alert after `delaySeconds`, so the window can be put in the background first. */
  testRecordingAlert(delaySeconds: number): Promise<void>;
  /** Lets the user pick one of the project's backups; returns it, or null if cancelled. */
  restoreBackup(): Promise<Project | null>;

  // transport
  play(from?: number): Promise<void>;
  stop(): Promise<RecordedTake[]>;
  /**
   * Starts recording the armed tracks at the playhead; `loop` records takes over and over (loop
   * recording), `punch` re-records only that range with pre-roll (punch-in).
   */
  record(opts?: RecordOptions): Promise<string[]>;
  seek(position: number): Promise<void>;
  /** Tape-style scrub to `position` while the playhead is dragged (also while stopped); null ends it. */
  scrub(position: number | null): Promise<void>;
  /** Playback speed, 1 to 3, pitch kept (recording and export always run at 1x). */
  setPlaybackSpeed(speed: number): Promise<void>;
  /** Output preset: Pre-show (only the soundboard is heard) or Show. */
  setPreShow(on: boolean): Promise<void>;
  /** Range in frames that playback repeats (the selection while Repeat is on), or null. */
  setLoop(range: [number, number] | null): Promise<void>;

  // project
  currentProject(): Promise<OpenedProject>;
  /** A new, empty episode; `name` names the episode and its folder (default "Episode <date> <time>"). */
  newProject(name?: string): Promise<OpenedProject | null>;
  openProject(): Promise<OpenedProject | null>;
  /** Opens an episode folder from the recent list. */
  openProjectAt(dir: string): Promise<OpenedProject>;
  /** Episodes in the WavePod folder, newest first. */
  listRecentProjects(): Promise<RecentProject[]>;
  /** The name a new episode gets by default. */
  defaultEpisodeName(): Promise<string>;
  /** File › Save: writes project.json now (it is also saved automatically after every change). */
  saveProject(): Promise<void>;
  /** File › Save As: copies the episode folder under a new name next to it and continues in the copy. */
  saveProjectAs(name: string): Promise<OpenedProject>;
  getSaveState(): Promise<SaveState>;
  /** Saves the window's project; false (and nothing changes) when `rev` is stale, see OpenedProject.rev. */
  updateProject(project: Project, rev: number): Promise<boolean>;
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
  newProjectFromTemplate(id: string, name?: string): Promise<OpenedProject>;
  /** Lets the user pick a Zencastr session ZIP, unpacks its tracks and opens a new episode for them (null if cancelled). */
  importZencastr(): Promise<ZencastrImport | null>;
  /** Removes the temporary folder of the last Zencastr import. */
  finishZencastrImport(): Promise<void>;
  showTemplatesFolder(): Promise<void>;
  /** Version and runtime details for Help › About WavePod. */
  getAppInfo(): Promise<AppInfo>;
  /** Opens one of the About dialog's links (website, source code, licences). */
  openAboutLink(which: AboutLink): Promise<void>;
  showProjectFolder(): Promise<void>;

  // app menu, drawn by the renderer where the native menu bar can't follow the app's theme
  /** Empty on macOS, which keeps its native menu. */
  getMenu(): Promise<MenuModelTop[]>;
  menuClick(id: string): Promise<void>;

  // files
  pickAudioFiles(): Promise<string[]>;

  // video (multi-camera)
  /** Lets the user choose video files; absolute paths. */
  pickVideoFiles(): Promise<string[]>;
  /** How a video is stored in the episode (relative inside the episode folder, else absolute). */
  storedVideoPath(path: string): Promise<string>;
  /** Size in bytes of a file (relative paths are in the episode folder). */
  fileSize(path: string): Promise<number>;
  /** Bytes [start, end) of a file (relative paths are in the episode folder). */
  readFileRange(path: string, start: number, end: number): Promise<Uint8Array>;
  /** Save dialog for the exported video; null when cancelled. */
  /** Opens the exported video for writing (into a .part file); returns its id. */
  videoOutOpen(path: string): Promise<string>;
  videoOutWrite(id: string, position: number, data: Uint8Array): Promise<void>;
  /** Finishes (renames the .part file) or, with abort, deletes it; returns the path written. */
  videoOutClose(id: string, abort?: boolean): Promise<string | null>;
  /** A temporary output base (without extension) for the mix of a video export. */
  videoTempBase(): Promise<string>;
  removeVideoTemp(base: string): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  /** Writes decoded audio as a WAV into the project's media folder. */
  importAudio(name: string, channels: Float32Array[], sampleRate: number): Promise<ImportedAudio>;
  /** Imports a WAV file from disk in a worker (any length); null when it isn't a WAV it can stream. */
  importAudioFile(path: string, name: string, sampleRate: number): Promise<ImportedAudio | null>;
  /** Starts a chunked import of decoded audio; returns its id for importAudioChunk / importAudioEnd. */
  importAudioBegin(name: string, channels: number, sampleRate: number): Promise<string>;
  importAudioChunk(id: string, channels: Float32Array[]): Promise<void>;
  /** Finishes a chunked import (null when aborted: the file is removed). */
  importAudioEnd(id: string, abort?: boolean): Promise<ImportedAudio | null>;
  openTextFile(title: string, extensions: string[]): Promise<{ path: string; text: string } | null>;
  saveTextFile(defaultName: string, text: string): Promise<string | null>;
  /**
   * Lets the user choose a JPEG or PNG and copies it into the project's images folder; returns its
   * relative path. With kind 'chapter' the dialog opens in the folder of the last chapter image.
   */
  pickImage(title: string, kind?: 'chapter'): Promise<string | null>;
  /**
   * Copies an image named in a chapter list (relative to the list file's folder) into the project;
   * returns its relative path, or null if the file is missing or not a JPEG/PNG.
   */
  importChapterImage(listPath: string, name: string): Promise<string | null>;

  // soundboard
  loadSound(id: string, channels: Float32Array[]): Promise<void>;
  playSound(id: string): Promise<void>;
  stopSounds(): Promise<void>;

  // sound effects library (a folder of audio files, searched by name)
  /** The library folder's files; scanned once, again with rescan. */
  getSoundLibrary(rescan?: boolean): Promise<SoundLibraryInfo>;
  /** Lets the user choose the library folder; null if cancelled. */
  chooseSoundLibraryFolder(): Promise<SoundLibraryInfo | null>;
  /** Forgets the library folder. */
  clearSoundLibraryFolder(): Promise<SoundLibraryInfo>;
  /** Bytes of a file in the library (path inside the library folder). */
  readLibraryFile(rel: string): Promise<Uint8Array>;
  /** Shows a library file in the system file manager. */
  revealLibraryFile(rel: string): Promise<void>;
  /** Plays decoded audio on the main output for pre-listening; null stops. False if nothing plays. */
  previewSound(channels: Float32Array[] | null): Promise<boolean>;
  // favourite sounds (app settings, not the episode)
  getFavouriteSounds(): Promise<FavouriteSoundInfo[]>;
  /** Replaces the list (rename, reorder, remove); returns it as stored. */
  setFavouriteSounds(list: FavouriteSound[]): Promise<FavouriteSoundInfo[]>;
  /** Adds library files (paths inside the library) and/or absolute file paths at the end. */
  addFavouriteSounds(opts: { library?: string[]; files?: string[] }): Promise<{ list: FavouriteSoundInfo[]; added: number }>;
  /** Lets the user pick audio files to add; null if cancelled. */
  chooseFavouriteSounds(): Promise<{ list: FavouriteSoundInfo[]; added: number } | null>;
  /** Bytes of a favourite's file (only files in the list). */
  readFavouriteSound(path: string): Promise<Uint8Array>;

  // export
  /** The folder an export goes to by default: the episode's export/ folder (created), else the episode folder, Music or home. */
  exportFolder(): Promise<string>;
  /** Lets the user pick the export folder, starting in `start`; null if cancelled. */
  chooseExportFolder(start?: string): Promise<string | null>;
  /** Which of these files already exist (to ask before an export replaces them). */
  existingFiles(paths: string[]): Promise<string[]>;
  exportProject(opts: ExportOptions): Promise<ExportResult>;
  /** Loudness of the mix and (unless `mixOnly`) of every track with clips. */
  /** `mono`: the mix folded to mono, as a mono export is measured. */
  measureLoudness(mixOnly?: boolean, mono?: boolean): Promise<LoudnessReport[]>;
  /** Loudness of single clips (with their fades and clip gain, before track processing). */
  measureClips(clipIds: string[]): Promise<LoudnessReport[]>;
  revealFile(path: string): Promise<void>;
  /** Opens the help window at a page of the user guide (`topic` or `topic/anchor`). */
  openHelp(topic?: string): Promise<void>;
  /**
   * How clips (one track's, e.g. a field recorder's) have to move to line up with a reference track
   * by their content. With clock drift, their files are resampled to stretched copies first (see
   * AlignOutcome.files); the caller applies the result with applyAlignment.
   */
  alignClips(clipIds: string[], refTrackId: string): Promise<AlignOutcome>;
  /**
   * Renders neighbouring clips of one track into a new file in the episode's media folder (with a
   * transcript put together from theirs); the caller swaps the clips for it with applyRenderedFuse.
   * Clips that simply continue each other are fused without this (fuseSeamless).
   */
  fuseClips(clipIds: string[]): Promise<{ file: string }>;

  // transcripts (ElevenLabs speech-to-text) and cleanup
  getTranscriptionInfo(): Promise<TranscriptionInfo>;
  setTranscriptionSettings(input: TranscriptionSettingsInput): Promise<TranscriptionInfo>;
  /** The episode's transcripts, by media file. */
  loadTranscripts(): Promise<Record<string, FileTranscript>>;
  /** Transcribes the files of these tracks (all speech tracks if none) that have no transcript yet (all with redo). */
  /** With `range` (timeline frames), only what that part of the timeline plays. */
  transcribe(opts?: { trackIds?: string[]; redo?: boolean; range?: [number, number] }): Promise<{ transcribed: number; stopped: boolean }>;
  stopTranscribing(): Promise<void>;
  /** Removes the transcripts of these tracks (all if none); returns how many files had one. */
  deleteTranscripts(trackIds?: string[]): Promise<number>;
  // speech synthesis (experimental): words typed into the transcript, said by ElevenLabs
  getSpeechInfo(): Promise<SpeechInfo>;
  setSpeechSettings(patch: Partial<SpeechSettings>): Promise<SpeechInfo>;
  /** The voices of the ElevenLabs account, cloned ones first. */
  listVoices(): Promise<ElevenVoice[]>;
  /** Clones a track speaker's voice from their transcribed speech (up to 90 s is uploaded). */
  cloneVoice(trackId: string): Promise<{ id: string; name: string; seconds: number }>;
  /** Removes a voice from the ElevenLabs account. */
  deleteVoice(voiceId: string): Promise<void>;
  /** Generates the words, trimmed and with a clip gain that matches the speaker around `at`. */
  speakWords(input: { trackId: string; voiceId: string; text: string; previousText?: string; nextText?: string; mode: SpeechEditMode; at: number }): Promise<SpokenWords>;
  /** Saves generated words as a media file with its own transcript. */
  storeSpokenWords(text: string, spoken: Pick<SpokenWords, 'samples' | 'pad'>): Promise<{ file: string; length: number }>;
  /** Finds long pauses, hesitations and retakes to take out (pauses from the audio, the rest from the transcript). */
  findCleanup(opts: CleanupOptions): Promise<CleanupItem[]>;

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

  // impulse responses for the convolution reverb (app-wide, in the Impulse responses folder next to Presets)
  listImpulseResponses(): Promise<ImpulseFile[]>;
  /** Copies an IR file (WAV or AIFF; asks for one without `path`) into the folder. Null if cancelled. */
  importImpulseResponse(path?: string): Promise<ImpulseRef | null>;
  showImpulseResponsesFolder(): Promise<void>;

  // events (return an unsubscribe function)
  onTransport(cb: (u: TransportUpdate) => void): () => void;
  onStatus(cb: (s: EngineStatus) => void): () => void;
  /** Takes are already merged into `project` (and saved) by the main process; `preparedForEditing` = tracks were unarmed afterwards. */
  onRecordingFinished(cb: (r: { takes: RecordedTake[]; project: Project; rev: number; preparedForEditing: boolean; problems: number; passes?: number }) => void): () => void;
  onExportProgress(cb: (p: ExportProgress) => void): () => void;
  onMenu(cb: (cmd: MenuCommand) => void): () => void;
  /** OSC remote-control commands. */
  onRemote(cb: (cmd: RemoteCommand) => void): () => void;
  /** An AI agent changed the project over MCP; it is already applied in the main process. */
  /** The main process changed the project (an AI agent's edit, or a remote guest's recording arriving): one undo step. */
  onProjectEdited(cb: (e: { project: Project; rev: number; summary: string; source?: 'agent' | 'remote' }) => void): () => void;
  onSaveState(cb: (s: SaveState) => void): () => void;
  onTranscribeProgress(cb: (p: TranscribeProgress) => void): () => void;
  /** A file's transcript was made (or removed: null). */
  onTranscript(cb: (u: { file: string; transcript: FileTranscript | null }) => void): () => void;
  /** An emergency during a recording (device lost, take not written), or a test of it. */
  onRecordingAlert(cb: (a: RecordingAlert) => void): () => void;

  platform: string;
  /** Where a file dropped onto the window lives on disk ('' if it isn't a file on disk). */
  pathForFile(file: File): string;
}

export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
}

export type AboutLink = 'website' | 'source' | 'licenses';

export const IPC = {
  invoke: 'wavepod:invoke',
  transport: 'wavepod:transport',
  status: 'wavepod:status',
  recordingFinished: 'wavepod:recordingFinished',
  exportProgress: 'wavepod:exportProgress',
  menu: 'wavepod:menu',
  remote: 'wavepod:remote',
  projectEdited: 'wavepod:projectEdited',
  saveState: 'wavepod:saveState',
  transcribeProgress: 'wavepod:transcribeProgress',
  transcript: 'wavepod:transcript',
  recordingAlert: 'wavepod:recordingAlert',
} as const;

/** Methods that go through the generic invoke channel. */
export type InvokeMethod = Exclude<
  keyof WavePodApi,
  'onTransport' | 'onStatus' | 'onRecordingFinished' | 'onExportProgress' | 'onMenu' | 'onRemote' | 'onProjectEdited' | 'onSaveState' | 'onTranscribeProgress' | 'onTranscript' | 'onRecordingAlert' | 'platform' | 'pathForFile'
>;

export const INVOKE_METHODS: InvokeMethod[] = [
  'getRemoteSettings',
  'setRemoteSettings',
  'testRemote',
  'remoteStart',
  'remoteStop',
  'remoteInvite',
  'remoteLink',
  'remoteAdmit',
  'remoteHoldBack',
  'remoteRemove',
  'remoteTakes',
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
  'testRecordingAlert',
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
  'openProjectAt',
  'listRecentProjects',
  'defaultEpisodeName',
  'saveProject',
  'saveProjectAs',
  'getSaveState',
  'updateProject',
  'getPeaks',
  'getPeakTile',
  'getSampleTile',
  'listTemplates',
  'saveTemplate',
  'deleteTemplate',
  'newProjectFromTemplate',
  'importZencastr',
  'finishZencastrImport',
  'showTemplatesFolder',
  'getAppInfo',
  'openAboutLink',
  'showProjectFolder',
  'getMenu',
  'menuClick',
  'pickAudioFiles',
  'pickVideoFiles',
  'storedVideoPath',
  'fileSize',
  'readFileRange',
  'videoOutOpen',
  'videoOutWrite',
  'videoOutClose',
  'videoTempBase',
  'removeVideoTemp',
  'readFile',
  'importAudio',
  'importAudioFile',
  'importAudioBegin',
  'importAudioChunk',
  'importAudioEnd',
  'openTextFile',
  'saveTextFile',
  'pickImage',
  'importChapterImage',
  'loadSound',
  'playSound',
  'stopSounds',
  'getSoundLibrary',
  'chooseSoundLibraryFolder',
  'clearSoundLibraryFolder',
  'readLibraryFile',
  'revealLibraryFile',
  'previewSound',
  'getFavouriteSounds',
  'setFavouriteSounds',
  'addFavouriteSounds',
  'chooseFavouriteSounds',
  'readFavouriteSound',
  'exportFolder',
  'chooseExportFolder',
  'existingFiles',
  'exportProject',
  'measureLoudness',
  'measureClips',
  'revealFile',
  'openHelp',
  'alignClips',
  'fuseClips',
  'getTranscriptionInfo',
  'setTranscriptionSettings',
  'loadTranscripts',
  'transcribe',
  'stopTranscribing',
  'deleteTranscripts',
  'getSpeechInfo',
  'setSpeechSettings',
  'listVoices',
  'cloneVoice',
  'deleteVoice',
  'speakWords',
  'storeSpokenWords',
  'findCleanup',
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
  'listImpulseResponses',
  'importImpulseResponse',
  'showImpulseResponsesFolder',
];
