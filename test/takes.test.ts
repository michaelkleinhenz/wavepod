import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addTrack, createProject, insertSilence, normalizeProject, rippleDelete, moveClip } from '../src/core/project';
import {
  activeTakeAt,
  clearRange,
  clipsInRange,
  compTake,
  cycleTake,
  deleteTake,
  deleteUnusedTakes,
  flattenTakes,
  loopFramePosition,
  loopPass,
  loopTakeClips,
  pickTake,
  recordTake,
  recordTakes,
  syncTakes,
  takeSpan,
  takeUsage,
  takesAt,
} from '../src/core/takes';
import { mergeRecording } from '../src/core/recordingJournal';
import { AudioEngine, VIRTUAL_API } from '../src/main/audio/engine';
import { WavReader } from '../src/core/wav';
import type { Clip, Project, TransportUpdate } from '../src/shared/types';
import { tmpDir } from './helpers';

const clip = (file: string, start: number, length: number, extra: Partial<Clip> = {}): Clip => ({
  id: `c-${file}-${start}`, file, start, offset: 0, length, gain: 0, fadeIn: 0, fadeOut: 0, ...extra,
});

function base(): Project {
  return addTrack(createProject('T', 1000), { name: 'Anna' });
}
const track = (p: Project) => p.tracks[0];
const tid = (p: Project) => p.tracks[0].id;

describe('takes: recording over a line', () => {
  it('a first recording is a plain clip, not a take', () => {
    const p0 = base();
    const p = recordTake(p0, tid(p0), clip('one.wav', 1000, 2000));
    expect(track(p).clips).toHaveLength(1);
    expect(track(p).takes).toBeUndefined();
  });

  it('recording the line again keeps both as takes and plays the newest', () => {
    const p0 = base();
    let p = recordTake(p0, tid(p0), clip('one.wav', 1000, 2000));
    p = recordTake(p, tid(p), clip('two.wav', 1000, 2000));
    const t = track(p);
    expect(t.takes!.map((k) => k.n)).toEqual([1, 2]);
    expect(t.takes![0].clips[0].file).toBe('one.wav');
    expect(t.clips).toHaveLength(1);
    expect(t.clips[0]).toMatchObject({ file: 'two.wav', start: 1000, length: 2000, takeId: t.takes![1].id });
    // a third pass adds take 3 only (the comp already comes from a take)
    p = recordTake(p, tid(p), clip('three.wav', 1000, 2000));
    expect(track(p).takes!.map((k) => k.n)).toEqual([1, 2, 3]);
    expect(track(p).clips.map((c) => c.file)).toEqual(['three.wav']);
  });

  it('a retake inside a longer recording keeps only the replaced stretch as take 1', () => {
    const p0 = base();
    let p = recordTake(p0, tid(p0), clip('long.wav', 0, 10000));
    p = recordTake(p, tid(p), clip('fix.wav', 4000, 1000));
    const t = track(p);
    expect(t.takes![0].clips).toEqual([expect.objectContaining({ file: 'long.wav', start: 4000, offset: 4000, length: 1000 })]);
    expect(t.clips.map((c) => [c.file, c.start, c.offset, c.length])).toEqual([
      ['long.wav', 0, 0, 4000],
      ['fix.wav', 4000, 0, 1000],
      ['long.wav', 5000, 5000, 5000],
    ]);
    // picking take 1 puts the original back
    p = pickTake(p, tid(p), t.takes![0].id);
    expect(track(p).clips.map((c) => [c.file, c.start, c.offset, c.length])).toEqual([
      ['long.wav', 0, 0, 4000],
      ['long.wav', 4000, 4000, 1000],
      ['long.wav', 5000, 5000, 5000],
    ]);
  });

  it('loop passes over an empty stretch are all takes, the last one plays', () => {
    const p0 = base();
    const p = recordTakes(p0, tid(p0), [clip('loop.wav', 0, 500), clip('loop.wav', 0, 500, { offset: 500 }), clip('loop.wav', 0, 500, { offset: 1000 })]);
    const t = track(p);
    expect(t.takes!.map((k) => k.n)).toEqual([1, 2, 3]);
    expect(t.clips).toEqual([expect.objectContaining({ offset: 1000, takeId: t.takes![2].id })]);
  });
});

