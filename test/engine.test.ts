import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AudioEngine, VIRTUAL_API } from '../src/main/audio/engine';
import { addTrack, createProject } from '../src/core/project';
import { WavReader, writeWavFile } from '../src/core/wav';
import type { AudioBackend } from '../src/main/audio/backend';
import type { TransportUpdate } from '../src/shared/types';
import { sine, tmpDir } from './helpers';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('AudioEngine with virtual devices', () => {
  let engine: AudioEngine;
  afterEach(() => engine?.dispose());

  it('falls back to virtual devices when native audio fails to load', () => {
    engine = new AudioEngine(() => {
      throw new Error('no module');
    });
    const s = engine.status();
    expect(s.backend).toBe('Simulated');
    expect(s.backendError).toContain('no module');
    expect(engine.listDevices().map((d) => d.name)).toContain('Virtual RØDECaster Pro II');
  });

  it('opens a 16-channel input, meters it and records armed tracks', async () => {
    engine = new AudioEngine(null);
    const status = engine.applyConfig({ api: VIRTUAL_API, inputDeviceId: 1, outputDeviceId: 2, sampleRate: 48000, bufferSize: 480 });
    expect(status.error).toBeNull();
    expect(status.inputChannelCount).toBe(16);
    expect(status.outputChannelCount).toBe(4);

    const dir = tmpDir();
    let p = createProject('Rec', 48000);
    p = addTrack(p, { name: 'Host', inputChannels: [2], armed: true });
    p = addTrack(p, { name: 'Remote', inputChannels: [12, 13], armed: true });
    p = addTrack(p, { name: 'Unarmed', inputChannels: [3] });
    engine.setProject(p, dir);

    const updates: TransportUpdate[] = [];
    engine.on('transport', (u) => updates.push(u));
    await wait(120);
    expect(updates.some((u) => u.inputPeaks[2] > 0)).toBe(true);
    expect(updates.every((u) => u.inputPeaks[15] === 0)).toBe(true);

    engine.seek(4800);
    const files = engine.record();
    expect(files).toHaveLength(2);
    await wait(300);
    const takes = engine.stop();
    expect(takes).toHaveLength(2);
    const host = takes.find((t) => t.trackId === p.tracks[0].id)!;
    expect(host.clip.start).toBe(4800);
    expect(host.clip.length).toBeGreaterThan(48000 * 0.15);
    const r = new WavReader(path.join(dir, host.clip.file));
    expect(r.info.channels).toBe(1);
    expect(r.frames).toBe(host.clip.length);
    r.close();
    const remote = takes.find((t) => t.trackId === p.tracks[1].id)!;
    const r2 = new WavReader(path.join(dir, remote.clip.file));
    expect(r2.info.channels).toBe(2);
    r2.close();
    expect(fs.existsSync(path.join(dir, `${host.clip.file}.peaks`))).toBe(true);
    const peaks = engine.getPeaks(host.clip.file)!;
    expect(peaks.length).toBe(host.clip.length);
    expect(engine.position).toBe(4800 + host.clip.length);
  });

  it('streams live waveform peaks of the takes while recording', async () => {
    engine = new AudioEngine(null);
    engine.applyConfig({ api: VIRTUAL_API, inputDeviceId: 1, outputDeviceId: 2, sampleRate: 48000, bufferSize: 480 });
    const dir = tmpDir();
    const p = addTrack(createProject('Live', 48000), { name: 'Host', inputChannels: [2], armed: true });
    engine.setProject(p, dir);
    const updates: TransportUpdate[] = [];
    engine.on('transport', (u) => updates.push(u));
    engine.record();
    await wait(300);
    const takes = engine.stop();
    const live = updates.flatMap((u) => u.recordingPeaks ?? []).filter((l) => l.trackId === p.tracks[0].id);
    expect(live.length).toBeGreaterThan(1);
    // chunks are contiguous and together match the saved peaks
    const data: number[] = [];
    for (const l of live) {
      expect(l.from * 2).toBe(data.length);
      data.push(...l.data);
    }
    expect(data.some((v) => v !== 0)).toBe(true);
    // the finest level is not sent whole but read in tiles
    const saved = engine.getPeaks(takes[0].clip.file)!;
    expect(saved.tiled).toEqual([live[0].samplesPerPeak]);
    expect(saved.levels[0].samplesPerPeak).toBe(live[0].samplesPerPeak * 4);
    const tile = engine.getPeakTile(takes[0].clip.file, live[0].samplesPerPeak, 0)!;
    expect(Array.from(tile.slice(0, data.length))).toEqual(data);
    const samples = engine.getSampleTile(takes[0].clip.file, 0)!;
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.some((v) => v !== 0)).toBe(true);
    expect(updates.filter((u) => u.state !== 'recording').every((u) => !u.recordingPeaks)).toBe(true);
  });

  it('records jingles triggered while recording onto the Soundboard track', async () => {
    engine = new AudioEngine(null);
    engine.applyConfig({ api: VIRTUAL_API, inputDeviceId: 1, outputDeviceId: 2, sampleRate: 48000, bufferSize: 480 });
    const dir = tmpDir();
    let p = addTrack(createProject('Jingles', 48000), { name: 'Host', inputChannels: [2], armed: true });
    p = { ...p, soundboard: [{ id: 'snd1', name: 'Intro', file: 'intro.mp3', gain: -2, color: '#fff' }, { id: 'snd2', name: 'Bed', file: 'bed.mp3', gain: 0, color: '#fff', loop: true }] };
    engine.setProject(p, dir);
    engine.loadSound('snd1', [sine(440, 0.1, 48000, 0.5)]);
    engine.loadSound('snd2', [sine(220, 0.05, 48000, 0.5)]);
    const wavPath = path.join(dir, 'media/jingle-snd1-48000.wav');
    expect(new WavReader(wavPath).frames).toBe(4800);

    engine.playSound('snd1'); // before recording: played, not recorded
    engine.record();
    await wait(200); // let the first one finish; triggering a playing slot fades it out instead
    const updates: TransportUpdate[] = [];
    engine.on('transport', (u) => updates.push(u));
    engine.playSound('snd1');
    engine.playSound('snd2');
    await wait(250);
    expect(updates.some((u) => u.jingles?.some((j) => j.slotId === 'snd2' && j.recordStart !== undefined))).toBe(true);
    engine.playSound('snd2'); // second trigger fades the loop out
    await wait(1200);
    const takes = engine.stop();
    const jingles = takes.filter((t) => t.trackId === 'soundboard');
    const intro = jingles.filter((t) => t.clip.file === 'media/jingle-snd1-48000.wav');
    expect(intro).toHaveLength(1);
    expect(intro[0].clip).toMatchObject({ length: 4800, gain: -2 });
    expect(intro[0].clip.start).toBeGreaterThan(0);
    const bed = jingles.filter((t) => t.clip.file === 'media/jingle-snd2-48000.wav');
    expect(bed.length).toBeGreaterThan(2); // several loop passes
    expect(bed.slice(0, -1).every((t) => t.clip.length === 2400)).toBe(true);
    expect(bed[bed.length - 1].clip.fadeOut).toBeGreaterThan(0);
    for (let i = 1; i < bed.length; i++) expect(bed[i].clip.start).toBe(bed[i - 1].clip.start + 2400);
  });

  it('refuses to record without armed tracks', () => {
    engine = new AudioEngine(null);
    engine.applyConfig({ api: VIRTUAL_API, inputDeviceId: 1, outputDeviceId: 2 });
    engine.setProject(addTrack(createProject(), { name: 'A' }), tmpDir());
    expect(() => engine.record()).toThrow(/Arm at least one track/);
  });

  it('plays the timeline through the output pair', async () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'media'));
    writeWavFile(path.join(dir, 'media/tone.wav'), [sine(440, 1, 48000, 0.5)], 48000);
    let p = createProject('Play', 48000);
    p = addTrack(p, { name: 'T' });
    p.tracks[0].clips.push({ id: 'c', file: 'media/tone.wav', start: 0, offset: 0, length: 48000, gain: 0, fadeIn: 0, fadeOut: 0 });

    // capture output buffers through a fake native backend
    const captured: Float32Array[] = [];
    const fake: AudioBackend = {
      name: 'Fake',
      api: 'default',
      listApis: () => [{ id: 'default', label: 'Fake' }],
      setApi: () => {},
      listDevices: () => [
        { id: 7, name: 'Fake 4ch', inputChannels: 0, outputChannels: 4, sampleRates: [48000], preferredSampleRate: 48000, isDefaultInput: false, isDefaultOutput: true },
      ],
      openInput: () => {
        throw new Error('no input');
      },
      openOutput: (opts) => {
        const t = setInterval(() => captured.push(Float32Array.from(opts.pull(opts.frameSize))), 5);
        return { channels: opts.channels, sampleRate: opts.sampleRate, frameSize: opts.frameSize, close: () => clearInterval(t) };
      },
      dispose: () => {},
    };
    engine = new AudioEngine(() => fake);
    const s = engine.applyConfig({ api: 'default', outputDeviceId: 7, outputFirstChannel: 2, bufferSize: 256 });
    expect(s.outputOpen).toBe(true);
    engine.setProject(p, dir);
    engine.play(0);
    await wait(100);
    engine.stop();
    const all = captured.filter((b) => b.some((v) => v !== 0));
    expect(all.length).toBeGreaterThan(0);
    // channels 0/1 silent, 2/3 carry the mono track
    const buf = all[0];
    let ch0 = 0;
    let ch2 = 0;
    for (let i = 0; i < buf.length; i += 4) {
      ch0 = Math.max(ch0, Math.abs(buf[i]));
      ch2 = Math.max(ch2, Math.abs(buf[i + 2]));
    }
    expect(ch0).toBe(0);
    expect(ch2).toBeGreaterThan(0.3);
  });
});
