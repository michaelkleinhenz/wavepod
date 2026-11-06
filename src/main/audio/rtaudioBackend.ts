// Native multichannel audio via RtAudio (audify): CoreAudio, WASAPI/DirectSound/ASIO, ALSA/PulseAudio/JACK.
import type { AudioApiInfo, AudioDevice } from '../../shared/types';
import type { AudioBackend, InputStreamOptions, OutputStreamOptions, StreamHandle } from './backend';
import { bufferToFloat32, float32ToBuffer } from '../../core/dsp';
import { clampVirtualAlsaDevices, friendlyStreamError, throttleErrors, USE_PULSE_HINT } from './linuxAudio';

// Values of audify's RtAudioApi / RtAudioFormat const enums.
const API_IDS: Record<string, number> = {
  default: 0,
  coreaudio: 1,
  alsa: 2,
  jack: 3,
  pulse: 4,
  asio: 6,
  wasapi: 7,
  directsound: 8,
};
const API_LABELS: Record<string, string> = {
  default: 'System default',
  coreaudio: 'Core Audio',
  alsa: 'ALSA',
  jack: 'JACK',
  pulse: 'PulseAudio / PipeWire',
  asio: 'ASIO',
  wasapi: 'WASAPI',
  directsound: 'DirectSound',
};
// RtAudio::getApiDisplayName() for each API, lower-cased.
const API_NAMES: Record<string, string> = {
  coreaudio: 'coreaudio',
  alsa: 'alsa',
  jack: 'jack',
  pulse: 'pulse',
  asio: 'asio',
  wasapi: 'wasapi',
  directsound: 'directsound',
};
const RTAUDIO_FLOAT32 = 0x10;
// Output buffers kept queued ahead of the device (latency vs. dropout margin).
const QUEUE_BUFFERS = 4;
const MAX_WRITES_PER_PUMP = 8;

type Audify = typeof import('audify');
type RtAudioInstance = InstanceType<Audify['RtAudio']>;

function platformApis(): string[] {
  switch (process.platform) {
    case 'darwin':
      return ['coreaudio'];
    case 'win32':
      return ['wasapi', 'asio', 'directsound'];
    default:
      return ['alsa', 'pulse', 'jack'];
  }
}

