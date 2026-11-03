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
  Project,
  RecordedTake,
  TransportState,
  TransportUpdate,
  WaveformPeaks,
} from '../../shared/types';
import { dbToGain, uid } from '../../shared/time';
import { interleavedPeaks } from '../../core/dsp';
import { MipmapBuilder, PEAK_TILE, SAMPLE_TILE, TILED_MAX_SPP, encodePeaks, headerSize, mixToMono, parsePeakHeader, type PeakFileLayout } from '../../core/peaks';
import { Mixer, ReaderCache, audibleTracks } from '../../core/mixer';
import { createProject } from '../../core/project';
import {
  JINGLE_PANIC_SECONDS,
  JINGLE_STOP_SECONDS,
  SOUNDBOARD_TRACK_ID,
  jingleClips,
  jingleFadeInFrames,
  jingleMediaFile,
  soundboardTrack,
} from '../../core/soundboard';
import { WavReader, WavWriter, writeWavFile } from '../../core/wav';
import type { AudioBackend, StreamHandle } from './backend';
import { SimulatedBackend } from './simulatedBackend';

export const VIRTUAL_API = 'virtual';
const METER_HZ = 30;

interface Recorder {
  trackId: string;
  channels: number[];
  writer: WavWriter;
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
  private error: string | null = null;

  project: Project = createProject();
  projectDir = '';
  private readers = new ReaderCache('');
  /** Peak file layouts by absolute media path, with the media file's mtime they belong to. */
  private peakLayouts = new Map<string, { mtimeMs: number; layout: PeakFileLayout }>();
  private mixer = Object.assign(new Mixer(this.project, this.readers), { metering: true });

  private state: TransportState = 'stopped';
  private playPos = 0;
  private recordStart = 0;
  private recordedFrames = 0;
  private recorders: Recorder[] = [];
  private armedTrackIds = new Set<string>();

