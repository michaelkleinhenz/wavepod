import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine, INPUT_LOST_MS, RECONNECT_MS } from '../src/main/audio/engine';
import type { TakeReport } from '../src/main/audio/engine';
import type { AudioBackend, InputStreamOptions } from '../src/main/audio/backend';
import type { AudioDevice, DeviceConfig, RecordedTake } from '../src/shared/types';
import { addTrack, createProject } from '../src/core/project';
import { WavReader } from '../src/core/wav';
import { tmpDir } from './helpers';

const SR = 48000;
const FRAME = 480; // 10 ms

const device = (id: number): AudioDevice => ({
  id,
  name: 'RØDECaster Pro II',
  inputChannels: 4,
  outputChannels: 2,
  sampleRates: [SR],
  preferredSampleRate: SR,
  isDefaultInput: true,
  isDefaultOutput: true,
});

/** A backend whose device can vanish (like a USB interface that resets) and come back under a new id. */
function fakeBackend() {
  const state = { devices: [device(3)], inputs: [] as Array<InputStreamOptions & { closed: boolean }>, outputs: [] as Array<{ deviceId: number; closed: boolean }> };
  const backend: AudioBackend = {
    name: 'Fake',
    api: 'default',
    listApis: () => [{ id: 'default', label: 'Default' }],
    setApi: () => {},
    listDevices: () => state.devices.map((d) => ({ ...d })),
    openInput: (opts) => {
      if (!state.devices.some((d) => d.id === opts.deviceId)) throw new Error('no such device');
      const s = { ...opts, closed: false };
      state.inputs.push(s);
      return { channels: opts.channels, sampleRate: opts.sampleRate, frameSize: opts.frameSize, close: () => (s.closed = true) };
    },
    openOutput: (opts) => {
      const s = { deviceId: opts.deviceId, closed: false };
      state.outputs.push(s);
      return { channels: opts.channels, sampleRate: opts.sampleRate, frameSize: opts.frameSize, close: () => (s.closed = true) };
    },
    dispose: () => {},
  };
  return { state, backend };
}

describe('input device that drops out', () => {
  let engine: AudioEngine;
  afterEach(() => {
    engine?.dispose();
    vi.useRealTimers();
  });

  it('keeps the take running with silence and reconnects when the device is back', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'] });
    const { state, backend } = fakeBackend();
    engine = new AudioEngine(() => backend);
    engine.freeSpace = () => null;
    expect(engine.applyConfig({ api: 'default', inputDeviceId: 3, outputDeviceId: 3, sampleRate: SR, bufferSize: FRAME }).error).toBeNull();
    const dir = tmpDir();
    const p = addTrack(createProject('Rec', SR), { name: 'Host', inputChannels: [0], armed: true });
    engine.setProject(p, dir);
    const saved: DeviceConfig[] = [];
    engine.on('configChanged', (c: DeviceConfig) => saved.push(c));
    let report: TakeReport | null = null;
    engine.on('recordingFinished', (_t: RecordedTake[], r: TakeReport) => (report = r));

    const buf = new Float32Array(FRAME * 4).fill(0.5);
    /** Delivers `n` buffers in real time through the newest input stream. */
    const feed = (n: number) => {
      for (let i = 0; i < n; i++) {
        vi.advanceTimersByTime(10);
        state.inputs.at(-1)!.onData(buf);
      }
    };

    engine.record();
    feed(100); // 1 s of audio
    // the interface resets: its streams go quiet and it leaves the device list
    state.devices = [];
    vi.advanceTimersByTime(INPUT_LOST_MS + 1000);
    expect(engine.status().error).toContain('stopped sending audio');
    // silence keeps the take (and the cursor) going in real time
    expect(engine.position / SR).toBeGreaterThan(3.8);
    expect(state.inputs).toHaveLength(1);

    // back, under another id: the streams are reopened there
    state.devices = [device(9)];
    vi.advanceTimersByTime(RECONNECT_MS);
    expect(state.inputs).toHaveLength(2);
    expect(state.inputs[0].closed).toBe(true);
    expect(state.inputs[1].deviceId).toBe(9);
    expect(state.outputs.at(-1)).toMatchObject({ deviceId: 9, closed: false });
    expect(saved.at(-1)).toMatchObject({ inputDeviceId: 9, outputDeviceId: 9 });
    const gapEnd = engine.position;
    feed(100);
    expect(engine.status().error).toBeNull();

    const takes = engine.stop();
    expect(takes).toHaveLength(1);
    const len = takes[0].clip.length;
    // as long as the wall-clock time the take ran, within a few buffers
    const elapsed = 1 + (INPUT_LOST_MS + 1000 + RECONNECT_MS) / 1000 + 1;
    expect(Math.abs(len / SR - elapsed)).toBeLessThan(0.05);
    const r = new WavReader(path.join(dir, takes[0].clip.file));
    const data = r.read(0, r.frames)[0];
    r.close();
    expect(data[SR / 2]).toBeCloseTo(0.5, 3);
    expect(data[Math.round(SR * 2.5)]).toBe(0);
    expect(data[gapEnd + SR / 2]).toBeCloseTo(0.5, 3);
    // the gap is marked so it is easy to find
    expect(report!.events.some((e) => e.kind === 'stall' && e.text.includes('reconnected'))).toBe(true);
  });

  it('reconnects when not recording, without touching another output device', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'] });
    const { state, backend } = fakeBackend();
    const speakers: AudioDevice = { ...device(5), name: 'Speakers', inputChannels: 0, isDefaultInput: false };
    state.devices.push(speakers);
    engine = new AudioEngine(() => backend);
    engine.applyConfig({ api: 'default', inputDeviceId: 3, outputDeviceId: 5, sampleRate: SR, bufferSize: FRAME });
    state.inputs[0].onData(new Float32Array(FRAME * 4));
    vi.advanceTimersByTime(INPUT_LOST_MS + 200);
    expect(engine.status().error).toContain('stopped sending audio');
    expect(engine.status().error).not.toContain('recording');
    // still listed (only its stream died): reopened right away
    expect(state.inputs).toHaveLength(2);
    expect(state.inputs[0].closed).toBe(true);
    expect(state.outputs).toHaveLength(1);
    expect(state.outputs[0].closed).toBe(false);
    state.inputs[1].onData(new Float32Array(FRAME * 4));
    expect(engine.status().error).toBeNull();
  });
});
