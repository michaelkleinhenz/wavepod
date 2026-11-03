// Virtual interfaces for demos, tests and machines without the native module.
// Inputs produce speech-like modulated tones so meters, recording and waveforms can be tried without hardware.
import type { AudioApiInfo, AudioDevice } from '../../shared/types';
import type { AudioBackend, InputStreamOptions, OutputStreamOptions, StreamHandle } from './backend';

interface VirtualDevice extends AudioDevice {
  /** Channels that carry a signal (others are silent). */
  live: number[];
}

const DEVICES: VirtualDevice[] = [
  {
    id: 1,
    name: 'Virtual RØDECaster Pro II',
    inputChannels: 16,
    outputChannels: 2,
    sampleRates: [44100, 48000],
    preferredSampleRate: 48000,
    isDefaultInput: true,
    isDefaultOutput: false,
    live: [0, 1, 2, 3, 4, 12, 13],
  },
  {
    id: 2,
    name: 'Virtual 4-channel interface',
    inputChannels: 4,
    outputChannels: 4,
    sampleRates: [44100, 48000, 96000],
    preferredSampleRate: 48000,
    isDefaultInput: false,
    isDefaultOutput: true,
    live: [0, 1, 2, 3],
  },
];

/** Deterministic signal generator per channel. */
export function virtualSample(channel: number, frame: number, sampleRate: number): number {
  const t = frame / sampleRate;
  const f = 110 + channel * 37;
  // syllable-rate envelope with pauses, offset per channel so speakers alternate
  const syll = Math.max(0, Math.sin(2 * Math.PI * (3 + channel * 0.3) * t + channel));
  const phrase = Math.sin(2 * Math.PI * 0.11 * t + channel * 0.9) > -0.2 ? 1 : 0;
  const env = syll * phrase * 0.35;
  return env * (Math.sin(2 * Math.PI * f * t) * 0.7 + Math.sin(2 * Math.PI * f * 2.01 * t) * 0.3);
}

export class SimulatedBackend implements AudioBackend {
  readonly name = 'Simulated';
  readonly api = 'virtual';

  listApis(): AudioApiInfo[] {
    return [{ id: 'virtual', label: 'Virtual devices' }];
  }

  setApi(): void {}

  listDevices(): AudioDevice[] {
    return DEVICES.map(({ live: _live, ...d }) => ({ ...d }));
  }

  private device(id: number): VirtualDevice {
    const d = DEVICES.find((x) => x.id === id);
    if (!d) throw new Error(`No virtual device with id ${id}`);
    return d;
  }

  openInput(opts: InputStreamOptions): StreamHandle {
    const dev = this.device(opts.deviceId);
    if (opts.channels > dev.inputChannels) throw new Error(`${dev.name} has only ${dev.inputChannels} inputs`);
    const live = new Set(dev.live);
    const buf = new Float32Array(opts.frameSize * opts.channels);
    let frame = 0;
    const clock = startClock(opts.sampleRate, opts.frameSize, () => {
      for (let i = 0; i < opts.frameSize; i++) {
        for (let c = 0; c < opts.channels; c++) {
          buf[i * opts.channels + c] = live.has(c) ? virtualSample(c, frame + i, opts.sampleRate) : 0;
        }
      }
      frame += opts.frameSize;
      opts.onData(buf);
    });
    return { channels: opts.channels, sampleRate: opts.sampleRate, frameSize: opts.frameSize, close: clock };
  }

  openOutput(opts: OutputStreamOptions): StreamHandle {
    const dev = this.device(opts.deviceId);
    if (opts.channels > dev.outputChannels) throw new Error(`${dev.name} has only ${dev.outputChannels} outputs`);
    const clock = startClock(opts.sampleRate, opts.frameSize, () => {
      opts.pull(opts.frameSize);
    });
    return { channels: opts.channels, sampleRate: opts.sampleRate, frameSize: opts.frameSize, close: clock };
  }

  dispose(): void {}
}

/** Calls `tick` once per buffer period, catching up on timer jitter. Returns a stop function. */
function startClock(sampleRate: number, frameSize: number, tick: () => void): () => void {
  const periodMs = (frameSize / sampleRate) * 1000;
  const startedAt = performance.now();
  let done = 0;
  const timer = setInterval(() => {
    const due = Math.floor((performance.now() - startedAt) / periodMs);
    // cap catch-up so a suspended laptop doesn't flood the engine
    if (due - done > 50) done = due - 50;
    while (done < due) {
      tick();
      done++;
    }
  }, Math.max(2, Math.floor(periodMs / 2)));
  return () => clearInterval(timer);
}
