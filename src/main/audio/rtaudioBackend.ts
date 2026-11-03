// Native multichannel audio via RtAudio (audify): CoreAudio, WASAPI/DirectSound/ASIO, ALSA/PulseAudio/JACK.
import type { AudioApiInfo, AudioDevice } from '../../shared/types';
import type { AudioBackend, InputStreamOptions, OutputStreamOptions, StreamHandle } from './backend';
import { bufferToFloat32, float32ToBuffer } from '../../core/dsp';

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
const RTAUDIO_FLOAT32 = 0x10;
const PREFILL_BUFFERS = 3;

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

  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    this.audify = require('audify') as Audify;
  }

  get api(): string {
    return this._api;
  }

  listApis(): AudioApiInfo[] {
    return ['default', ...platformApis()].map((id) => ({ id, label: API_LABELS[id] ?? id }));
  }

  setApi(api: string): void {
    if (!(api in API_IDS)) throw new Error(`Unknown audio API ${api}`);
    this._api = api;
    this.probe = null;
  }

  private create(): RtAudioInstance {
    return new this.audify.RtAudio(API_IDS[this._api] as never);
  }

  listDevices(): AudioDevice[] {
    // A fresh instance picks up hot-plugged devices.
    this.probe = this.create();
    const defIn = safe(() => this.probe!.getDefaultInputDevice(), -1);
    const defOut = safe(() => this.probe!.getDefaultOutputDevice(), -1);
    return this.probe.getDevices().map((d) => ({
      id: d.id,
      name: d.name,
      inputChannels: d.inputChannels,
      outputChannels: d.outputChannels,
      sampleRates: d.sampleRates,
      preferredSampleRate: d.preferredSampleRate,
      isDefaultInput: !!d.isDefaultInput || d.id === defIn,
      isDefaultOutput: !!d.isDefaultOutput || d.id === defOut,
    }));
  }

  openInput(opts: InputStreamOptions): StreamHandle {
    const rt = this.create();
    const frameSize = rt.openStream(
      null,
      { deviceId: opts.deviceId, nChannels: opts.channels, firstChannel: 0 },
      RTAUDIO_FLOAT32 as never,
      opts.sampleRate,
      opts.frameSize,
      'WavePod Input',
      (pcm: Buffer) => opts.onData(bufferToFloat32(pcm)),
      null,
      0 as never,
      (_type: unknown, msg: string) => opts.onError?.(msg),
    );
    rt.start();
    return handle(rt, opts.channels, opts.sampleRate, frameSize || opts.frameSize);
  }

  openOutput(opts: OutputStreamOptions): StreamHandle {
    const rt = this.create();
    let frameSize = opts.frameSize;
    const writeNext = () => {
      const data = opts.pull(frameSize);
      rt.write(float32ToBuffer(data));
    };
    frameSize =
      rt.openStream(
        { deviceId: opts.deviceId, nChannels: opts.channels, firstChannel: 0 },
        null,
        RTAUDIO_FLOAT32 as never,
        opts.sampleRate,
        opts.frameSize,
        'WavePod Output',
        null,
        () => writeNext(),
        0 as never,
        (_type: unknown, msg: string) => opts.onError?.(msg),
      ) || opts.frameSize;
    rt.start();
    for (let i = 0; i < PREFILL_BUFFERS; i++) writeNext();
    return handle(rt, opts.channels, opts.sampleRate, frameSize);
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
      safe(() => rt.closeStream(), undefined);
    },
  };
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
