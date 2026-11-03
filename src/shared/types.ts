// Types shared by main, preload, renderer and core.

/** Positions and lengths are integer sample frames at the project sample rate. */
export type Frames = number;

export interface Clip {
  id: string;
  /** Path relative to the project folder, e.g. "media/Host-001.wav". */
  file: string;
  /** Timeline start position. */
  start: Frames;
  /** Offset into the source file. */
  offset: Frames;
  length: Frames;
  /** Clip gain in dB. */
  gain: number;
  fadeIn: Frames;
  fadeOut: Frames;
  /** Volume line; point positions are frames in the source file (so trims and splits keep them in place). */
  envelope?: EnvelopePoint[];
  /** Volume line is drawn and editable on the clip. */
  showEnvelope?: boolean;
}

export interface Track {
  id: string;
  /** 'soundboard' marks the track that receives jingles triggered while recording. */
  kind?: 'soundboard';
  name: string;
  color: string;
  /** Zero-based device input channels; one entry = mono, two = stereo. */
  inputChannels: number[];
  armed: boolean;
  mute: boolean;
  solo: boolean;
  /** Track gain in dB. */
  gain: number;
  /** -1 (left) .. 1 (right); used for mono tracks. */
  pan: number;
  clips: Clip[];
  /** Cough-button mutes: [start, end) in timeline frames, sorted, non-overlapping. */
  muteRegions?: MuteRegion[];
  /** Filter stack, processed top to bottom before track gain and pan. */
  fx?: Fx[];
}

/** One point of a clip's volume line. */
export interface EnvelopePoint {
  pos: Frames;
  /** Gain in dB; at or below -60 the track is silent. */
  db: number;
}

export type FxType = 'highpass' | 'eq' | 'gate' | 'compressor' | 'deesser' | 'limiter' | 'dynamics' | 'vst3';

/** One filter in a track's or the master's filter stack. */
export interface Fx {
  id: string;
  type: FxType;
  /** false = bypassed. */
  enabled: boolean;
  /** Built-in filters: values by parameter key. VST3: normalized 0..1 values by parameter id. */
  params: Record<string, number>;
  /** VST3 only: which plug-in this is. */
  plugin?: VstPluginRef;
  /** VST3 only: the plug-in's parameters, for the generated sliders. */
  paramInfo?: VstParamInfo[];
  /** VST3 only: the plug-in's own state (base64), restored before the parameters. */
  state?: string;
}

export interface VstPluginRef {
  /** Path of the .vst3 module. */
  path: string;
  /** Class id (32 hex digits). */
  cid: string;
  name: string;
  vendor: string;
}

export interface VstPluginInfo extends VstPluginRef {
  version: string;
  categories: string;
}

export interface VstParamInfo {
  id: number;
  title: string;
  units: string;
  /** 0 = continuous, 1 = toggle, n = n+1 discrete values. */
  steps: number;
  default: number;
  flags: number;
}

/** VST3 ParameterInfo flags WavePod cares about. */
export const VST_PARAM_READONLY = 1 << 1;
export const VST_PARAM_HIDDEN = 1 << 4;
export const VST_PARAM_BYPASS = 1 << 16;

export type MuteRegion = [Frames, Frames];

export type MarkerKind = 'chapter' | 'edit';

export interface Marker {
  id: string;
  kind: MarkerKind;
  position: Frames;
  title: string;
  url?: string;
}

export interface SoundboardSlot {
  id: string;
  name: string;
  /** Absolute path or path relative to the project folder. */
  file: string;
  gain: number;
  color: string;
  /** Repeat until stopped. */
  loop?: boolean;
  /** Soft fade-in (up to 5 s) when triggered. */
  fadeIn?: boolean;
}

export interface EpisodeMetadata {
  title: string;
  podcast: string;
  author: string;
  episode: string;
  description: string;
  year: string;
}

export type BitDepth = 16 | 24 | 32;

export interface Project {
  version: 1;
  name: string;
  sampleRate: number;
  bitDepth: BitDepth;
  masterGain: number;
  /** Filter stack on the master bus, processed before the master gain. */
  masterFx?: Fx[];
  tracks: Track[];
  markers: Marker[];
  soundboard: SoundboardSlot[];
  metadata: EpisodeMetadata;
}

