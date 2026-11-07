// The audio engine: device streams, metering, transport, recording and playback.
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  AudioDevice,
  DeviceConfig,
  EngineStatus,
  LivePeaks,
  PlayingJingle,
  RecordingHealth,
  Project,
  RecordingEvent,
  RecordedTake,
  Track,
  TransportState,
  TransportUpdate,
  WaveformPeaks,
} from '../../shared/types';
import { dbToGain, uid } from '../../shared/time';
import { interleavedPeaks } from '../../core/dsp';
import { MipmapBuilder, PEAK_TILE, SAMPLE_TILE, TILED_MAX_SPP, encodePeaks, headerSize, mixToMono, parsePeakHeader, type PeakFileLayout } from '../../core/peaks';
import { FX_WARMUP_SECONDS, Mixer, ReaderCache, audibleTracks } from '../../core/mixer';
import { clipsEnd, createProject } from '../../core/project';
import { MAX_PLAYBACK_SPEED, TimeStretcher } from '../../core/timeStretch';
import { SCRUB_WARMUP_SECONDS, Scrubber } from '../../core/scrub';
import {
  JINGLE_PANIC_SECONDS,
  JINGLE_STOP_SECONDS,
  SOUNDBOARD_TRACK_ID,
  jingleClips,
  jingleFadeInFrames,
  jingleMediaFile,
  soundboardTrack,
} from '../../core/soundboard';
import { WavReader, writeWavFile } from '../../core/wav';
import type { TakeFileSpec, TakeFilesOptions } from '../../core/takeFiles';
import { RecordingMonitor, formatMinutes } from '../../core/recordingMonitor';
import { loopFramePosition } from '../../core/takes';
import type { RecordOptions } from '../../shared/types';
import { clearJournal, journalOwner, writeJournal, type RecordingJournal } from '../../core/recordingJournal';
import { inProcessSink, type TakeSink, type TakeSinkFactory } from './takeSink';
import type { AudioBackend, StreamHandle } from './backend';
import { markersCrossed, pingTone } from '../../core/markerPing';
import { punchPlan, punchTakeClip, type PunchPlan } from '../../core/punch';
import { SimulatedBackend } from './simulatedBackend';
import { MixMinusBuffer, mixMinusSources, type MixMinusSource } from '../../core/mixMinus';

export const VIRTUAL_API = 'virtual';
const METER_HZ = 30;
/** Recording refuses to start with less free disk space than this many seconds of audio. */
const MIN_DISK_SECONDS = 60;
const DISK_CHECK_MS = 5000;
const JOURNAL_SAVE_MS = 2000;
/** An open input that delivers nothing for this long has dropped out (e.g. a USB interface reset). */
export const INPUT_LOST_MS = 2000;
/** While the input is gone, how often to look for it and reopen it. */
export const RECONNECT_MS = 2000;
/** How often the input watchdog runs (and silence is written while the input is gone). */
const WATCHDOG_MS = 100;

/** What the engine hands over with the takes when a recording stops. */
export interface TakeReport {
  /** Timeline position where the take started. */
  recordStart: number;
  /** Problems found while recording (frames counted from recordStart). */
  events: RecordingEvent[];
  /** Set if the files could not be finished cleanly; the journal is then kept for recovery. */
  writeError: string | null;
  /** Loop recording: the range the timeline jumped round in; each pass becomes a take. */
  loop?: [number, number];
}


