import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AudioEngine } from '../src/main/audio/engine';
import { addTrack, createProject } from '../src/core/project';
import { PUNCH_CROSSFADE_SECONDS, clampRoll, punchInClip, punchPlan, punchTakeClip } from '../src/core/punch';
import { trackFades } from '../src/core/crossfade';
import { readJournal, recoverRecording, writeJournal } from '../src/core/recordingJournal';
import { WavReader, writeWavFile } from '../src/core/wav';
import type { AudioBackend } from '../src/main/audio/backend';
import type { Clip, RecordedTake } from '../src/shared/types';
import { tmpDir } from './helpers';

const SR = 48000;
const XF = Math.round(PUNCH_CROSSFADE_SECONDS * SR);
const clip = (id: string, start: number, length: number, extra: Partial<Clip> = {}): Clip => ({
  id,
  file: `media/${id}.wav`,
  start,
  offset: 0,
  length,
  gain: 0,
  fadeIn: 0,
  fadeOut: 0,
  ...extra,
});

describe('punch-in planning', () => {
  it('starts the pre-roll before the range, never before 0, and stops after the post-roll', () => {
    expect(punchPlan({ start: 96000, end: 144000, preRoll: 3 * SR, postRoll: SR })).toEqual({ from: 0, in: 96000, out: 144000, until: 192000 });
    expect(punchPlan({ start: 48000, end: 60000, preRoll: 3 * SR, postRoll: 0 })).toEqual({ from: 0, in: 48000, out: 60000, until: 60000 });
    // a selection dragged right to left
    expect(punchPlan({ start: 60000, end: 50000, preRoll: 1000, postRoll: 0 }).in).toBe(50000);
    expect(() => punchPlan({ start: 1000, end: 1000, preRoll: 0, postRoll: 0 })).toThrow(/Select/);
  });

  it('clamps pre-roll and post-roll seconds', () => {
    expect(clampRoll('2.5', 3, 30)).toBe(2.5);
    expect(clampRoll(-4, 3, 30)).toBe(0);
    expect(clampRoll(99, 3, 30)).toBe(30);
    expect(clampRoll('x', 3, 30)).toBe(3);
  });
});

describe('punch take clip', () => {
  const punch = { in: 100000, out: 150000 };

  it('covers the range plus a crossfade overlap on each side, with the pre-roll as handle', () => {
    const r = punchTakeClip({ file: 'media/t.wav', recordStart: 40000, frames: 120000 }, punch, SR)!;
    expect(r.range).toEqual([100000, 150000]);
    expect(r.clip.start).toBe(100000 - XF);
    expect(r.clip.offset).toBe(60000 - XF);
    expect(r.clip.length).toBe(50000 + 2 * XF);
  });

  it('ends where the pass was stopped, and gives nothing when stopped in the pre-roll', () => {
    const early = punchTakeClip({ file: 'media/t.wav', recordStart: 40000, frames: 90000 }, punch, SR)!;
    expect(early.range).toEqual([100000, 130000]);
    expect(early.clip.start + early.clip.length).toBe(130000);
    expect(punchTakeClip({ file: 'media/t.wav', recordStart: 40000, frames: 50000 }, punch, SR)).toBeNull();
  });

  it('has no overlap where there is no pre-roll audio (punch at the very start)', () => {
    const r = punchTakeClip({ file: 'media/t.wav', recordStart: 0, frames: 60000 }, { in: 0, out: 48000 }, SR)!;
    expect(r.clip.start).toBe(0);
    expect(r.clip.offset).toBe(0);
  });
});

describe('placing a punch take', () => {
  it('replaces only the range on its own track and crossfades at both edges', () => {
    let p = createProject('P', SR);
    p = addTrack(p, { name: 'Anna' });
    p = addTrack(p, { name: 'Ben' });
    const [anna, ben] = p.tracks;
    anna.clips.push(clip('old', 0, 480000), clip('inside', 200000, 10000));
    ben.clips.push(clip('ben', 0, 480000));
    const placed = punchTakeClip({ file: 'media/new.wav', recordStart: 50000, frames: 160000 }, { in: 96000, out: 192000 }, SR)!;
    const out = punchInClip(p, anna.id, placed.clip, placed.range);
    const a = out.tracks[0].clips;
    // left part, the new take, right part; the short clip outside the range stays
    expect(a.map((c) => [c.start, c.start + c.length])).toEqual([
      [0, 96000],
      [96000 - XF, 192000 + XF],
      [192000, 480000],
      [200000, 210000],
    ]);
    expect(a[2].offset).toBe(192000);
    // the overlaps become equal-power crossfades
    const fades = trackFades(out.tracks[0]);
    expect(fades.get(a[1].id)).toMatchObject({ fadeIn: XF, fadeOut: XF, autoIn: true, autoOut: true });
    // the other track is untouched
    expect(out.tracks[1].clips).toEqual(ben.clips);
  });
});

