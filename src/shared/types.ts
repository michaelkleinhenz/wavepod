// Types shared by main, preload, renderer and core.

export type FadeShape = 'linear' | 'equalPower' | 'sCurve';

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
  /** Curve of the fades (linear when not set). */
  fadeInShape?: FadeShape;
  fadeOutShape?: FadeShape;
  /** Volume line; point positions are frames in the source file (so trims and splits keep them in place). */
  envelope?: EnvelopePoint[];
  /** Volume line is drawn and editable on the clip. */
  showEnvelope?: boolean;
  /** Storyboard: a colour and a free-text note for the clip. */
  color?: string;
  note?: string;
  /** Filter stack of this clip only, processed top to bottom after the track's filters. */
  fx?: Fx[];
  /** Sound design: reverse, varispeed and loop. Not set on a clip that plays its file as recorded. */
  sound?: ClipSound;
}

/**
 * How a sound-designed clip reads its file. `offset` (and the volume line) stay in "virtual"
 * frames that run 1:1 with the timeline, so trims, splits and the volume line work as usual;
 * virtual frame v plays the source at u = (v - base) * rate frames into [start, start + length),
 * backwards when reversed and wrapped round when looping.
 */
export interface ClipSound {
  /** Played backwards. */
  reverse?: boolean;
  /** Varispeed: source frames per timeline frame, so pitch follows speed (1 = as recorded). */
  rate?: number;
  /** The span repeats to fill the clip (ambiences). */
  loop?: boolean;
  /** The source span, in (possibly fractional) file frames: one loop cycle, or the audio a non-looping clip plays. */
  start: number;
  length: number;
  /** Virtual frame where the span begins. */
  base: number;
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
  /** -1 (left) .. 1 (right); pan law for mono material, balance for stereo. */
  pan: number;
  /** Volume and pan automation over the timeline; `shown` is the lane drawn on the track's row. */
  automation?: TrackAutomation;
  clips: Clip[];
  /** Cough-button mutes: [start, end) in timeline frames, sorted, non-overlapping. */
  muteRegions?: MuteRegion[];
  /** Filter stack, processed top to bottom before track gain and pan. */
  fx?: Fx[];
  /** Gets quieter by `depth` dB while the other tracks play (soundboard, music beds). */
  duck?: { enabled: boolean; depth: number };
  /** Crosstalk removal: automixed tracks are turned down by up to `depth` dB while another automixed track is louder. */
  automix?: { enabled: boolean; depth: number };
  /** ElevenLabs voice for speech synthesis (experimental): cloned from this track, or chosen. */
  voice?: TrackVoice;
  /** Stem the track goes to in a dialogue / music / effects export; guessed from the track when unset. */
  stem?: StemGroup;
  /** The track folder (group) this track belongs to; its members sit next to each other in the track list. */
  folderId?: string;
}

/**
 * A group of tracks (e.g. Dialogue, SFX, Atmo, Music) with its own mute, solo and volume that act on
 * every track in it. Folders are not buses: the tracks still mix straight into the master.
 */
export interface TrackFolder {
  id: string;
  name: string;
  color: string;
  mute: boolean;
  solo: boolean;
  /** Group volume in dB, added to each member's track gain. */
  gain: number;
  /** Members hidden in the timeline; the folder row stands in for them. */
  collapsed?: boolean;
}

export type StemGroup = 'dialogue' | 'music' | 'effects' | 'none';

export interface TrackVoice {
  id: string;
  name: string;
  /** Made by WavePod from this track's own audio (may be deleted from the account again). */
  cloned?: boolean;
}

export type AutomationLane = 'volume' | 'pan';

/** One breakpoint of a track automation lane. */
export interface AutomationPoint {
  /** Timeline frame. */
  pos: Frames;
  /** Volume: dB (-60 is silent, up to +6), relative to the track gain. Pan: -1 (left) .. 1 (right). */
  value: number;
}

export interface TrackAutomation {
  volume?: AutomationPoint[];
  pan?: AutomationPoint[];
  shown?: AutomationLane;
}

/** One point of a clip's volume line. */
export interface EnvelopePoint {
  pos: Frames;
  /** Gain in dB; at or below -60 the track is silent. */
  db: number;
}