// ---------------------------------------------------------------- devices

export interface AudioDevice {
  /** Backend-specific id, stable while the device stays connected. */
  id: number;
  name: string;
  inputChannels: number;
  outputChannels: number;
  sampleRates: number[];
  preferredSampleRate: number;
  isDefaultInput: boolean;
  isDefaultOutput: boolean;
}

export interface AudioApiInfo {
  id: string;
  label: string;
}

export interface DeviceConfig {
  api: string;
  inputDeviceId: number | null;
  outputDeviceId: number | null;
  sampleRate: number;
  bufferSize: number;
  /** First zero-based output channel used for the stereo playback pair. */
  outputFirstChannel: number;
}

export interface ChannelLabel {
  index: number;
  label: string;
  /** Channel is the left half of a stereo pair (next channel is right). */
  stereoLeft?: boolean;
  /** Suggested to become its own speaker track. */
  suggestTrack?: boolean;
}

export interface DeviceProfile {
  id: string;
  name: string;
  inputs: ChannelLabel[];
  outputs: ChannelLabel[];
  note?: string;
}

export interface EngineStatus {
  backend: string;
  backendError: string | null;
  apis: AudioApiInfo[];
  config: DeviceConfig;
  inputOpen: boolean;
  outputOpen: boolean;
  inputChannelCount: number;
  outputChannelCount: number;
  error: string | null;
}

export type TransportState = 'stopped' | 'playing' | 'recording';

export interface TransportUpdate {
  state: TransportState;
  position: Frames;
  /** Peak level (linear 0..1+) per device input channel since last update. */
  inputPeaks: number[];
  /** Peak per output channel of the master bus (L, R). */
  outputPeaks: number[];
  /** Seconds of recording written so far, if recording. */
  recordedFrames: Frames;
  /** While recording: new waveform buckets per recording track since the previous update. */
  recordingPeaks?: LivePeaks[];
  /** Jingles currently playing. */
  jingles?: PlayingJingle[];
  /** While recording: jingles of this take that have finished (they become clips when recording stops). */
  recordedJingles?: Array<{ slotId: string; start: Frames; length: Frames }>;
  /** While playing: what each active filter did since the previous update, by filter id. */
  fxMeters?: Record<string, FxMeter>;
  /** While playing: peak (linear) each track played since the previous update, by track id. Meters unarmed tracks. */
  trackPeaks?: Record<string, number>;
}

/** Live activity of one filter, for its meters. */
export interface FxMeter {
  /** Peak level going in and coming out (linear, 1 = 0 dBFS). */
  in: number;
  out: number;
  /** Gain change in dB with the largest magnitude (negative = reduction), for dynamic filters. */
  gain?: number;
  /** Level the detector sees in dB (Dynamics: the input of its curve). */
  level?: number;
}

export interface PlayingJingle {
  slotId: string;
  /** Frames left in the current pass (a looping jingle starts over). */
  remaining: Frames;
  /** Timeline position where it was triggered, if it is being recorded. */
  recordStart?: Frames;
  /** Frames played so far (all passes). */
  played: Frames;
  stopping: boolean;
}

/** Incremental waveform of a take that is still being recorded. */
export interface LivePeaks {
  trackId: string;
  samplesPerPeak: number;
  /** Bucket index of the first min/max pair in `data`, counted from the start of the take. */
  from: number;
  /** Interleaved min,max pairs scaled to -127..127. */
  data: number[];
}

export interface RecordedTake {
  trackId: string;
  clip: Clip;
}

/** One resolution of a waveform: interleaved min,max pairs scaled to -127..127, mono (channels averaged). */
export interface PeakLevel {
  samplesPerPeak: number;
  data: Int8Array;
}

export interface WaveformPeaks {
  length: Frames;
  /** Resolutions held in memory, finest first. */
  levels: PeakLevel[];
  /** Finer resolutions that are read in tiles (getPeakTile) instead of sent whole. */
  tiled?: number[];
}