describe('takes: comping', () => {
  function threeTakes() {
    const p0 = base();
    let p = recordTake(p0, tid(p0), clip('a.wav', 1000, 3000));
    p = recordTake(p, tid(p), clip('b.wav', 1000, 3000));
    p = recordTake(p, tid(p), clip('c.wav', 1000, 3000));
    return p;
  }

  it('splices part of another take into the comp', () => {
    let p = threeTakes();
    const [t1, t2] = track(p).takes!;
    p = compTake(p, tid(p), t1.id, 1500, 2000);
    p = compTake(p, tid(p), t2.id, 3000, 3500);
    const t = track(p);
    expect(t.clips.map((c) => [c.file, c.start, c.offset, c.length])).toEqual([
      ['c.wav', 1000, 0, 500],
      ['a.wav', 1500, 500, 500],
      ['c.wav', 2000, 1000, 1000],
      ['b.wav', 3000, 2000, 500],
      ['c.wav', 3500, 2500, 500],
    ]);
    expect(takeUsage(t, t1.id)).toEqual([[1500, 2000]]);
    expect(activeTakeAt(t, 1600)?.n).toBe(1);
    expect(activeTakeAt(t, 3200)?.n).toBe(2);
    expect(takesAt(t, 1200).map((k) => k.n)).toEqual([1, 2, 3]);
  });

  it('a range outside the take changes nothing', () => {
    const p = threeTakes();
    expect(compTake(p, tid(p), track(p).takes![0].id, 6000, 7000)).toBe(p);
  });

  it('cycles through the takes at the playhead', () => {
    let p = threeTakes();
    let r = cycleTake(p, tid(p), 2000, 1);
    expect(r.take?.n).toBe(1); // after take 3 comes take 1 again
    p = r.project;
    expect(track(p).clips.map((c) => c.file)).toEqual(['a.wav']);
    r = cycleTake(p, tid(p), 2000, -1);
    expect(r.take?.n).toBe(3);
    expect(cycleTake(p, tid(p), 9000, 1).take).toBeUndefined();
  });

  it('deletes only takes the comp does not use; flatten keeps the comp', () => {
    let p = threeTakes();
    const [t1, , t3] = track(p).takes!;
    expect(deleteTake(p, tid(p), t3.id)).toBe(p);
    p = deleteTake(p, tid(p), t1.id);
    expect(track(p).takes!.map((k) => k.n)).toEqual([2, 3]);
    p = deleteUnusedTakes(p, tid(p));
    expect(track(p).takes!.map((k) => k.n)).toEqual([3]);
    p = flattenTakes(p, tid(p));
    expect(track(p).takes).toBeUndefined();
    expect(track(p).clips).toEqual([expect.not.objectContaining({ takeId: expect.anything() })]);
    expect(track(p).clips[0].file).toBe('c.wav');
  });

  it('takes follow ripple cuts and inserted silence', () => {
    let p = threeTakes();
    p = rippleDelete(p, 0, 500);
    expect(track(p).takes!.map((k) => takeSpan(k))).toEqual([[500, 3500], [500, 3500], [500, 3500]]);
    p = insertSilence(p, 1000, 1000);
    const k = track(p).takes![0];
    expect(k.clips.map((c) => [c.start, c.offset, c.length])).toEqual([[500, 0, 500], [2000, 500, 2500]]);
  });

  it('takes move along when the whole line is dragged elsewhere', () => {
    let p = threeTakes();
    p = compTake(p, tid(p), track(p).takes![0].id, 1500, 2000);
    for (const c of [...track(p).clips]) p = moveClip(p, c.id, c.start + 4000);
    p = syncTakes(p);
    expect(track(p).takes!.map((k) => takeSpan(k))).toEqual([[5000, 8000], [5000, 8000], [5000, 8000]]);
    expect(syncTakes(p)).toBe(p);
    // moving one word on its own leaves the takes where they are
    const word = track(p).clips[1];
    const q = syncTakes(moveClip(p, word.id, word.start + 200));
    expect(track(q).takes!.map((k) => takeSpan(k))).toEqual([[5000, 8000], [5000, 8000], [5000, 8000]]);
  });

  it('survives saving and loading', () => {
    const p = normalizeProject(JSON.parse(JSON.stringify({ ...threeTakes(), tracks: [{ ...track(threeTakes()), showTakes: true }] })));
    expect(track(p).takes).toHaveLength(3);
    expect(track(p).showTakes).toBe(true);
    expect(track(p).clips[0].takeId).toBe(track(p).takes![2].id);
    const broken = normalizeProject({ ...base(), tracks: [{ ...track(base()), takes: [{ id: 'x', n: 1, clips: [] }, 'nope'] as never, showTakes: true }] });
    expect(track(broken).takes).toBeUndefined();
    expect(track(broken).showTakes).toBeUndefined();
  });
});