export type FxType = 'highpass' | 'eq' | 'gate' | 'compressor' | 'deesser' | 'limiter' | 'dynamics' | 'denoise' | 'reverb' | 'bandpass' | 'distortion' | 'echo' | 'space' | 'pitch' | 'ringmod' | 'chorus' | 'vst3';

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
  /** The preset last loaded or saved for this filter, so the FX panel can show it (and whether it was changed since). */
  preset?: FxPresetRef;
}

/** Which preset a filter was set from. */
export interface FxPresetRef {
  id: string;
  name: string;
  /** Signature of the parameter values right after loading, to tell whether they were changed since. */
  sig: string;
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
/** The plug-in's program (factory preset) selector, offered as presets instead of a slider. */
export const VST_PARAM_PROGRAM_CHANGE = 1 << 15;

export type MuteRegion = [Frames, Frames];

export type MarkerKind = 'chapter' | 'edit';

/** A named time span of the episode, e.g. one part of a long session; exportable on its own. */
export interface Region {
  id: string;
  start: Frames;
  end: Frames;
  title: string;
}

export interface Marker {
  id: string;
  kind: MarkerKind;
  position: Frames;
  title: string;
  url?: string;
  /** Chapter image, relative to the project folder ("images/…"). */
  image?: string;
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
  /** Episode cover (JPEG or PNG), relative to the project folder ("images/…"). */
  artwork?: string;
  /** Podcast category, written as the genre (ID3 TCON, FLAC GENRE); "Podcast" when empty. */
  category?: string;
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
  /** Named time spans that can be exported as separate files. */
  regions?: Region[];
  tracks: Track[];
  /** Track folders, in the order they were made; members are found by Track.folderId. */
  folders?: TrackFolder[];
  markers: Marker[];
  soundboard: SoundboardSlot[];
  metadata: EpisodeMetadata;
  /** Soundcheck warnings the user chose not to see again for this episode. */
  soundcheckIgnored?: string[];
}

// ---------------------------------------------------------------- transcripts

/** One transcribed word; times are frames of the file it was heard in. */
export interface TranscriptWord {
  text: string;
  start: Frames;
  end: Frames;
}

/** The transcript of one recorded or imported file (stored in the project's transcripts/ folder). */
export interface FileTranscript {
  version: 1;
  /** The media file, as clips name it. */
  file: string;
  /** Sample rate of the file, which the word times count in. */
  sampleRate: number;
  /** Language code used or detected, e.g. "de" or "deu". */
  language: string;
  /** Speech model it was made with. */
  model: string;
  created: string;
  words: TranscriptWord[];
  /** Level curve of the file, to tell a speaker from crosstalk of the others (see core/wordLevels). */
  levels?: TranscriptLevels;
  /** Sounds the speech-to-text heard (laughter, coughing…), in file frames; transcripts made since WavePod keeps them. */
  events?: TranscriptWord[];
}

/** A coarse level curve: one byte per `step` file frames, dB below full scale, base64 encoded. */
export interface TranscriptLevels {
  step: number;
  db: string;
}

/** A word where it plays on the timeline. */
export interface TimelineWord {
  text: string;
  start: Frames;
  end: Frames;
  trackId: string;
  clipId: string;
  /** A hesitation sound (äh, ähm, uh, um…). */
  filler: boolean;
  /** Inside a cough-button mute region. */
  muted?: boolean;
}

export interface TranscriptionSettings {
  /** ElevenLabs speech-to-text model, e.g. "scribe_v2". */
  model: string;
  /** Language code, or "auto" to let the model detect it per file. */
  language: string;
  /** Names and terms the model should get right (guests, products, places), comma separated. */
  keyterms: string;
  /** Leave out words while another track is this many dB louder: crosstalk (0 = keep them). */
  crosstalkDb: number;
  /** Leave out words quieter than this, in dBFS (0 = keep them). */
  minLevelDb: number;
  /** Leave out words another track has at the same time, louder: the other speaker's echo. */
  matchWords: boolean;
}

/** Transcription settings as the renderer sees them (the API key itself stays in the main process). */
export interface TranscriptionInfo {
  hasKey: boolean;
  settings: TranscriptionSettings;
  models: Array<{ id: string; name: string; description: string }>;
  languages: Array<{ code: string; name: string }>;
}

export interface TranscriptionSettingsInput extends Partial<TranscriptionSettings> {
  /** New ElevenLabs API key; "" removes it, undefined keeps it. */
  apiKey?: string;
}

/** Speech synthesis (experimental): ElevenLabs text-to-speech for words typed into the transcript. */
export interface SpeechSettings {
  /** Text-to-speech model, e.g. "eleven_multilingual_v2". */
  model: string;
  /** 44.1 kHz instead of 24 kHz (needs an ElevenLabs Pro plan). */
  hq: boolean;
  /** Voice settings, 0..1. */
  stability: number;
  similarity: number;
}

export interface SpeechInfo {
  hasKey: boolean;
  settings: SpeechSettings;
  models: Array<{ id: string; name: string; description: string }>;
}

/** Generated words, ready to listen to and put in. */
export interface SpokenWords {
  /** Mono, at the project rate, trimmed and padded. */
  samples: Float32Array;
  /** Clip gain that matches the speaker's level around the edit. */
  gain: number;
  /** Silence on each side, in frames. */
  pad: Frames;
}

export interface TranscribeProgress {
  /** 'levels': working out the level curves older transcripts lack (for leaving out crosstalk). */
  phase: 'preparing' | 'uploading' | 'transcribing' | 'levels' | 'done';
  /** 1-based number of the file being worked on, and how many there are. */
  file: number;
  files: number;
  /** Track name of the current file. */
  name?: string;
}

/** One suggested edit of the cleanup: a pause to shorten or a hesitation to take out. */
export interface CleanupItem {
  id: string;
  kind: 'pause' | 'filler';
  /** Timeline range to cut (pause: the part taken out; filler: the sound itself). */
  start: Frames;
  end: Frames;
  /** Filler: the track it was said on, and the word. */
  trackId?: string;
  text?: string;
  /** Pause: its full length before shortening. */
  pauseLength?: Frames;
  /** cut = ripple cut on all tracks; mute = silenced on its own track (someone else talks at the same time). */
  action: 'cut' | 'mute';
}

export interface CleanupOptions {
  pauses: boolean;
  /** Pauses longer than this (seconds)… */
  maxPause: number;
  /** …are shortened to this (seconds). */
  keepPause: number;
  fillers: boolean;
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
  /** A second stereo output pair (first zero-based channel), e.g. for a stream or a guest feed; null for none. */
  output2FirstChannel?: number | null;
  /** What the second pair carries. */
  output2Source?: OutputSource;
  /** For a 'mixminus' second output: the inputs (zero-based) of the remote guest that the feed leaves out. */
  mixMinusExclude?: number[];
}

/**
 * master: everything; soundboard: only jingles; episode: the timeline without live jingles;
 * mixminus: the live microphones, jingles and playback, without the inputs in `mixMinusExclude`
 * (the feed back to a guest on Zoom or the phone).
 */
export type OutputSource = 'master' | 'soundboard' | 'episode' | 'mixminus';

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
  /** Advice about the chosen audio driver (not an error), e.g. a better one to pick. */
  notice?: string | null;
  /** Pre-show output preset: only the soundboard is heard, timeline playback is silent. */
  preShow: boolean;
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
  /** Sound library preview playing: frames played and its length. */
  preview?: { pos: Frames; length: Frames };
  /** While recording: jingles of this take that have finished (they become clips when recording stops). */
  recordedJingles?: Array<{ slotId: string; start: Frames; length: Frames }>;
  /** While playing: what each active filter did since the previous update, by filter id. */
  fxMeters?: Record<string, FxMeter>;
  /** While playing: peak (linear) each track played since the previous update, by track id. Meters unarmed tracks. */
  trackPeaks?: Record<string, number>;
  /** While recording: problems to show now, and how much disk is left. */
  health?: RecordingHealth;
}