export interface ExportOptions {
  /** Absolute output path without extension. */
  outputBase: string;
  formats: Array<'wav' | 'mp3'>;
  mp3Bitrate: number;
  normalize: boolean;
  targetLufs: number;
  /** Ceiling for sample peaks in dBFS after normalisation. */
  peakCeiling: number;
  stems: boolean;
  chapterFiles: boolean;
  start?: Frames;
  end?: Frames;
}

export interface ExportResult {
  files: string[];
  loudness: number;
  peakDb: number;
  appliedGainDb: number;
}

export interface ExportProgress {
  phase: string;
  fraction: number;
  /** Waveform of the mix rendered since the last report, for the progress display. */
  wave?: ExportWave;
  /** Loudness of the mix up to the current position. */
  live?: LiveLoudness;
}

/**
 * A stretch of the export waveform. The whole range is `columns` columns wide;
 * `peaks` holds min/max pairs for the columns from `start` on.
 */
export interface ExportWave {
  columns: number;
  start: number;
  peaks: number[];
}

/** Running loudness figures while audio is rendered. */
export interface LiveLoudness {
  /** Loudness of the last 400 ms in LUFS. */
  momentary: number;
  /** Loudness of the last 3 s in LUFS. */
  shortTerm: number;
  /** Integrated loudness of everything so far in LUFS. */
  integrated: number;
  /** Highest true peak so far in dBTP. */
  truePeak: number;
}

/**
 * Loudness figures of a piece of audio, as Ultraschall (via SWS loudness
 * analysis) shows them. Silent material reads −Infinity.
 */
export interface LoudnessStats {
  /** Integrated (programme) loudness, gated, in LUFS. */
  integrated: number;
  /** Loudness range (LRA) in LU. */
  range: number;
  /** Highest short-term loudness (3 s window) in LUFS. */
  shortTermMax: number;
  /** Highest momentary loudness (400 ms window) in LUFS. */
  momentaryMax: number;
  /** True peak (4x oversampled) in dBTP. */
  truePeak: number;
  /** Sample peak in dBFS. */
  samplePeak: number;
  /** Seconds of audio measured. */
  duration: number;
  /** Short-term loudness curve in LUFS, one value per `historyStep` seconds (after the first 3 s). */
  history: number[];
  historyStep: number;
}

export interface LoudnessReport {
  kind: 'mix' | 'track' | 'clip';
  /** Track or clip id ('mix' for the mix). */
  id: string;
  name: string;
  stats: LoudnessStats;
}

// ---------------------------------------------------------------- MIDI controller

/** Functions a MIDI button can trigger. */
export type MidiAction =
  | 'record-start'
  | 'record-stop'
  | 'record-toggle'
  | 'play-toggle'
  | 'stop'
  | 'chapter-marker'
  | 'edit-marker'
  | 'prepare-for-editing';

export type MidiMessageType = 'note' | 'cc' | 'program';

/** What a binding listens for. `device` is the input's name; empty means any device. */
export interface MidiTrigger {
  type: MidiMessageType;
  /** 0–15 (shown as 1–16). */
  channel: number;
  /** Note number, controller number or program number, 0–127. */
  number: number;
  device: string;
}

/**
 * How a button reports presses. `momentary` buttons send "on" when pressed and "off" when released, so
 * only the "on" counts. `toggle` (latching) buttons send "on" on one press and "off" on the next, like the
 * RØDECaster's latching pads, so every message is a press.
 */
export type MidiButtonMode = 'momentary' | 'toggle';

export interface MidiBinding {
  action: MidiAction;
  trigger: MidiTrigger;
  /** Missing means momentary. */
  mode?: MidiButtonMode;
}

/** Stored in the app settings (not per project): the same controller drives every episode. */
export interface MidiSettings {
  enabled: boolean;
  bindings: MidiBinding[];
}

// ---------------------------------------------------------------- MCP server for AI agents

/** App settings for the local MCP server (off by default). */
export interface McpSettings {
  enabled: boolean;
  port: number;
}

export interface McpStatus extends McpSettings {
  running: boolean;
  /** Endpoint clients connect to. */
  url: string;
  error: string | null;
  /** Names of the tools offered. */
  tools: string[];
}
