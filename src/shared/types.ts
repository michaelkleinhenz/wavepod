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
}

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

export interface WaveformPeaks {
  /** Samples per peak bucket. */
  samplesPerPeak: number;
  /** Interleaved min,max pairs scaled to -127..127, mono (stereo files are averaged). */
  data: Int8Array;
  length: Frames;
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
}

export interface LoudnessReport {
  trackId: string | 'master';
  integrated: number;
  peakDb: number;
}