export type RecordingProblem = 'dropout' | 'crackle' | 'clipping' | 'stall' | 'disk';

/** A problem found in a take, at a frame counted from the start of the take. Becomes an edit marker. */
export interface RecordingEvent {
  frame: Frames;
  /** Last occurrence merged into this one. */
  lastFrame?: Frames;
  count?: number;
  kind: RecordingProblem;
  trackId?: string;
  text: string;
}

export interface RecordingWarning {
  /** Stable while the same problem lasts. */
  key: string;
  level: 'warning' | 'critical';
  trackId?: string;
  text: string;
}

/**
 * An emergency during a recording (the input device stopped delivering audio, the take can't be
 * written), shown as a modal with an alarm sound and passed to the system as a notification.
 */
export interface RecordingAlert {
  /** raised: a new emergency; update: new details; resolved: the problem went away; ended: the recording stopped. */
  state: 'raised' | 'update' | 'resolved' | 'ended';
  title: string;
  problems: string[];
  /** Fired by the "Test emergency alert" button in Settings. */
  test?: boolean;
}

export interface RecordingHealth {
  warnings: RecordingWarning[];
  /** Seconds of recording the disk still has room for, if known. */
  diskSecondsLeft: number | null;
  /** Problems found in this take so far. */
  problems: number;
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
  formats: Array<'wav' | 'mp3' | 'flac' | 'opus'>;
  mp3Bitrate: number;
  /** Opus bitrate in kbps (stereo); 64 when not given. */
  opusBitrate?: number;
  normalize: boolean;
  targetLufs: number;
  /** Ceiling for true peaks in dBTP after normalisation. */
  peakCeiling: number;
  stems: boolean;
  /** Stem files as WAV (default) or FLAC (half the size, e.g. for uploading). */
  stemFormat?: 'wav' | 'flac';
  /** One stem per track (default), or one each for dialogue, music and effects (Track.stem). */
  stemMode?: 'tracks' | 'dme';
  /** With DME stems: also a music & effects mix (M&E), the international version without dialogue. */
  stemMe?: boolean;
  chapterFiles: boolean;
  start?: Frames;
  end?: Frames;
}

