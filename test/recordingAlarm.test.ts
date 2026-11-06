import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine, INPUT_LOST_MS, RECONNECT_MS } from '../src/main/audio/engine';
import type { AudioBackend, InputStreamOptions } from '../src/main/audio/backend';
import type { AudioDevice, RecordingAlert, RecordingWarning, TransportUpdate } from '../src/shared/types';
import { addTrack, createProject } from '../src/core/project';
import { NOTIFY_COOLDOWN_MS, RecordingAlarm, alarmGroup, testAlert } from '../src/core/recordingAlarm';
import { tmpDir } from './helpers';

const stall: RecordingWarning = { key: 'stall', level: 'critical', text: 'No audio from the input for 2 s.' };
const lost: RecordingWarning = { key: 'input-lost', level: 'critical', text: 'No audio from "RØDECaster" for 3 s.' };
const diskErr: RecordingWarning = { key: 'disk-error', level: 'critical', text: 'Disk full.' };

describe('which problems are emergencies', () => {
  it('alarms for a lost input or a disk that fails, not for dropouts, crackle or clipping', () => {
    expect(alarmGroup(stall)).toBe('input');
    expect(alarmGroup(lost)).toBe('input');
    expect(alarmGroup(diskErr)).toBe('disk');
    expect(alarmGroup({ key: 'disk-space', level: 'critical', text: '' })).toBe('disk');
    expect(alarmGroup({ key: 'disk-space', level: 'warning', text: '' })).toBeNull();
    expect(alarmGroup({ key: 'disk-slow', level: 'warning', text: '' })).toBeNull();
    expect(alarmGroup({ key: 'dropout', level: 'warning', text: '' })).toBeNull();
    expect(alarmGroup({ key: 'crackle-a', level: 'warning', text: '' })).toBeNull();
    expect(alarmGroup({ key: 'clip-a', level: 'warning', text: '' })).toBeNull();
  });
});

describe('RecordingAlarm', () => {
  it('raises once, updates the details, and says when it is over', () => {
    const a = new RecordingAlarm();
    expect(a.update(true, [], 0)).toBeNull();
    expect(a.update(true, [{ key: 'dropout', level: 'warning', text: 'x' }], 100)).toBeNull();
    const raised = a.update(true, [stall], 200)!;
    expect(raised.alert.state).toBe('raised');
    expect(raised.notify).toBe(true);
    expect(raised.alert.problems).toEqual([stall.text]);
    // the same problem again: nothing new
    expect(a.update(true, [stall], 300)).toBeNull();
    // the watchdog takes over from the monitor: same emergency, new text, no second notification
    const upd = a.update(true, [lost], 400)!;
    expect(upd.alert.state).toBe('update');
    expect(upd.notify).toBe(false);
    const back = a.update(true, [], 5000)!;
    expect(back.alert.state).toBe('resolved');
    expect(back.alert.title).toContain('back');
    expect(a.update(true, [], 5100)).toBeNull();
  });

  it('does not send another notification for a device that flaps within the cooldown', () => {
    const a = new RecordingAlarm();
    expect(a.update(true, [lost], 0)!.notify).toBe(true);
    a.update(true, [], 1000);
    const again = a.update(true, [lost], 2000)!;
    expect(again.alert.state).toBe('raised');
    expect(again.notify).toBe(false);
    a.update(true, [], 3000);
    expect(a.update(true, [lost], NOTIFY_COOLDOWN_MS + 10)!.notify).toBe(true);
  });

  it('a second kind of emergency notifies on its own', () => {
    const a = new RecordingAlarm();
    a.update(true, [lost], 0);
    const both = a.update(true, [lost, diskErr], 100)!;
    expect(both.alert.state).toBe('raised');
    expect(both.notify).toBe(true);
    expect(both.alert.problems).toEqual([lost.text, diskErr.text]);
  });

  it('stopping the recording ends the alarm without a "back" message', () => {
    const a = new RecordingAlarm();
    a.update(true, [lost], 0);
    expect(a.update(false, [], 100)!.alert.state).toBe('ended');
    expect(a.update(false, [], 200)).toBeNull();
    expect(a.raised).toBe(false);
  });

  it('has a test alert', () => {
    expect(testAlert()).toMatchObject({ state: 'raised', test: true });
  });
});

const SR = 48000;
const FRAME = 480;
const device = (id: number): AudioDevice => ({
  id,
  name: 'RØDECaster Pro II',
  inputChannels: 2,
  outputChannels: 2,
  sampleRates: [SR],
  preferredSampleRate: SR,
  isDefaultInput: true,
  isDefaultOutput: true,
});

describe('a device that drops out mid-take', () => {
  let engine: AudioEngine;
  afterEach(() => {
    engine?.dispose();
    vi.useRealTimers();
  });

  it('raises the alarm while it is gone and resolves it when audio is back; a silent input never alarms', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance', 'Date'] });
    const state = { devices: [device(3)], inputs: [] as InputStreamOptions[] };
    const backend: AudioBackend = {
      name: 'Fake',
      api: 'default',
      listApis: () => [{ id: 'default', label: 'Default' }],
      setApi: () => {},
      listDevices: () => state.devices.map((d) => ({ ...d })),
      openInput: (opts) => {
        if (!state.devices.some((d) => d.id === opts.deviceId)) throw new Error('no such device');
        state.inputs.push(opts);
        return { channels: opts.channels, sampleRate: opts.sampleRate, frameSize: opts.frameSize, close: () => {} };
      },
      openOutput: (opts) => ({ channels: opts.channels, sampleRate: opts.sampleRate, frameSize: opts.frameSize, close: () => {} }),
      dispose: () => {},
    };
    engine = new AudioEngine(() => backend);
    engine.freeSpace = () => null;
    engine.applyConfig({ api: 'default', inputDeviceId: 3, outputDeviceId: 3, sampleRate: SR, bufferSize: FRAME });
    engine.setProject(addTrack(createProject('Rec', SR), { name: 'Host', inputChannels: [0], armed: true }), tmpDir());
    const alarm = new RecordingAlarm();
    const alerts: RecordingAlert[] = [];
    engine.on('transport', (u: TransportUpdate) => {
      const c = alarm.update(u.state === 'recording', u.health?.warnings ?? [], Date.now());
      if (c) alerts.push(c.alert);
    });
    const silence = new Float32Array(FRAME * 2);
    const feed = (n: number) => {
      for (let i = 0; i < n; i++) {
        vi.advanceTimersByTime(10);
        state.inputs.at(-1)!.onData(silence);
      }
    };
    engine.record();
    // ten seconds of a muted mic: digital silence is not an emergency
    feed(1000);
    expect(alerts).toEqual([]);
    // unplugged
    state.devices = [];
    vi.advanceTimersByTime(INPUT_LOST_MS + 500);
    expect(alerts.map((a) => a.state)).toContain('raised');
    expect(alerts.find((a) => a.state === 'raised')!.problems.join(' ')).toContain('RØDECaster');
    vi.advanceTimersByTime(3000);
    expect(alerts.filter((a) => a.state === 'raised')).toHaveLength(1);
    // plugged back in
    state.devices = [device(7)];
    vi.advanceTimersByTime(RECONNECT_MS);
    feed(100);
    expect(alerts.at(-1)!.state).toBe('resolved');
    engine.stop();
    vi.advanceTimersByTime(200);
    expect(alerts.filter((a) => a.state === 'raised')).toHaveLength(1);
  });
});