  private inputPeaks: number[] = [];
  private outputPeaks = [0, 0];
  private mixBuf: Float32Array[] = [new Float32Array(0), new Float32Array(0)];
  private outBuf = new Float32Array(0);
  private sounds = new Map<string, Sound>();
  private jingleTakes: Array<RecordedTake & { slotId: string }> = [];
  private voices: Voice[] = [];
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
    };
  }

  /** Applies a device configuration, (re)opening streams. Never throws; errors land in status().error. */
  applyConfig(next: Partial<DeviceConfig>): EngineStatus {
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
      try {
        this.input = this.backend().openInput({
          deviceId: inDev.id,
          channels: inDev.inputChannels,
          sampleRate: this.config.sampleRate,
          frameSize: this.config.bufferSize,
          onData: (d) => this.onInput(d),
          onError: (m) => this.reportError(`Input: ${m}`),
        });
        this.inputPeaks = new Array(inDev.inputChannels).fill(0);
      } catch (e) {
        errors.push(`Could not open input "${inDev.name}": ${(e as Error).message}`);
      }
    }
    if (outDev) {
      try {
        if (this.config.outputFirstChannel + 2 > outDev.outputChannels) this.config.outputFirstChannel = 0;
        this.output = this.backend().openOutput({
          deviceId: outDev.id,
          channels: outDev.outputChannels,
          sampleRate: this.config.sampleRate,
          frameSize: this.config.bufferSize,
          pull: (n) => this.onOutput(n),
          onError: (m) => this.reportError(`Output: ${m}`),
        });
      } catch (e) {
        errors.push(`Could not open output "${outDev.name}": ${(e as Error).message}`);
      }
    }
    if (errors.length) this.error = [this.error, ...errors].filter(Boolean).join('\n');
    this.startMeters();
    const s = this.status();
    this.emit('status', s);
    return s;
  }

  reportError(message: string): void {
    this.error = message;
    this.emit('status', this.status());
  }

  private closeStreams(): void {
    this.input?.close();
    this.output?.close();
    this.input = null;
    this.output = null;
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
    this.armedTrackIds = new Set(project.tracks.filter((t) => t.armed).map((t) => t.id));
  }

  // ------------------------------------------------------------ transport

  get transportState(): TransportState {
    return this.state;
  }

  get position(): number {
    return this.state === 'recording' ? this.recordStart + this.recordedFrames : this.playPos;
  }

  seek(position: number): void {
    if (this.state === 'recording') return;
    this.playPos = Math.max(0, Math.round(position));
    this.emitTransport();
  }

  play(from?: number): void {
    if (this.state === 'recording') return;
    if (from !== undefined) this.playPos = Math.max(0, Math.round(from));
    this.state = 'playing';
    if (!this.output) this.startFallbackClock();
    this.emitTransport();
  }

  /** Starts recording all armed tracks at the playhead. Returns the files being written. */
  record(): string[] {
    if (this.state === 'recording') return this.recorders.map((r) => r.file);
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
    const stamp = timestamp();
    this.recorders = armed.map((t) => {
      let rel = path.join('media', `${safeFileName(t.name)}-${stamp}.wav`);
      for (let i = 2; fs.existsSync(path.join(this.projectDir, rel)); i++) {
        rel = path.join('media', `${safeFileName(t.name)}-${stamp}-${i}.wav`);
      }
      const abs = path.join(this.projectDir, rel);
      return {
        trackId: t.id,
        channels: [...t.inputChannels],
        writer: new WavWriter(abs, t.inputChannels.length, sr, this.project.bitDepth),
        peaks: new MipmapBuilder(),
        file: rel.split(path.sep).join('/'),
        scratch: t.inputChannels.map(() => new Float32Array(0)),
        sentBuckets: 0,
      };
    });
    this.recordStart = this.playPos;
    this.recordedFrames = 0;
    this.jingleTakes = [];
    this.state = 'recording';
    this.emitTransport();
    return this.recorders.map((r) => r.file);
  }

  stop(): RecordedTake[] {
    const wasRecording = this.state === 'recording';
    this.stopFallbackClock();
    let takes: RecordedTake[] = [];
    if (wasRecording) {
      takes = this.finishRecording();
      this.playPos = this.recordStart + this.recordedFrames;
    }
    this.state = 'stopped';
    this.emitTransport();
    if (takes.length) this.emit('recordingFinished', takes);
    return takes;
  }

  private finishRecording(): RecordedTake[] {
    const takes: RecordedTake[] = [];
    for (const r of this.recorders) {
      r.writer.close();
      const peaks = r.peaks.finish();
      try {
        fs.writeFileSync(path.join(this.projectDir, `${r.file}.peaks`), encodePeaks(peaks));
      } catch {
        /* peaks are a cache; ignore */
      }
      if (r.writer.framesWritten === 0) continue;
      takes.push({
        trackId: r.trackId,
        clip: {
          id: uid('clp'),
          file: r.file,
          start: this.recordStart,
          offset: 0,
          length: r.writer.framesWritten,
          gain: 0,
          fadeIn: 0,
          fadeOut: 0,
        },
      });
    }
    this.recorders = [];
    // Jingles still playing end on the timeline where the recording ends.
    for (const v of this.voices) this.finishJingle(v);
    takes.push(...this.jingleTakes.map(({ trackId, clip }) => ({ trackId, clip })));
    this.jingleTakes = [];
    return takes;
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
  }

  // ------------------------------------------------------------ audio callbacks

  private onInput(interleaved: Float32Array): void {
    const nch = this.input?.channels ?? 1;
    const frames = Math.floor(interleaved.length / nch);
    interleavedPeaks(interleaved, nch, this.inputPeaks);
    if (this.state !== 'recording' || this.recorders.length === 0) return;
    for (const r of this.recorders) {
      if (r.scratch[0].length !== frames) r.scratch = r.channels.map(() => new Float32Array(frames));
      for (let k = 0; k < r.channels.length; k++) {
        const src = r.channels[k];
        const dst = r.scratch[k];
        for (let i = 0; i < frames; i++) dst[i] = interleaved[i * nch + src];
      }
      try {
        r.writer.write(r.scratch, frames);
      } catch (e) {
        this.reportError(`Recording failed: ${(e as Error).message}`);
      }
      r.peaks.push(r.scratch, frames);
    }
    this.recordedFrames += frames;
  }

  /** Renders the next output buffer (interleaved, all device output channels). */
  private onOutput(frames: number): Float32Array {
    const nch = this.output?.channels ?? 2;
    if (this.mixBuf[0].length < frames) this.mixBuf = [new Float32Array(frames), new Float32Array(frames)];
    if (this.outBuf.length !== frames * nch) this.outBuf = new Float32Array(frames * nch);
    const [L, R] = this.mixBuf;
    L.fill(0);
    R.fill(0);
    this.renderTimeline(frames);
    this.renderVoices(frames);
    const out = this.outBuf;
    out.fill(0);
    const first = Math.min(this.config.outputFirstChannel, Math.max(0, nch - 2));
    for (let i = 0; i < frames; i++) {
      const l = L[i];
      const r = R[i];
      if (Math.abs(l) > this.outputPeaks[0]) this.outputPeaks[0] = Math.abs(l);
      if (Math.abs(r) > this.outputPeaks[1]) this.outputPeaks[1] = Math.abs(r);
      out[i * nch + first] = l;
      if (nch > 1) out[i * nch + first + 1] = r;
    }
    return out;
  }

  private renderTimeline(frames: number): void {
    if (this.state === 'stopped') return;
    let tracks = audibleTracks(this.project);
    // While recording, don't play back what is being recorded (avoids hearing yourself late).
    if (this.state === 'recording') tracks = tracks.filter((t) => !this.armedTrackIds.has(t.id));
    try {
      this.mixer.render(this.playPos, frames, this.mixBuf, tracks);
    } catch (e) {
      this.reportError(`Playback: ${(e as Error).message}`);
    }
    // While recording this keeps overdub playback moving along with the take.
    this.playPos += frames;
  }

  private renderVoices(frames: number): void {
    if (this.voices.length === 0) return;
    const [L, R] = this.mixBuf;
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
      if (this.state === 'playing') this.playPos += frames;
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
    if (this.state === 'recording') {
      update.recordingPeaks = this.takeLivePeaks();
      if (this.jingleTakes.length) {
        update.recordedJingles = this.jingleTakes.map((t) => ({ slotId: t.slotId, start: t.clip.start, length: t.clip.length }));
      }
    }
    if (this.state !== 'stopped') {
      const meters = this.mixer.takeFxMeters();
      if (Object.keys(meters).length) update.fxMeters = meters;
      update.trackPeaks = this.mixer.takeTrackPeaks();
    }
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