export interface ExportResult {
  files: string[];
  loudness: number;
  peakDb: number;
  appliedGainDb: number;
  /** Integrated loudness of the written mix (after gain and limiting), when a mix file was written. */
  outputLoudness?: number;
  /** True peak of the written mix, dBTP. */
  outputTruePeakDb?: number;
  /** Most the peak limiter turned down (dB, 0 or negative); 0 when the gain alone reached the target. */
  limiterReductionDb?: number;
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

/** Functions a MIDI button (or an OSC message) can trigger. */
export type MidiAction =
  | 'record-start'
  | 'record-stop'
  | 'record-toggle'
  | 'play-toggle'
  | 'stop'
  | 'chapter-marker'
  | 'edit-marker'
  | 'prepare-for-editing'
  | 'sounds-stop'
  | 'preshow-toggle'
  /** Cough button of speaker track n: mutes while held. */
  | `cough-${CoughSlot}`
  /** Soundboard slot n. */
  | `sound-${SoundSlot}`;

export type CoughSlot = 1 | 2 | 3 | 4 | 5 | 6;
export type SoundSlot = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/** A remote-control command (MIDI or OSC): an action, pressed or released (only cough buttons use release). */
export interface RemoteCommand {
  action: MidiAction;
  pressed: boolean;
}

/** Auphonic settings as the renderer sees them (the key itself stays in the main process). */
export interface AuphonicInfo {
  hasKey: boolean;
  /** Multitrack preset uuid, or '' for none. */
  preset: string;
  /** Start the production right after uploading. */
  start: boolean;
}

export interface AuphonicSettingsInput {
  /** New key; '' removes it; undefined keeps the stored one. */
  apiKey?: string;
  preset?: string;
  start?: boolean;
}

export interface OscSettings {
  enabled: boolean;
  port: number;
  /** Accept messages from other computers (Companion on another machine); otherwise only this computer. */
  allowNetwork: boolean;
}

export interface OscStatus extends OscSettings {
  running: boolean;
  error: string | null;
  /** Messages received since start (for a "it works" hint in Setup). */
  received: number;
}

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