export class RtAudioBackend implements AudioBackend {
  readonly name = 'RtAudio';
  private audify: Audify;
  private _api = 'default';
  private probe: RtAudioInstance | null = null;
  /** Whether a PulseAudio (or PipeWire) server answered at the last device scan. */
  private serverRunning = false;
  /** Channels of the sound server's default input/output, for ALSA's plug-in devices. */
  private serverDefaults: { inputChannels: number; outputChannels: number } | null = null;

  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    this.audify = require('audify') as Audify;
  }

  get api(): string {
    return this._api;
  }

  listApis(): AudioApiInfo[] {
    return ['default', ...this.compiledApis()].map((id) => ({
      id,
      label: id === 'default' && process.platform === 'linux' && this.compiledApis().includes('pulse') ? 'System default (PipeWire / PulseAudio when running)' : (API_LABELS[id] ?? id),
    }));
  }

  private compiled: string[] | null = null;

  /**
   * The platform APIs this audify build actually supports. RtAudio silently
   * falls back to another API for one it wasn't compiled with (e.g. JACK when
   * its headers were missing), so ask each one which API it really opened.
   */
  private compiledApis(): string[] {
    if (!this.compiled) {
      this.compiled = platformApis().filter((id) => {
        const name = safe(() => new this.audify.RtAudio(API_IDS[id] as never).getApi(), '');
        return name.toLowerCase() === API_NAMES[id];
      });
    }
    return this.compiled;
  }

  setApi(api: string): void {
    if (!(api in API_IDS)) throw new Error(`Unknown audio API ${api}`);
    if (api !== 'default' && !this.compiledApis().includes(api)) {
      throw new Error(`${API_LABELS[api] ?? api} is not available in this build; using the system default`);
    }
    this._api = api;
    this.probe = null;
  }

  /**
   * The API streams really use. RtAudio's own default on Linux is ALSA (the
   * first API it was built with), which can't reach sound cards that PipeWire
   * or PulseAudio hold; so "System default" means PulseAudio/PipeWire whenever
   * such a server is running.
   */
  private effectiveApi(): string {
    if (this._api !== 'default' || process.platform !== 'linux') return this._api;
    if (this.compiledApis().includes('pulse') && this.serverRunning) return 'pulse';
    return this.compiledApis().includes('alsa') ? 'alsa' : 'default';
  }

  private create(): RtAudioInstance {
    return new this.audify.RtAudio(API_IDS[this.effectiveApi()] as never);
  }

  /** Asks the PulseAudio API (PipeWire's pulse server answers it too) whether a server runs, and its default devices. */
  private probeSoundServer(): void {
    this.serverRunning = false;
    this.serverDefaults = null;
    if (process.platform !== 'linux' || !this.compiledApis().includes('pulse')) return;
    const rt = safe(() => new this.audify.RtAudio(API_IDS.pulse as never), null);
    if (!rt) return;
    const devices = safe(() => rt.getDevices(), []);
    if (!devices.length) return;
    this.serverRunning = true;
    const defIn = safe(() => rt.getDefaultInputDevice(), -1);
    const defOut = safe(() => rt.getDefaultOutputDevice(), -1);
    const input = devices.find((d) => d.isDefaultInput || d.id === defIn);
    const output = devices.find((d) => d.isDefaultOutput || d.id === defOut);
    this.serverDefaults = { inputChannels: input?.inputChannels ?? 0, outputChannels: output?.outputChannels ?? 0 };
  }

  /** A hint for the Setup view about the chosen API, or null. */
  notice(): string | null {
    return this.effectiveApi() === 'alsa' && this.serverRunning ? USE_PULSE_HINT : null;
  }

  private streamError(onError: ((message: string) => void) | undefined): (message: string) => void {
    const report = throttleErrors(onError);
    return (msg) => report(friendlyStreamError(msg, { api: this.effectiveApi(), serverRunning: this.serverRunning }));
  }

  listDevices(): AudioDevice[] {
    this.probeSoundServer();
    // A fresh instance picks up hot-plugged devices.
    this.probe = this.create();
    const defIn = safe(() => this.probe!.getDefaultInputDevice(), -1);
    const defOut = safe(() => this.probe!.getDefaultOutputDevice(), -1);
    const devices = this.probe.getDevices().map((d) => ({
      id: d.id,
      name: d.name,
      inputChannels: d.inputChannels,
      outputChannels: d.outputChannels,
      sampleRates: d.sampleRates,
      preferredSampleRate: d.preferredSampleRate,
      isDefaultInput: !!d.isDefaultInput || d.id === defIn,
      isDefaultOutput: !!d.isDefaultOutput || d.id === defOut,
    }));
    return this.effectiveApi() === 'alsa' ? clampVirtualAlsaDevices(devices, this.serverDefaults) : devices;
  }

  openInput(opts: InputStreamOptions): StreamHandle {
    const rt = this.create();
    const onError = this.streamError(opts.onError);
    const frameSize = this.open(rt, () => rt.openStream(
      null,
      { deviceId: opts.deviceId, nChannels: opts.channels, firstChannel: 0 },
      RTAUDIO_FLOAT32 as never,
      opts.sampleRate,
      opts.frameSize,
      'WavePod Input',
      (pcm: Buffer) => guard(() => opts.onData(bufferToFloat32(pcm)), opts.onError),
      null,
      0 as never,
      (_type: unknown, msg: string) => onError(msg),
    ));
    return handle(rt, opts.channels, opts.sampleRate, frameSize || opts.frameSize);
  }

  openOutput(opts: OutputStreamOptions): StreamHandle {
    const rt = this.create();
    const onError = this.streamError(opts.onError);
    let frameSize = opts.frameSize;
    // audify plays from a queue we fill with write() and calls us back once per
    // buffer it consumed. When the queue is empty it plays silence and does not
    // call back, so answering each callback with one buffer loses a buffer for
    // good every time we are late: playback then runs slow and crackles. Keep
    // the queue topped up against the stream clock instead, from the callback
    // and from a timer.
    let written = 0; // frames handed to audify
    let closed = false;
    const writeNext = () => {
      const data = opts.pull(frameSize);
      rt.write(float32ToBuffer(data));
      written += frameSize;
    };
    const pump = () => {
      if (closed) return;
      const played = Math.floor(safe(() => rt.streamTime, 0) * opts.sampleRate);
      // After an underrun the device has moved on; don't try to catch up on
      // audio it already replaced with silence.
      if (written < played) written = played;
      for (let i = 0; i < MAX_WRITES_PER_PUMP && written - played < QUEUE_BUFFERS * frameSize; i++) writeNext();
    };
    frameSize =
      this.open(rt, () => rt.openStream(
        { deviceId: opts.deviceId, nChannels: opts.channels, firstChannel: 0 },
        null,
        RTAUDIO_FLOAT32 as never,
        opts.sampleRate,
        opts.frameSize,
        'WavePod Output',
        null,
        () => guard(pump, opts.onError),
        0 as never,
        (_type: unknown, msg: string) => onError(msg),
      )) || opts.frameSize;
    pump();
    const periodMs = (frameSize / opts.sampleRate) * 1000;
    const timer = setInterval(() => guard(pump, opts.onError), Math.max(2, Math.floor(periodMs / 2)));
    const h = handle(rt, opts.channels, opts.sampleRate, frameSize);
    return {
      ...h,
      close() {
        closed = true;
        clearInterval(timer);
        h.close();
      },
    };
  }

  /**
   * Opens and starts a stream. If starting fails, the opened stream is closed
   * again instead of being left to the garbage collector; the error says what
   * failed in words a user can act on.
   */
  private open(rt: RtAudioInstance, openStream: () => number): number {
    let frameSize: number;
    try {
      frameSize = openStream();
      rt.start();
    } catch (e) {
      safe(() => rt.isStreamOpen() && rt.closeStream(), undefined);
      const message = (e as Error).message ?? String(e);
      throw new Error(friendlyStreamError(message, { api: this.effectiveApi(), serverRunning: this.serverRunning }));
    }
    return frameSize;
  }

  dispose(): void {
    this.probe = null;
  }
}

function handle(rt: RtAudioInstance, channels: number, sampleRate: number, frameSize: number): StreamHandle {
  let closed = false;
  return {
    channels,
    sampleRate: safe(() => rt.getStreamSampleRate(), sampleRate) || sampleRate,
    frameSize,
    close() {
      if (closed) return;
      closed = true;
      safe(() => rt.isStreamRunning() && rt.stop(), undefined);
      safe(() => rt.isStreamOpen() && rt.closeStream(), undefined);
    },
  };
}

/**
 * Runs a callback that audify invokes from its audio threads. audify is built
 * with C++ exceptions, so a JS exception escaping such a callback becomes an
 * uncaught Napi::Error and aborts the whole app (SIGABRT). Report it instead.
 */
function guard(fn: () => void, onError?: (message: string) => void): void {
  try {
    fn();
  } catch (e) {
    onError?.((e as Error).message ?? String(e));
  }
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