describe('takes: helpers', () => {
  it('cuts clips to a range and out of it', () => {
    const c = clip('x.wav', 100, 1000, { fadeIn: 50, fadeOut: 50, offset: 10 });
    expect(clipsInRange([c], 0, 600)).toEqual([expect.objectContaining({ start: 100, offset: 10, length: 500, fadeIn: 50, fadeOut: 0 })]);
    expect(clearRange([c], 300, 600).map((x) => [x.start, x.offset, x.length])).toEqual([[100, 10, 200], [600, 510, 500]]);
  });

  it('splits a loop recording into passes', () => {
    // recorded from 500 with a 2 s loop at 1000..3000 (1000 Hz): run-up 500, then passes of 2000
    const rec = clip('loop.wav', 500, 500 + 2000 * 3 + 300);
    const passes = loopTakeClips(rec, [1000, 3000], 1000);
    expect(passes.map((c) => [c.start, c.offset, c.length])).toEqual([[1000, 500, 2000], [1000, 2500, 2000], [1000, 4500, 2000]]);
    // a last pass of 0.6 s is kept
    expect(loopTakeClips(clip('l.wav', 1000, 4600), [1000, 3000], 1000).map((c) => c.length)).toEqual([2000, 2000, 600]);
    expect(loopFramePosition(0, 500, [1000, 3000])).toBe(500);
    expect(loopFramePosition(2600, 500, [1000, 3000])).toBe(1100);
    expect(loopPass(2400, 500, [1000, 3000])).toBe(1);
    expect(loopPass(2500, 500, [1000, 3000])).toBe(2);
  });

  it('merges a finished loop recording as takes with problems at the right place', () => {
    const p0 = base();
    const rec = { trackId: tid(p0), clip: clip('loop.wav', 1000, 4500) };
    const p = mergeRecording(p0, [rec], { recordStart: 1000, loop: [1000, 3000], events: [{ frame: 2500, kind: 'clipping', text: 'Clipping' }] }, 1000);
    expect(track(p).takes!.map((k) => k.n)).toEqual([1, 2, 3]);
    // the last pass was cut short by Stop: kept, but the last whole pass plays
    expect(track(p).clips).toEqual([expect.objectContaining({ takeId: track(p).takes![1].id, length: 2000 })]);
    expect(p.markers).toEqual([expect.objectContaining({ kind: 'edit', position: 1500 })]);
  });
});

describe('loop recording in the engine', () => {
  let engine: AudioEngine;
  afterEach(() => engine?.dispose());
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('jumps back at the loop end, keeps one file and waits at the loop start afterwards', async () => {
    engine = new AudioEngine(null);
    engine.applyConfig({ api: VIRTUAL_API, inputDeviceId: 1, outputDeviceId: 2, sampleRate: 48000, bufferSize: 480 });
    const dir = tmpDir();
    const p = addTrack(createProject('Loop', 48000), { name: 'Anna', inputChannels: [2], armed: true });
    engine.setProject(p, dir);
    const updates: TransportUpdate[] = [];
    engine.on('transport', (u) => updates.push(u));
    engine.seek(4800);
    engine.record({ loop: [4800, 4800 + 4800] }); // 0.1 s loop
    await wait(450);
    const pos = engine.position;
    expect(pos).toBeGreaterThanOrEqual(4800);
    expect(pos).toBeLessThan(9600);
    const takes = engine.stop();
    expect(takes).toHaveLength(1);
    expect(takes[0].clip.length).toBeGreaterThan(48000 * 0.25);
    const r = new WavReader(path.join(dir, takes[0].clip.file));
    expect(r.frames).toBe(takes[0].clip.length);
    r.close();
    expect(updates.some((u) => u.state === 'recording' && u.recordLoop?.[0] === 4800)).toBe(true);
    expect(engine.position).toBe(4800);
    const merged = mergeRecording(p, takes, { recordStart: 4800, loop: [4800, 9600], events: [] }, 48000);
    expect(merged.tracks[0].takes!.length).toBeGreaterThanOrEqual(3);
  });

  it('records straight on without a loop', async () => {
    engine = new AudioEngine(null);
    engine.applyConfig({ api: VIRTUAL_API, inputDeviceId: 1, outputDeviceId: 2, sampleRate: 48000, bufferSize: 480 });
    const p = addTrack(createProject('Plain', 48000), { name: 'Anna', inputChannels: [2], armed: true });
    engine.setProject(p, tmpDir());
    engine.record({ loop: [0, 0] });
    await wait(200);
    const takes = engine.stop();
    expect(engine.position).toBe(takes[0].clip.length);
  });
});