function freeBytesAt(dir: string): number | null {
  try {
    const st = fs.statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

interface Recorder {
  trackId: string;
  channels: number[];
  peaks: MipmapBuilder;
  file: string;
  scratch: Float32Array[];
  /** Buckets already sent to the renderer as live peaks. */
  sentBuckets: number;
}

interface Sound {
  data: Float32Array[];
  /** Project-relative WAV copy used for clips on the Soundboard track. */
  file: string;
}

interface Voice {
  slotId: string;
  sound: Sound;
  /** Position within the file (current pass). */
  pos: number;
  /** Frames played in total. */
  played: number;
  gain: number;
  loop: boolean;
  fadeIn: number;
  /** Fade-out in progress: total length and frames left. */
  stop: { length: number; left: number } | null;
  /** Timeline position of the trigger while recording. */
  recordStart?: number;
}

export function defaultConfig(): DeviceConfig {
  return { api: 'default', inputDeviceId: null, outputDeviceId: null, sampleRate: 48000, bufferSize: 512, outputFirstChannel: 0 };
}

function safeFileName(s: string): string {
  return s.replace(/[^\p{L}\p{N}_ -]+/gu, '_').trim().replace(/\s+/g, '-') || 'Track';
}

function timestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export class AudioEngine extends EventEmitter {
  private native: AudioBackend | null = null;
  private nativeError: string | null = null;
  private sim = new SimulatedBackend();
  config: DeviceConfig = defaultConfig();
  private input: StreamHandle | null = null;
  private output: StreamHandle | null = null;
  /** The devices the streams were opened on, to find them again after they drop out (ids can change). */
  private inputDevice: AudioDevice | null = null;
  private outputDevice: AudioDevice | null = null;
  /** When the input last delivered a buffer (performance.now()). */
  private lastInputMs = 0;
  /** Watches the input and reconnects it when it drops out. */
  private watchdog: NodeJS.Timeout | null = null;
  /**
   * Set while the input device is gone: when its audio stopped, the last reconnect attempt and how
   * far silence has been written into the take (so the take keeps time with the clock).
   */
  private inputLost: { since: number; lastTry: number; filledUntil: number; filledFrames: number; startFrame: number; errors: Set<string> } | null = null;
  private silence = new Float32Array(0);
  private error: string | null = null;

  project: Project = createProject();
  projectDir = '';
  private readers = new ReaderCache('');
  /** Peak file layouts by absolute media path, with the media file's mtime they belong to. */
  private peakLayouts = new Map<string, { mtimeMs: number; layout: PeakFileLayout }>();
  private mixer = Object.assign(new Mixer(this.project, this.readers), { metering: true });

  private state: TransportState = 'stopped';
  private playPos = 0;
  /** Playback speed (pitch kept); recording always runs at 1x. */
  private speed = 1;
  private stretcher: TimeStretcher | null = null;
  private stretchTracks: Track[] = [];
  /** Set while the playhead is dragged: the timeline plays at the mouse's speed instead (tape-style). */
  private scrubber: Scrubber | null = null;
  /** Repeat range [start, end) in frames: playback that reaches `end` continues at `start`. */
  private loop: [number, number] | null = null;
  /** Loop recording: the range the take's timeline jumps round in (fixed for the whole take). */
  private recLoop: [number, number] | null = null;
  private recordStart = 0;
  private recordedFrames = 0;
  /** Set while a punch-in pass runs: the take only replaces [in, out), and the pass ends at `until`. */
  private punch: PunchPlan | null = null;
  private recorders: Recorder[] = [];
  /** Where the take's audio goes; set while recording. */
  private sink: TakeSink | null = null;
  private sinkArgs: { specs: TakeFileSpec[]; opts: TakeFilesOptions } | null = null;
  /** Makes the sink for a take: the recording worker in the app, the engine's own thread otherwise. */
  takeSinks: TakeSinkFactory = inProcessSink;
  /** Free bytes on the disk of a folder (null if unknown); replaceable for tests. */
  freeSpace: (dir: string) => number | null = freeBytesAt;
  private monitor: RecordingMonitor | null = null;
  private journal: RecordingJournal | null = null;
  private journalSaved = { rev: 0, at: 0 };
  private freeBytes: { value: number | null; at: number } = { value: null, at: 0 };
  private armedTrackIds = new Set<string>();

  private inputPeaks: number[] = [];
  private outputPeaks = [0, 0];
  private mixBuf: Float32Array[] = [new Float32Array(0), new Float32Array(0)];
  /** Live jingles, kept apart from the timeline so outputs can carry either. */
  private sbBuf: Float32Array[] = [new Float32Array(0), new Float32Array(0)];
  /** Pre-show preset: outputs carry only the soundboard. */
  private preShow = false;
  /** Scratch for the part of a buffer that follows a jump back to the repeat start. */
  private loopBuf: Float32Array[] = [new Float32Array(0), new Float32Array(0)];
  private outBuf = new Float32Array(0);
  /** The guest feed (mix-minus) on the second output: which inputs go in, and the live audio on its way. */
  private mixMinus: { sources: MixMinusSource[]; buf: MixMinusBuffer } | null = null;
  private mmBuf: Float32Array[] = [new Float32Array(0), new Float32Array(0)];
  private sounds = new Map<string, Sound>();
  private jingleTakes: Array<RecordedTake & { slotId: string }> = [];
  private voices: Voice[] = [];
  /** Sound library preview: heard on the main output only, never recorded or exported. */
  private preview: { data: Float32Array[]; pos: number; stop: number } | null = null;
  private previewBuf: Float32Array[] = [new Float32Array(0), new Float32Array(0)];
  /** Marker ping on/off, and the pings sounding now. */
  private markerPing = false;
  private pings: Array<{ tone: Float32Array; pos: number }> = [];
  private pingTones = new Map<string, Float32Array>();
  private meterTimer: NodeJS.Timeout | null = null;
  private fallbackClock: NodeJS.Timeout | null = null;

  constructor(nativeFactory: (() => AudioBackend) | null) {
    super();
    if (nativeFactory) {
      try {
        this.native = nativeFactory();
      } catch (e) {
        this.nativeError = `Native audio unavailable: ${(e as Error).message}`;
      }
    } else {
      this.nativeError = 'Native audio disabled';
    }
    if (!this.native) this.config.api = VIRTUAL_API;
  }

  // ------------------------------------------------------------ devices

  private backend(): AudioBackend {
    if (this.config.api === VIRTUAL_API || !this.native) return this.sim;
    return this.native;
  }

  listDevices(): AudioDevice[] {
    const b = this.backend();
    try {
      return b.listDevices();
    } catch (e) {
      this.error = `Could not list devices: ${(e as Error).message}`;
      return [];
    }
  }

  status(): EngineStatus {
    const apis = [...(this.native ? this.native.listApis() : []), ...this.sim.listApis()];
    return {
      backend: this.backend().name,
      backendError: this.nativeError,
      apis,
      config: { ...this.config },
      inputOpen: !!this.input,
      outputOpen: !!this.output,
      inputChannelCount: this.input?.channels ?? 0,
      outputChannelCount: this.output?.channels ?? 0,
      error: this.error,
      notice: this.backend().notice?.() ?? null,
      preShow: this.preShow,
    };
  }

  /** Applies a device configuration, (re)opening streams. Never throws; errors land in status().error. */
  applyConfig(next: Partial<DeviceConfig>): EngineStatus {
    // Who the guest feed leaves out can change mid-show: no need to stop or reopen anything.
    const keys = Object.keys(next);
    if (keys.length && keys.every((k) => k === 'mixMinusExclude')) {
      this.config = { ...this.config, ...next };
      this.updateMixMinus();
      const s = this.status();
      this.emit('status', s);
      return s;
    }
    if (this.state !== 'stopped') this.stop();
    this.closeStreams();
    this.config = { ...this.config, ...next };
    this.error = null;
    if (this.config.api === VIRTUAL_API || !this.native) {
      this.config.api = VIRTUAL_API;
    } else {
      try {
        this.native.setApi(this.config.api);
      } catch (e) {
        this.error = (e as Error).message;
        // Fall back to the system default rather than keep an API that can't open.
        this.config.api = 'default';
        this.native.setApi('default');
      }
    }
    const devices = this.listDevices();
    const pick = (id: number | null, kind: 'in' | 'out'): AudioDevice | undefined => {
      const usable = devices.filter((d) => (kind === 'in' ? d.inputChannels : d.outputChannels) > 0);
      return (
        usable.find((d) => d.id === id) ??
        (id === null ? usable.find((d) => (kind === 'in' ? d.isDefaultInput : d.isDefaultOutput)) ?? usable[0] : undefined)
      );
    };
    const inDev = pick(this.config.inputDeviceId, 'in');
    const outDev = pick(this.config.outputDeviceId, 'out');
    this.config.inputDeviceId = inDev?.id ?? null;
    this.config.outputDeviceId = outDev?.id ?? null;
    const errors: string[] = [];
    if (inDev) {
      const err = this.openInputOn(inDev);
      if (err) errors.push(err);
    }
    if (outDev) {
      const err = this.openOutputOn(outDev);
      if (err) errors.push(err);
    }
    if (errors.length) this.error = [this.error, ...errors].filter(Boolean).join('\n');
    this.updateMixMinus();
    this.startMeters();
    const s = this.status();
    this.emit('status', s);
    return s;
  }

  /** Opens the input stream on `dev`; returns an error message if that fails. */
  private openInputOn(dev: AudioDevice): string | null {
    try {
      this.input = this.backend().openInput({
        deviceId: dev.id,
        channels: dev.inputChannels,
        sampleRate: this.config.sampleRate,
        frameSize: this.config.bufferSize,
        onData: (d) => this.onInput(d),
        onError: (m) => this.reportError(`Input: ${m}`),
      });
      this.inputDevice = dev;
      this.inputPeaks = new Array(dev.inputChannels).fill(0);
      this.lastInputMs = performance.now();
      this.startWatchdog();
      return null;
    } catch (e) {
      return `Could not open input "${dev.name}" (${this.config.api}, ${dev.inputChannels} ch, ${this.config.sampleRate} Hz, ${this.config.bufferSize} frames): ${(e as Error).message}`;
    }
  }

  /** Opens the output stream on `dev`; returns an error message if that fails. */
  private openOutputOn(dev: AudioDevice): string | null {
    try {
      if (this.config.outputFirstChannel + 2 > dev.outputChannels) this.config.outputFirstChannel = 0;
      const second = this.config.output2FirstChannel;
      if (second !== null && second !== undefined && (second + 2 > dev.outputChannels || second === this.config.outputFirstChannel)) {
        this.config.output2FirstChannel = null;
      }
      this.output = this.backend().openOutput({
        deviceId: dev.id,
        channels: dev.outputChannels,
        sampleRate: this.config.sampleRate,
        frameSize: this.config.bufferSize,
        // The prefill pull runs inside openOutput, before this.output is set.
        pull: (n) => this.onOutput(n, dev.outputChannels),
        onError: (m) => this.reportError(`Output: ${m}`),
      });
      this.outputDevice = dev;
      return null;
    } catch (e) {
      return `Could not open output "${dev.name}" (${this.config.api}, ${dev.outputChannels} ch, ${this.config.sampleRate} Hz, ${this.config.bufferSize} frames): ${(e as Error).message}`;
    }
  }

  // ------------------------------------------------------------ input watchdog

  private startWatchdog(): void {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => this.checkInput(performance.now()), WATCHDOG_MS);
    this.watchdog.unref?.();
  }

  private stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  /**
   * Notices when the input device stops delivering audio (a USB interface that resets or is
   * unplugged takes its streams down for good) and reopens it once it is back. A take keeps running
   * meanwhile: silence is written in real time, so the tracks stay in time with the clock (and with
   * a guest's own recording), and the gap gets an edit marker.
   */
  private checkInput(now: number): void {
    const dev = this.inputDevice;
    if (!dev) return;
    if (!this.inputLost) {
      if (!this.input || now - this.lastInputMs < INPUT_LOST_MS) return;
      this.inputLost = { since: this.lastInputMs, lastTry: 0, filledUntil: this.lastInputMs, filledFrames: 0, startFrame: this.recordedFrames, errors: new Set() };
      this.reportLost(`The input device "${dev.name}" stopped sending audio (disconnected or reset?). Reconnecting as soon as it is back${this.state === 'recording' ? '; the recording goes on with silence meanwhile' : ''}.`);
    }
    const lost = this.inputLost;
    if (this.state === 'recording') {
      const frames = Math.floor(((now - lost.filledUntil) / 1000) * this.config.sampleRate);
      if (frames > 0) {
        lost.filledUntil += (frames / this.config.sampleRate) * 1000;
        lost.filledFrames += frames;
        this.recordSilence(frames);
      }
    } else {
      lost.filledUntil = now;
    }
    if (now - lost.lastTry >= RECONNECT_MS) {
      lost.lastTry = now;
      this.reconnectInput(dev);
    }
  }

  /** Looks for the lost input device (by name, as its id can change) and reopens its streams. */
  private reconnectInput(dev: AudioDevice): void {
    const devices = this.listDevices();
    const inDev = devices.find((d) => d.name === dev.name && d.inputChannels === dev.inputChannels);
    if (!inDev) return;
    // The output goes with it if it is the same interface (or was never open); another one keeps playing.
    const out = this.outputDevice;
    const outDev = out && (out.name === dev.name || !this.output) ? devices.find((d) => d.name === out.name && d.outputChannels === out.outputChannels) : undefined;
    this.input?.close();
    this.input = null;
    const errors = [this.openInputOn(inDev)];
    if (outDev) {
      this.output?.close();
      this.output = null;
      errors.push(this.openOutputOn(outDev));
    }
    const ids = [this.config.inputDeviceId, this.config.outputDeviceId];
    this.config.inputDeviceId = inDev.id;
    if (outDev && this.output) this.config.outputDeviceId = outDev.id;
    if (ids[0] !== this.config.inputDeviceId || ids[1] !== this.config.outputDeviceId) this.emit('configChanged', { ...this.config });
    // the stream counts as back only when audio arrives (onInput); until then keep retrying
    const err = errors.filter(Boolean).join('\n');
    if (err) this.reportLost(err);
  }

  /** Reports a problem of the lost input; it is cleared again when the input is back. */
  private reportLost(message: string): void {
    this.inputLost?.errors.add(message);
    this.reportError(message);
  }

  /** The input delivers audio again after it was lost. */
  private inputRecovered(): void {
    const lost = this.inputLost;
    if (!lost) return;
    this.inputLost = null;
    const seconds = Math.round((performance.now() - lost.since) / 1000);
    const m = this.monitor;
    if (m && lost.filledFrames > 0) {
      const text = `The input device was gone for about ${seconds} s and reconnected; this part is silent`;
      // the monitor noted the stall when it began: say what became of it there
      const sr = this.config.sampleRate;
      const ev = [...m.events].reverse().find((e) => e.kind === 'stall' && Math.abs(e.frame - lost.startFrame) < 5 * sr);
      if (ev) {
        ev.text = text;
        m.revision++;
      } else m.note({ frame: lost.startFrame, kind: 'stall', text });
    }
    if (this.error && lost.errors.has(this.error)) this.error = null;
    this.emit('status', this.status());
  }

  /** Writes silence into the take while the input is gone. */
  private recordSilence(frames: number): void {
    const nch = this.input?.channels ?? this.inputDevice?.inputChannels ?? 1;
    const chunk = Math.max(1, this.config.bufferSize);
    if (this.silence.length !== chunk * nch) this.silence = new Float32Array(chunk * nch);
    for (let left = frames; left > 0; ) {
      const n = Math.min(chunk, left);
      this.recordBuffer(this.silence.subarray(0, n * nch), n, nch, false);
      left -= n;
    }
  }

  reportError(message: string): void {
    this.error = message;
    this.emit('status', this.status());
  }

  private closeStreams(): void {
    this.stopWatchdog();
    this.input?.close();
    this.output?.close();
    this.input = null;
    this.output = null;
    this.inputDevice = null;
    this.outputDevice = null;
    this.inputLost = null;
  }

  // ------------------------------------------------------------ project

  setProject(project: Project, projectDir = this.projectDir): void {
    if (projectDir !== this.projectDir) {
      this.readers.closeAll();
      this.readers = new ReaderCache(projectDir);
      this.projectDir = projectDir;
      this.sounds.clear();
    }
    this.project = project;
    // keep the mixer (and its filter state) across edits; a new folder or rate needs a new one
    if (this.mixer.readers !== this.readers || this.mixer.project.sampleRate !== project.sampleRate) {
      this.mixer.dispose();
      this.mixer = Object.assign(new Mixer(project, this.readers), { metering: true });
    }
    else this.mixer.project = project;
    this.scrubber?.invalidate();
    this.armedTrackIds = new Set(project.tracks.filter((t) => t.armed).map((t) => t.id));
    this.updateMixMinus();
  }

  /** Sets up (or drops) the guest feed after the device setup or the tracks changed. */
  private updateMixMinus(): void {
    const c = this.config;
    if (c.output2Source !== 'mixminus' || c.output2FirstChannel === null || c.output2FirstChannel === undefined) {
      this.mixMinus = null;
      return;
    }
    const sources = mixMinusSources(this.project.tracks, Number.MAX_SAFE_INTEGER, c.mixMinusExclude ?? []);
    // up to four device buffers of delay; after a clock-drift drop, two
    const max = Math.max(4 * c.bufferSize, 1024);
    if (this.mixMinus?.buf.maxDelay === max) this.mixMinus.sources = sources;
    else this.mixMinus = { sources, buf: new MixMinusBuffer(max, Math.max(2 * c.bufferSize, 512)) };
  }

  // ------------------------------------------------------------ transport

  get transportState(): TransportState {
    return this.state;
  }

  get position(): number {
    if (this.state !== 'recording') return this.playPos;
    return this.recLoop ? loopFramePosition(this.recordedFrames, this.recordStart, this.recLoop) : this.recordStart + this.recordedFrames;
  }

  get playbackSpeed(): number {
    return this.speed;
  }

  /** Output preset "Pre-show" (only jingles are heard) or "Show" (everything). Doesn't interrupt the transport. */
  setPreShow(on: boolean): void {
    if (this.preShow === on) return;
    this.preShow = on;
    this.emit('status', this.status());
  }

  setMarkerPing(on: boolean): void {
    this.markerPing = on;
    if (!on) this.pings = [];
  }

  /** 1 (normal) up to 3; playback only. */
  setPlaybackSpeed(speed: number): void {
    this.speed = Math.max(0.5, Math.min(MAX_PLAYBACK_SPEED, Number.isFinite(speed) ? speed : 1));
    this.stretcher = null;
  }

  /**
   * Tape-style scrubbing while the playhead is dragged: plays the timeline at the speed and in the
   * direction the playhead moves to `position`, also while stopped. Playback (if running) holds
   * still meanwhile. `null` ends it; the caller then seeks to where the playhead was let go.
   */
  scrub(position: number | null): void {
    if (position === null || this.state === 'recording') {
      this.scrubber = null;
      return;
    }
    if (!this.scrubber) {
      this.scrubber = new Scrubber(this.project.sampleRate, (pos, n, buf) => {
        // short filter warm-up on jumps: scrubbing backwards jumps often, and each one costs a render
        this.mixer.warmupSeconds = SCRUB_WARMUP_SECONDS;
        try {
          this.mixer.render(pos, n, buf, audibleTracks(this.project));
        } finally {
          this.mixer.warmupSeconds = FX_WARMUP_SECONDS;
        }
      });
      this.scrubber.reset(this.playPos);
      this.stretcher = null;
    }
    this.scrubber.moveTo(position);
  }

  seek(position: number): void {
    if (this.state === 'recording') return;
    this.scrubber = null;
    this.stretcher = null;
    this.playPos = Math.max(0, Math.round(position));
    this.emitTransport();
  }

  play(from?: number): void {
    if (this.state === 'recording') return;
    if (from !== undefined) this.playPos = Math.max(0, Math.round(from));
    this.scrubber = null;
    this.stretcher = null;
    this.state = 'playing';
    if (!this.output) this.startFallbackClock();
    this.emitTransport();
  }

  /** Sets (or clears) the range that playback repeats. Recording loops only when asked to (record({ loop })). */
  setLoop(range: [number, number] | null): void {
    const start = range ? Math.max(0, Math.round(range[0])) : 0;
    const end = range ? Math.round(range[1]) : 0;
    this.loop = range && end > start ? [start, end] : null;
  }

  /** The range the timeline jumps round in now: the repeat range while playing, the take's loop while loop recording. */
  private get activeLoop(): [number, number] | null {
    return this.state === 'playing' ? this.loop : this.state === 'recording' ? this.recLoop : null;
  }

  /** Whether the playhead is inside or before the active loop, so it wraps instead of running on. */
  private get looping(): boolean {
    const loop = this.activeLoop;
    return !!loop && this.playPos < loop[1];
  }

  /** Frames to render before the repeat jump or the end of the last clip, or `frames` if neither is in this block. */
  private framesUntilJump(frames: number): number {
    if (this.state === 'recording') return this.looping ? Math.min(frames, this.recLoop![1] - this.playPos) : frames;
    if (this.state !== 'playing') return frames;
    const until = this.looping ? this.loop![1] : this.clipsEnd();
    return this.playPos < until ? Math.min(frames, until - this.playPos) : frames;
  }

  /** Advances the playhead: jumps back to the repeat start, or stops at the end of the last clip. */
  private advance(frames: number): void {
    const wasLooping = this.looping;
    const loop = this.activeLoop;
    this.playPos += frames;
    // loop recording: the other tracks play the loop over and over along with the passes
    if (this.state === 'recording') {
      if (wasLooping && this.playPos === loop![1]) this.playPos = loop![0];
      return;
    }
    if (this.state !== 'playing') return;
    if (wasLooping && this.playPos === loop![1]) this.playPos = loop![0];
    else if (!wasLooping && this.playPos >= this.clipsEnd()) {
      this.state = 'stopped';
      this.stopFallbackClock();
      this.emitTransport();
    }
  }

  /** Where the last clip on the timeline ends; playback stops there. */
  private clipsEnd(): number {
    return clipsEnd(this.project);
  }

  /**
   * Starts recording all armed tracks at the playhead. Returns the files being written. With
   * `loop`, the timeline jumps back to the loop start at its end until stopped (loop recording);
   * the take is one file per track, cut into a take per pass when it stops. With `punch`, it is a
   * punch-in pass instead: playback and the take start the pre-roll before the range, armed tracks
   * are heard until the punch-in, and the pass stops by itself after the post-roll; only the range
   * ends up replacing the audio on the armed tracks (as a new take).
   */
  record(options: RecordOptions = {}): string[] {
    if (this.state === 'recording') return this.recorders.map((r) => r.file);
    const plan = options.punch ? punchPlan(options.punch) : null;
    this.scrubber = null;
    if (!this.input) throw new Error('No input device is open. Choose one in Setup.');
    if (!this.projectDir) throw new Error('No project folder.');
    const sr = this.input.sampleRate;
    const hasAudio = this.project.tracks.some((t) => t.clips.length > 0);
    if (hasAudio && sr !== this.project.sampleRate) {
      throw new Error(`The project runs at ${this.project.sampleRate} Hz but the device is set to ${sr} Hz.`);
    }
    const armed = this.project.tracks.filter((t) => t.armed && t.inputChannels.length > 0);
    if (armed.length === 0) throw new Error('Arm at least one track that has an input assigned.');
    const bad = armed.find((t) => t.inputChannels.some((c) => c >= this.input!.channels));
    if (bad) throw new Error(`Track "${bad.name}" uses an input channel the device doesn't have.`);

    const mediaDir = path.join(this.projectDir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });
    const bitDepth = this.project.bitDepth;
    const bytesPerSecond = armed.reduce((n, t) => n + t.inputChannels.length, 0) * sr * (bitDepth / 8);
    const free = this.freeSpace(mediaDir);
    if (free !== null && free < bytesPerSecond * MIN_DISK_SECONDS) {
      throw new Error(`The disk is full: there is not even room for a minute of recording (${Math.round(free / 1e6)} MB free).`);
    }
    const startAt = plan ? plan.from : this.playPos;
    const loop = !plan && options.loop && options.loop[1] > options.loop[0] && this.playPos < options.loop[1] ? ([Math.max(0, Math.round(options.loop[0])), Math.round(options.loop[1])] as [number, number]) : null;
    const stamp = timestamp();
    const recorders: Recorder[] = armed.map((t) => {
      let rel = path.join('media', `${safeFileName(t.name)}-${stamp}.wav`);
      for (let i = 2; fs.existsSync(path.join(this.projectDir, rel)); i++) {
        rel = path.join('media', `${safeFileName(t.name)}-${stamp}-${i}.wav`);
      }
      return {
        trackId: t.id,
        channels: [...t.inputChannels],
        peaks: new MipmapBuilder(),
        file: rel.split(path.sep).join('/'),
        scratch: t.inputChannels.map(() => new Float32Array(0)),
        sentBuckets: 0,
      };
    });
    const specs: TakeFileSpec[] = recorders.map((r) => ({ path: path.join(this.projectDir, r.file), channels: r.channels }));
    const opts: TakeFilesOptions = { sampleRate: sr, bitDepth, deviceChannels: this.input.channels };
    // The journal comes first: if anything goes down from here on, the next start finds the files.
    this.journal = {
      version: 1,
      startedAt: new Date().toISOString(),
      sampleRate: sr,
      bitDepth,
      recordStart: startAt,
      ...(plan ? { punch: [plan.in, plan.out] as [number, number] } : {}),
      takes: recorders.map((r) => ({
        trackId: r.trackId,
        trackName: armed.find((t) => t.id === r.trackId)?.name ?? 'Track',
        file: r.file,
        channels: r.channels,
      })),
      jingles: [],
      events: [],
      ...(loop ? { loop } : {}),
      owner: journalOwner(),
    };
    writeJournal(this.projectDir, this.journal);
    try {
      this.sink = this.openSink(specs, opts);
    } catch (e) {
      clearJournal(this.projectDir);
      this.journal = null;
      throw e;
    }
    this.sinkArgs = { specs, opts };
    this.recorders = recorders;
    this.monitor = new RecordingMonitor({
      sampleRate: sr,
      bufferSize: this.input.frameSize,
      bytesPerSecond,
      tracks: armed.map((t) => ({ trackId: t.id, name: t.name, channels: [...t.inputChannels] })),
    });
    this.journalSaved = { rev: 0, at: performance.now() };
    this.freeBytes = { value: free, at: performance.now() };
    this.playPos = startAt;
    this.stretcher = null;
    this.recordStart = startAt;
    this.recordedFrames = 0;
    this.punch = plan;
    this.recLoop = loop;
    this.jingleTakes = [];
    this.state = 'recording';
    this.emitTransport();
    return this.recorders.map((r) => r.file);
  }

  /** Opens the take's files through the configured sink, falling back to this thread. */
  private openSink(specs: TakeFileSpec[], opts: TakeFilesOptions): TakeSink {
    if (this.takeSinks === inProcessSink) return inProcessSink(specs, opts);
    try {
      return this.takeSinks(specs, opts);
    } catch (e) {
      // A file that can't be created fails the same way here; anything else was the worker.
      const sink = inProcessSink(specs, opts);
      console.error(`[recording] writer thread unavailable, writing on the main thread: ${(e as Error).message}`);
      return sink;
    }
  }

  /**
   * The recording worker died mid-take: carry on writing the same files from this thread.
   * Only the buffers that were on their way to the worker are lost; the gap is marked.
   */
  writerFailed(reason: string): void {
    if (this.state !== 'recording' || !this.sinkArgs) return;
    const { specs, opts } = this.sinkArgs;
    try {
      this.sink = inProcessSink(specs, { ...opts, append: true });
      this.monitor?.note({ frame: this.recordedFrames, kind: 'disk', text: `${reason}; recording continues, a few milliseconds may be missing here` });
    } catch (e) {
      this.sink = null;
      this.reportError(`Recording failed: ${reason}, and the files could not be reopened: ${(e as Error).message}`);
    }
  }

  stop(): RecordedTake[] {
    const wasRecording = this.state === 'recording';
    this.scrubber = null;
    this.stopFallbackClock();
    let takes: RecordedTake[] = [];
    let report: TakeReport | null = null;
    if (wasRecording) {
      const punch = this.punch;
      ({ takes, report } = this.finishRecording());
      // after a punch the playhead goes back to the pre-roll start, so Play reviews the new line in
      // context; after loop recording it waits at the loop start, ready for the next go
      this.playPos = punch ? punch.from : report.loop ? report.loop[0] : this.recordStart + this.recordedFrames;
    }
    this.state = 'stopped';
    this.emitTransport();
    if (takes.length) this.emit('recordingFinished', takes, report);
    else if (wasRecording && this.projectDir && !report?.writeError) clearJournal(this.projectDir);
    return takes;
  }

  private finishRecording(): { takes: RecordedTake[]; report: TakeReport } {
    const takes: RecordedTake[] = [];
    const done = this.sink?.finish() ?? { error: 'The recording files were lost', framesOnDisk: null };
    this.sink = null;
    this.sinkArgs = null;
    if (done.error) this.reportError(`Recording: ${done.error}. The files keep what reached the disk; the take is recovered when the project is opened again.`);
    for (const [i, r] of this.recorders.entries()) {
      // Normally every frame reached the file; if not, the clip must not claim more than is there.
      const length = Math.min(this.recordedFrames, done.framesOnDisk?.[i] ?? this.recordedFrames);
      const peaks = r.peaks.finish();
      try {
        fs.writeFileSync(path.join(this.projectDir, `${r.file}.peaks`), encodePeaks(peaks));
      } catch {
        /* peaks are a cache; ignore */
      }
      if (length <= 0) continue;
      if (this.punch) {
        const placed = punchTakeClip({ file: r.file, recordStart: this.recordStart, frames: length }, this.punch, this.project.sampleRate);
        if (placed) takes.push({ trackId: r.trackId, clip: placed.clip, punch: placed.range });
        else this.discardTakeFile(r.file);
        continue;
      }
      takes.push({
        trackId: r.trackId,
        clip: {
          id: uid('clp'),
          file: r.file,
          start: this.recordStart,
          offset: 0,
          length,
          gain: 0,
          fadeIn: 0,
          fadeOut: 0,
        },
      });
    }
    this.recorders = [];
    this.punch = null;
    // Jingles still playing end on the timeline where the recording ends.
    for (const v of this.voices) this.finishJingle(v);
    takes.push(...this.jingleTakes.map(({ trackId, clip }) => ({ trackId, clip })));
    this.jingleTakes = [];
    const report: TakeReport = { recordStart: this.recordStart, events: this.monitor?.events ?? [], writeError: done.error, ...(this.recLoop ? { loop: this.recLoop } : {}) };
    this.recLoop = null;
    this.monitor = null;
    this.journal = null;
    return { takes, report };
  }

  /** A punch pass stopped before its punch-in: the file holds only pre-roll, nothing to keep. */
  private discardTakeFile(file: string): void {
    for (const f of [file, `${file}.peaks`]) {
      try {
        fs.rmSync(path.join(this.projectDir, f), { force: true });
      } catch {
        /* left behind; harmless */
      }
    }
  }

  // ------------------------------------------------------------ soundboard

  /**
   * Stores decoded jingle audio (at the project rate) and writes it once into the project's media
   * folder, so that jingles triggered while recording become ordinary clips on the Soundboard track.
   */
  loadSound(id: string, channels: Float32Array[]): void {
    const file = jingleMediaFile(id, this.project.sampleRate);
    if (this.projectDir) {
      const abs = path.join(this.projectDir, file);
      try {
        const existing = fs.existsSync(abs) ? new WavReader(abs) : null;
        const ok = existing && existing.frames === channels[0].length && existing.info.channels === channels.length;
        existing?.close();
        if (!ok) {
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          writeWavFile(abs, channels, this.project.sampleRate, 24);
        }
      } catch (e) {
        this.reportError(`Could not store jingle: ${(e as Error).message}`);
      }
    }
    this.sounds.set(id, { data: channels, file });
  }

  hasSound(id: string): boolean {
    return this.sounds.has(id);
  }

  /** Starts a jingle; triggering one that is already playing fades it out instead. */
  playSound(id: string): void {
    const playing = this.voices.find((v) => v.slotId === id && !v.stop);
    if (playing) {
      this.stopVoice(playing, JINGLE_STOP_SECONDS);
      return;
    }
    const sound = this.sounds.get(id);
    if (!sound) throw new Error('Sound not loaded');
    if (!this.output) {
      this.reportError('No output device is open, the soundboard is silent.');
      return;
    }
    const slot = this.project.soundboard.find((s) => s.id === id);
    const length = sound.data[0].length;
    this.voices.push({
      slotId: id,
      sound,
      pos: 0,
      played: 0,
      gain: dbToGain(slot?.gain ?? 0),
      loop: !!slot?.loop,
      fadeIn: slot?.fadeIn ? jingleFadeInFrames(length, this.project.sampleRate) : 0,
      stop: null,
      recordStart: this.state === 'recording' ? this.position : undefined,
    });
  }

  /** Plays a sound from the library on the main output (stops the previous one); null stops. */
  previewSound(channels: Float32Array[] | null): boolean {
    if (!channels?.length || !channels[0].length) {
      // a short fade, so stopping mid-sound doesn't click
      if (this.preview) this.preview.stop = Math.min(this.preview.stop, Math.round(0.02 * this.project.sampleRate));
      return false;
    }
    if (!this.output) {
      this.reportError('No output device is open, the preview is silent.');
      return false;
    }
    this.preview = { data: channels, pos: 0, stop: Infinity };
    return true;
  }

  stopSounds(): void {
    for (const v of this.voices) if (!v.stop) this.stopVoice(v, JINGLE_PANIC_SECONDS);
  }

  private stopVoice(v: Voice, seconds: number): void {
    const length = Math.max(1, Math.round(seconds * this.project.sampleRate));
    v.stop = { length, left: length };
  }

  /** Records a jingle that was triggered while recording as clips for the Soundboard track. */
  private finishJingle(v: Voice): void {
    if (v.recordStart === undefined || v.played === 0) return;
    const slot = this.project.soundboard.find((s) => s.id === v.slotId);
    const trackId = soundboardTrack(this.project)?.id ?? SOUNDBOARD_TRACK_ID;
    for (const clip of jingleClips({
      file: v.sound.file,
      fileLength: v.sound.data[0].length,
      start: v.recordStart,
      played: v.played,
      gain: slot?.gain ?? 0,
      fadeIn: v.fadeIn,
      fadeOut: v.stop ? v.stop.length - v.stop.left : 0,
    })) {
      this.jingleTakes.push({ trackId, clip, slotId: v.slotId });
    }
    v.recordStart = undefined;
    if (this.journal) this.journalSaved.rev = -1; // save the journal with this jingle soon
  }

  // ------------------------------------------------------------ audio callbacks

  private onInput(interleaved: Float32Array): void {
    this.lastInputMs = performance.now();
    if (this.inputLost) this.inputRecovered();
    const nch = this.input?.channels ?? 1;
    const frames = Math.floor(interleaved.length / nch);
    interleavedPeaks(interleaved, nch, this.inputPeaks);
    this.mixMinus?.buf.write(interleaved, nch, this.mixMinus.sources);
    this.recordBuffer(interleaved, frames, nch, true);
  }

  /** Adds one buffer to the take; `live` is false for silence written while the input is gone. */
  private recordBuffer(interleaved: Float32Array, frames: number, nch: number, live: boolean): void {
    if (this.state !== 'recording' || this.recorders.length === 0) return;
    // a punch pass ends exactly at punch-out plus post-roll
    let passDone = false;
    if (this.punch) {
      const left = this.punch.until - (this.recordStart + this.recordedFrames);
      if (left <= frames) {
        passDone = true;
        frames = Math.max(0, left);
        interleaved = interleaved.subarray(0, frames * nch);
      }
    }
    if (frames > 0) this.writeBuffer(interleaved, frames, nch, live);
    if (passDone) this.stop();
  }

  private writeBuffer(interleaved: Float32Array, frames: number, nch: number, live: boolean): void {
    // Audio first: hand it to the writer before anything else can go wrong.
    try {
      this.sink?.write(interleaved, frames);
    } catch (e) {
      this.reportError(`Recording failed: ${(e as Error).message}`);
    }
    if (live) this.monitor?.input(interleaved, nch, performance.now());
    else this.monitor?.gap(frames);
    for (const r of this.recorders) {
      if (r.scratch[0].length !== frames) r.scratch = r.channels.map(() => new Float32Array(frames));
      for (let k = 0; k < r.channels.length; k++) {
        const src = r.channels[k];
        const dst = r.scratch[k];
        for (let i = 0; i < frames; i++) dst[i] = interleaved[i * nch + src];
      }
      r.peaks.push(r.scratch, frames);
    }
    this.recordedFrames += frames;
  }

  /** Renders the next output buffer (interleaved, all device output channels). */
  private onOutput(frames: number, nch: number): Float32Array {
    if (this.mixBuf[0].length < frames) this.mixBuf = [new Float32Array(frames), new Float32Array(frames)];
    if (this.sbBuf[0].length < frames) this.sbBuf = [new Float32Array(frames), new Float32Array(frames)];
    if (this.outBuf.length !== frames * nch) this.outBuf = new Float32Array(frames * nch);
    const [L, R] = this.mixBuf;
    const [SL, SR] = this.sbBuf;
    L.fill(0);
    R.fill(0);
    SL.fill(0);
    SR.fill(0);
    this.renderTimeline(frames);
    this.renderVoices(frames);
    const pv = this.renderPreview(frames);
    const out = this.outBuf;
    out.fill(0);
    // gains of the timeline (episode) and the live jingles on the main and the second pair
    const tlMain = this.preShow ? 0 : 1;
    const src2 = this.config.output2Source ?? 'master';
    const tl2 = this.preShow || src2 === 'soundboard' ? 0 : 1;
    const sb2 = src2 === 'episode' ? 0 : 1;
    const first = Math.min(this.config.outputFirstChannel, Math.max(0, nch - 2));
    const second = this.config.output2FirstChannel;
    const has2 = second !== null && second !== undefined && second + 1 < nch && second !== first;
    // the guest feed: live microphones without the guest's own, on top of jingles and playback
    let mm: Float32Array[] | null = null;
    if (src2 === 'mixminus' && this.mixMinus) {
      if (this.mmBuf[0].length < frames) this.mmBuf = [new Float32Array(frames), new Float32Array(frames)];
      mm = this.mmBuf;
      mm[0].fill(0, 0, frames);
      mm[1].fill(0, 0, frames);
      this.mixMinus.buf.readInto(frames, mm[0], mm[1]);
    }
    for (let i = 0; i < frames; i++) {
      const l = L[i] * tlMain + SL[i] + (pv ? pv[0][i] : 0);
      const r = R[i] * tlMain + SR[i] + (pv ? pv[1][i] : 0);
      if (Math.abs(l) > this.outputPeaks[0]) this.outputPeaks[0] = Math.abs(l);
      if (Math.abs(r) > this.outputPeaks[1]) this.outputPeaks[1] = Math.abs(r);
      out[i * nch + first] = l;
      if (nch > 1) out[i * nch + first + 1] = r;
      if (has2) {
        out[i * nch + second] = L[i] * tl2 + SL[i] * sb2 + (mm ? mm[0][i] : 0);
        out[i * nch + second + 1] = R[i] * tl2 + SR[i] * sb2 + (mm ? mm[1][i] : 0);
      }
    }
    return out;
  }

  private renderTimeline(frames: number): void {
    if (this.scrubber) {
      try {
        this.scrubber.render(frames, this.mixBuf);
      } catch (e) {
        this.reportError(`Scrubbing: ${(e as Error).message}`);
        this.scrubber = null;
        return;
      }
      this.playPos = Math.round(this.scrubber.position);
      return;
    }
    if (this.state === 'stopped') return;
    const before = this.playPos;
    this.renderTimelineMix(frames);
    if (this.state === 'playing' && this.markerPing) this.renderPings(before, this.playPos, frames);
  }

  /** Beeps for markers that playback just passed. */
  private renderPings(from: number, to: number, frames: number): void {
    for (const m of markersCrossed(this.project.markers, from, to)) {
      const key = `${this.project.sampleRate}:${m.kind}`;
      let tone = this.pingTones.get(key);
      if (!tone) this.pingTones.set(key, (tone = pingTone(this.project.sampleRate, m.kind)));
      this.pings.push({ tone, pos: 0 });
    }
    if (!this.pings.length) return;
    const [L, R] = this.mixBuf;
    for (const p of this.pings) {
      const n = Math.min(frames, p.tone.length - p.pos);
      for (let i = 0; i < n; i++) {
        const v = p.tone[p.pos + i];
        L[i] += v;
        R[i] += v;
      }
      p.pos += n;
    }
    this.pings = this.pings.filter((p) => p.pos < p.tone.length);
  }

  private renderTimelineMix(frames: number): void {
    const all = audibleTracks(this.project);
    // While recording, don't play back what is being recorded (avoids hearing yourself late);
    // a punch pass plays the armed tracks too, except inside the punch range.
    const unarmed = this.state === 'recording' ? all.filter((t) => !this.armedTrackIds.has(t.id)) : all;
    let tracks = this.punch ? all : unarmed;
    if (this.state === 'playing' && this.speed !== 1) {
      // faster listening: the mix is rendered contiguously and time-stretched, pitch kept
      if (!this.stretcher) {
        this.stretcher = new TimeStretcher(this.project.sampleRate, (pos, n, buf) => this.mixer.render(pos, n, buf, this.stretchTracks), this.speed);
        this.stretcher.reset(this.playPos);
      }
      this.stretchTracks = tracks;
      try {
        this.stretcher.pull(frames, this.mixBuf);
      } catch (e) {
        this.reportError(`Playback: ${(e as Error).message}`);
      }
      this.afterStretch(this.stretcher.position);
      return;
    }
    // While recording this keeps overdub playback moving along with the take.
    for (let done = 0; done < frames && this.transportState !== 'stopped'; ) {
      let n = this.framesUntilJump(frames - done);
      const p = this.state === 'recording' ? this.punch : null;
      if (p) {
        const edge = this.playPos < p.in ? p.in : this.playPos < p.out ? p.out : Infinity;
        n = Math.min(n, edge - this.playPos);
        tracks = this.playPos >= p.in && this.playPos < p.out ? unarmed : all;
      }
      this.renderChunk(n, done, tracks);
      done += n;
      this.advance(n);
    }
  }

  /**
   * Moves the playhead to where the time-stretched playback got to. The stretcher reads ahead in
   * blocks, so the repeat jump and the stop at the end land within one buffer of the exact spot.
   */
  private afterStretch(pos: number): void {
    const wasLooping = this.looping;
    this.playPos = pos;
    if (wasLooping && pos >= this.loop![1]) {
      this.playPos = this.loop![0];
      this.stretcher = null;
    } else if (!wasLooping && pos >= this.clipsEnd()) {
      this.state = 'stopped';
      this.stretcher = null;
      this.stopFallbackClock();
      this.emitTransport();
    }
  }

  /** Mixes `frames` at the playhead into mixBuf starting at `offset` (non-zero after a repeat jump). */
  private renderChunk(frames: number, offset: number, tracks: ReturnType<typeof audibleTracks>): void {
    try {
      if (offset === 0) {
        this.mixer.render(this.playPos, frames, this.mixBuf, tracks);
        return;
      }
      if (this.loopBuf[0].length < frames) this.loopBuf = [new Float32Array(frames), new Float32Array(frames)];
      this.mixer.render(this.playPos, frames, this.loopBuf, tracks);
      this.mixBuf[0].set(this.loopBuf[0].subarray(0, frames), offset);
      this.mixBuf[1].set(this.loopBuf[1].subarray(0, frames), offset);
    } catch (e) {
      this.reportError(`Playback: ${(e as Error).message}`);
    }
  }

  private renderPreview(frames: number): Float32Array[] | null {
    const p = this.preview;
    if (!p) return null;
    if (this.previewBuf[0].length < frames) this.previewBuf = [new Float32Array(frames), new Float32Array(frames)];
    const [L, R] = this.previewBuf;
    L.fill(0);
    R.fill(0);
    const l = p.data[0];
    const r = p.data[1] ?? l;
    const fade = Math.round(0.02 * this.project.sampleRate);
    for (let i = 0; i < frames && p.pos < l.length && p.stop > 0; i++, p.pos++) {
      const g = p.stop < fade ? p.stop-- / fade : 1;
      L[i] = l[p.pos] * g;
      R[i] = r[p.pos] * g;
    }
    if (p.pos >= l.length || p.stop <= 0) this.preview = null;
    return this.previewBuf;
  }

  private renderVoices(frames: number): void {
    if (this.voices.length === 0) return;
    const [L, R] = this.sbBuf;
    for (const v of this.voices) {
      const l = v.sound.data[0];
      const r = v.sound.data[1] ?? l;
      const len = l.length;
      for (let i = 0; i < frames; i++) {
        if (v.pos >= len) {
          if (!v.loop || len === 0) break;
          v.pos = 0;
        }
        if (v.stop && v.stop.left <= 0) break;
        let g = v.gain;
        if (v.played < v.fadeIn) g *= v.played / v.fadeIn;
        if (v.stop) g *= v.stop.left-- / v.stop.length;
        L[i] += l[v.pos] * g;
        R[i] += r[v.pos] * g;
        v.pos++;
        v.played++;
      }
    }
    this.voices = this.voices.filter((v) => {
      const done = (v.stop && v.stop.left <= 0) || (!v.loop && v.pos >= v.sound.data[0].length);
      if (done) this.finishJingle(v);
      return !done;
    });
  }

  private startFallbackClock(): void {
    this.stopFallbackClock();
    let last = performance.now();
    this.fallbackClock = setInterval(() => {
      const now = performance.now();
      const frames = Math.round(((now - last) / 1000) * this.project.sampleRate);
      last = now;
      for (let left = this.state === 'playing' && !this.scrubber ? Math.round(frames * this.speed) : 0; this.state === 'playing' && left > 0; ) {
        const n = this.framesUntilJump(left);
        this.advance(n);
        left -= n;
      }
    }, 20);
  }

  private stopFallbackClock(): void {
    if (this.fallbackClock) clearInterval(this.fallbackClock);
    this.fallbackClock = null;
  }

  // ------------------------------------------------------------ meters

  private startMeters(): void {
    if (this.meterTimer) return;
    this.meterTimer = setInterval(() => this.emitTransport(), 1000 / METER_HZ);
  }

  private emitTransport(): void {
    const update: TransportUpdate = {
      state: this.state,
      position: this.position,
      inputPeaks: [...this.inputPeaks],
      outputPeaks: [...this.outputPeaks],
      recordedFrames: this.recordedFrames,
    };
    if (this.state === 'recording' && this.punch) update.punch = [this.punch.in, this.punch.out];
    if (this.state === 'recording') {
      update.recordingPeaks = this.takeLivePeaks();
      if (this.recLoop) update.recordLoop = this.recLoop;
      update.health = this.checkHealth();
      if (this.jingleTakes.length) {
        update.recordedJingles = this.jingleTakes.map((t) => ({ slotId: t.slotId, start: t.clip.start, length: t.clip.length }));
      }
    }
    if (this.state !== 'stopped') {
      const meters = this.mixer.takeFxMeters();
      if (Object.keys(meters).length) update.fxMeters = meters;
      update.trackPeaks = this.mixer.takeTrackPeaks();
    }
    if (this.preview) update.preview = { pos: this.preview.pos, length: this.preview.data[0].length };
    if (this.voices.length) update.jingles = this.voices.map((v): PlayingJingle => ({
      slotId: v.slotId,
      remaining: Math.max(0, v.sound.data[0].length - v.pos),
      recordStart: v.recordStart,
      played: v.played,
      stopping: !!v.stop,
    }));
    this.inputPeaks.fill(0);
    this.outputPeaks = [0, 0];
    this.emit('transport', update);
  }

  /** Feeds the monitor with the writer's and the disk's state, and keeps the journal current. */
  private checkHealth(): RecordingHealth | undefined {
    const m = this.monitor;
    if (!m) return undefined;
    const now = performance.now();
    if (now - this.freeBytes.at > DISK_CHECK_MS) this.freeBytes = { value: this.freeSpace(this.projectDir), at: now };
    const ws = this.sink?.status();
    m.tick(now, {
      queuedBytes: ws?.queuedBytes ?? 0,
      error: ws ? ws.error : 'Nothing is being written',
      droppedFrames: ws?.droppedFrames ?? 0,
      freeBytes: this.freeBytes.value,
    });
    const j = this.journal;
    if (j && (m.revision !== this.journalSaved.rev) && now - this.journalSaved.at > JOURNAL_SAVE_MS) {
      j.events = m.events;
      j.jingles = this.jingleTakes.map(({ trackId, clip }) => ({ trackId, clip }));
      try {
        writeJournal(this.projectDir, j);
      } catch {
        /* the disk is in trouble; the monitor already says so */
      }
      this.journalSaved = { rev: m.revision, at: now };
    }
    const health = m.health(now);
    // The watchdog can notice a lost device before the monitor does (or the monitor never does,
    // because the engine writes silence meanwhile): either way it is one critical problem.
    const lost = this.inputLost;
    if (lost) {
      const name = this.inputDevice?.name ?? 'the input device';
      health.warnings = health.warnings.filter((w) => w.key !== 'stall');
      health.warnings.unshift({
        key: 'input-lost',
        level: 'critical',
        text: `No audio from "${name}" for ${formatMinutes((now - lost.since) / 1000)}. Is it still connected and switched on? WavePod reconnects as soon as it is back; the recording goes on with silence meanwhile.`,
      });
    }
    return health;
  }

  private takeLivePeaks(): LivePeaks[] {
    return this.recorders.map((r) => {
      const from = r.sentBuckets;
      const data = r.peaks.bucketsFrom(from);
      r.sentBuckets = r.peaks.bucketCount;
      return { trackId: r.trackId, samplesPerPeak: r.peaks.samplesPerPeak, from, data };
    });
  }

  // ------------------------------------------------------------ waveforms

  private absPath(file: string): string {
    return path.isAbsolute(file) ? file : path.join(this.projectDir, file);
  }

  /** Layout of the up-to-date peak file of `abs`, computing it first if needed. */
  private peakLayout(abs: string): PeakFileLayout | null {
    const cache = `${abs}.peaks`;
    let wavStat: fs.Stats;
    try {
      wavStat = fs.statSync(abs);
    } catch {
      return null;
    }
    const known = this.peakLayouts.get(abs);
    if (known && known.mtimeMs === wavStat.mtimeMs) return known.layout;
    let layout: PeakFileLayout | null = null;
    try {
      if (fs.statSync(cache).mtimeMs >= wavStat.mtimeMs) layout = readPeakHeader(cache);
    } catch {
      /* no cache yet */
    }
    if (!layout) {
      // missing, stale or from before multi-resolution peaks: (re)compute
      const peaks = computePeaks(abs);
      if (!peaks) return null;
      try {
        fs.writeFileSync(cache, encodePeaks(peaks));
        layout = readPeakHeader(cache);
      } catch {
        layout = null;
      }
      if (!layout) return null;
    }
    this.peakLayouts.set(abs, { mtimeMs: wavStat.mtimeMs, layout });
    return layout;
  }

  /** The coarse levels of a file's waveform; finer ones are listed as tiled. */
  getPeaks(file: string): WaveformPeaks | null {
    const abs = this.absPath(file);
    const layout = this.peakLayout(abs);
    if (!layout) return null;
    const coarse = layout.levels.filter((l) => l.samplesPerPeak > TILED_MAX_SPP);
    const tiled = layout.levels.filter((l) => l.samplesPerPeak <= TILED_MAX_SPP).map((l) => l.samplesPerPeak);
    const fd = fs.openSync(`${abs}.peaks`, 'r');
    try {
      const levels = coarse.map((l) => {
        const data = new Int8Array(l.buckets * 2);
        fs.readSync(fd, data, 0, data.length, l.offset);
        return { samplesPerPeak: l.samplesPerPeak, data };
      });
      return { length: layout.length, levels, tiled };
    } finally {
      fs.closeSync(fd);
    }
  }

  /** PEAK_TILE buckets of one level, read from the peak file. */
  getPeakTile(file: string, samplesPerPeak: number, tile: number): Int8Array | null {
    const abs = this.absPath(file);
    const level = this.peakLayout(abs)?.levels.find((l) => l.samplesPerPeak === samplesPerPeak);
    if (!level || tile < 0) return null;
    const first = tile * PEAK_TILE;
    const n = Math.min(PEAK_TILE, level.buckets - first);
    if (n <= 0) return new Int8Array(0);
    const data = new Int8Array(n * 2);
    const fd = fs.openSync(`${abs}.peaks`, 'r');
    try {
      fs.readSync(fd, data, 0, data.length, level.offset + first * 2);
    } finally {
      fs.closeSync(fd);
    }
    return data;
  }

  /** SAMPLE_TILE mono samples of a file, for drawing single samples. */
  getSampleTile(file: string, tile: number): Float32Array | null {
    const reader = this.readers.get(file);
    if (!reader || tile < 0) return null;
    const start = tile * SAMPLE_TILE;
    const n = Math.min(SAMPLE_TILE, reader.frames - start);
    if (n <= 0) return new Float32Array(0);
    return mixToMono(reader.read(start, n), n);
  }

  dispose(): void {
    if (this.state !== 'stopped') this.stop();
    if (this.meterTimer) clearInterval(this.meterTimer);
    this.meterTimer = null;
    this.closeStreams();
    this.readers.closeAll();
    this.native?.dispose();
  }
}

export function computePeaks(absPath: string): WaveformPeaks | null {
  let reader: WavReader;
  try {
    reader = new WavReader(absPath);
  } catch {
    return null;
  }
  try {
    const pb = new MipmapBuilder(undefined, undefined, undefined, reader.frames);
    const chunk = 256 * 1024;
    let buf: Float32Array[] | undefined;
    for (let pos = 0; pos < reader.frames; pos += chunk) {
      const n = Math.min(chunk, reader.frames - pos);
      buf = reader.read(pos, n, buf);
      pb.push(buf, n);
    }
    return pb.finish();
  } finally {
    reader.close();
  }
}

function readPeakHeader(file: string): PeakFileLayout | null {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(size, headerSize(32)));
    fs.readSync(fd, head, 0, head.length, 0);
    return parsePeakHeader(head, size);
  } finally {
    fs.closeSync(fd);
  }
}