describe('punch-in recording in the engine', () => {
  let engine: AudioEngine;
  afterEach(() => engine?.dispose());

  /** A 1-in / 2-out device driven by hand: each step feeds one input block and pulls one output block. */
  function setup(block = 480) {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'media'));
    // the old take: a constant 0.5 for 2 s
    writeWavFile(path.join(dir, 'media/old.wav'), [new Float32Array(2 * SR).fill(0.5)], SR, 32);
    let p = createProject('Punch', SR);
    p = addTrack(p, { name: 'Anna', inputChannels: [0], armed: true, pan: 0 });
    p.tracks[0].clips.push(clip('old', 0, 2 * SR));
    let pull: ((n: number) => Float32Array) | null = null;
    let feed: ((d: Float32Array) => void) | null = null;
    const fake: AudioBackend = {
      name: 'Fake',
      api: 'default',
      listApis: () => [{ id: 'default', label: 'Fake' }],
      setApi: () => {},
      listDevices: () => [
        { id: 1, name: 'Fake', inputChannels: 1, outputChannels: 2, sampleRates: [SR], preferredSampleRate: SR, isDefaultInput: true, isDefaultOutput: true },
      ],
      openInput: (o) => {
        feed = o.onData;
        return { channels: o.channels, sampleRate: o.sampleRate, frameSize: o.frameSize, close: () => {} };
      },
      openOutput: (o) => {
        pull = o.pull;
        return { channels: o.channels, sampleRate: o.sampleRate, frameSize: o.frameSize, close: () => {} };
      },
      dispose: () => {},
    };
    engine = new AudioEngine(() => fake);
    engine.applyConfig({ api: 'default', inputDeviceId: 1, outputDeviceId: 1, sampleRate: SR, bufferSize: block });
    engine.setProject(p, dir);
    let fed = 0;
    /** Runs n blocks; the input carries 0.25. Returns the left output channel. */
    const run = (n: number): number[] => {
      const heard: number[] = [];
      for (let b = 0; b < n; b++) {
        const out = pull!(block);
        for (let i = 0; i < block; i++) heard.push(out[i * 2]);
        feed!(new Float32Array(block).fill(0.25));
        fed += block;
      }
      return heard;
    };
    const takes: RecordedTake[] = [];
    engine.on('recordingFinished', (t: RecordedTake[]) => takes.push(...t));
    return { dir, p, run, takes, fedFrames: () => fed };
  }

  it('plays the pre-roll with the armed track audible, mutes it inside the range and stops after the post-roll', () => {
    const { dir, p, run, takes } = setup();
    engine.seek(40000);
    engine.record({ start: 24000, end: 33600, preRoll: 9600, postRoll: 4800 });
    expect(engine.transportState).toBe('recording');
    expect(engine.position).toBe(14400); // the take starts with the pre-roll
    // pre-roll 14400..24000: the old audio is heard
    const pre = run(20);
    expect(pre.every((v) => v > 0.1)).toBe(true);
    // inside the range the armed track is silent (the speaker hears themselves live)
    const inside = run(20);
    expect(inside.every((v) => v === 0)).toBe(true);
    // post-roll: the old audio again; the pass stops by itself at 33600 + 4800
    const post = run(10);
    expect(post.slice(0, 480 * 9).every((v) => v > 0.1)).toBe(true);
    expect(engine.transportState).toBe('stopped');
    // the playhead goes back to the pre-roll start for a review
    expect(engine.position).toBe(14400);

    expect(takes).toHaveLength(1);
    const t = takes[0];
    expect(t.trackId).toBe(p.tracks[0].id);
    expect(t.punch).toEqual([24000, 33600]);
    expect(t.clip.start).toBe(24000 - XF);
    expect(t.clip.offset).toBe(24000 - XF - 14400);
    expect(t.clip.length).toBe(9600 + 2 * XF);
    // the file holds the whole pass, pre-roll to post-roll, sample-exact
    const r = new WavReader(path.join(dir, t.clip.file));
    expect(r.frames).toBe(38400 - 14400);
    r.close();
  });

  it('keeps nothing when stopped during the pre-roll', () => {
    const { dir, run, takes } = setup();
    const [file] = engine.record({ start: 48000, end: 60000, preRoll: 24000, postRoll: 0 });
    run(10);
    expect(engine.stop()).toEqual([]);
    expect(takes).toEqual([]);
    expect(fs.existsSync(path.join(dir, file))).toBe(false);
    expect(engine.position).toBe(24000);
  });

  it('ends the take where the pass was stopped inside the range', () => {
    const { run } = setup();
    engine.record({ start: 4800, end: 48000, preRoll: 4800, postRoll: 0 });
    run(20); // 0 .. 9600
    const [t] = engine.stop();
    expect(t.punch).toEqual([4800, 9600]);
    expect(t.clip.start + t.clip.length).toBe(9600);
  });
});

describe('recovering a punch take after a crash', () => {
  it('puts only the range back, cut into the old audio', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'media'));
    writeWavFile(path.join(dir, 'media/take.wav'), [new Float32Array(30000).fill(0.1)], SR, 24);
    let p = createProject('P', SR);
    p = addTrack(p, { name: 'Anna', inputChannels: [0] });
    p.tracks[0].clips.push(clip('old', 0, 100000));
    writeJournal(dir, {
      version: 1,
      startedAt: new Date().toISOString(),
      sampleRate: SR,
      bitDepth: 24,
      recordStart: 10000,
      punch: [20000, 30000],
      takes: [{ trackId: p.tracks[0].id, trackName: 'Anna', file: 'media/take.wav', channels: [0] }],
      jingles: [],
      events: [],
    });
    expect(readJournal(dir)?.punch).toEqual([20000, 30000]);
    const rec = recoverRecording(dir, p)!;
    expect(rec.takes).toBe(1);
    const spans = rec.project.tracks[0].clips.map((c) => [c.file, c.start, c.start + c.length]);
    expect(spans).toEqual([
      ['media/old.wav', 0, 20000],
      ['media/take.wav', 20000 - XF, 30000 + XF],
      ['media/old.wav', 30000, 100000],
    ]);
  });
});
