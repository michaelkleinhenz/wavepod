import { describe, expect, it } from 'vitest';
import {
  clipPieces,
  loopClipTo,
  loopSeams,
  minClipOffset,
  parseRateInput,
  readClip,
  resetClipSound,
  setClipLoop,
  setClipRate,
  setClipReverse,
  type ClipSource,
} from '../src/core/clipSound';
import { loopClipsOver, loopClipsToNext, reverseClips } from '../src/core/clipOps';
import { splitClipsAt } from '../src/core/clipOps';
import { addTrack, createProject, normalizeProject } from '../src/core/project';
import type { Clip } from '../src/shared/types';

/** A mono "file" whose sample i is i / 10000 (so values tell where they were read from). */
function ramp(frames: number): ClipSource {
  return {
    info: { channels: 1, frames, sampleRate: 1000 },
    read(start, count) {
      const out = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        const k = start + i;
        out[i] = k >= 0 && k < frames ? k / 10000 : 0;
      }
      return [out];
    },
  };
}

const clip = (extra: Partial<Clip> = {}): Clip => ({ id: 'c', file: 'f.wav', start: 100, offset: 200, length: 400, gain: 0, fadeIn: 0, fadeOut: 0, ...extra });
const idx = (a: Float32Array) => Array.from(a, (v) => Math.round(v * 10000));
const src = ramp(5000);

describe('clip sound design', () => {
  it('reads a plain clip straight from its offset', () => {
    expect(idx(readClip(src, clip(), 10, 4)[0])).toEqual([210, 211, 212, 213]);
  });

  it('reverse plays the same audio backwards and keeps place and length', () => {
    const c = setClipReverse(clip(), true);
    expect(c.length).toBe(400);
    expect(c.start).toBe(100);
    expect(idx(readClip(src, c, 0, 3)[0])).toEqual([599, 598, 597]);
    expect(idx(readClip(src, c, 397, 3)[0])).toEqual([202, 201, 200]);
    // and forwards again is the plain clip it was
    expect(setClipReverse(c, false)).toEqual(clip());
  });

  it('varispeed shortens the clip and steps through the source faster', () => {
    const c = setClipRate(clip({ fadeOut: 100 }), 2);
    expect(c.length).toBe(200);
    expect(c.fadeOut).toBe(50);
    expect(idx(readClip(src, c, 0, 3)[0])).toEqual([200, 202, 204]);
    expect(idx(readClip(src, c, 199, 1)[0])).toEqual([598]);
    const back = setClipRate(c, 1);
    expect(back.sound).toBeUndefined();
    expect(back.length).toBe(400);
    expect(back.offset).toBe(200);
  });

  it('half speed interpolates between samples', () => {
    const c = setClipRate(clip(), 0.5);
    expect(c.length).toBe(800);
    const v = Array.from(readClip(src, c, 0, 4)[0], (x) => x * 10000);
    expect(v[0]).toBeCloseTo(200, 3);
    expect(v[1]).toBeCloseTo(200.5, 3);
    expect(v[2]).toBeCloseTo(201, 3);
  });

  it('reverse and varispeed combine', () => {
    const c = setClipRate(setClipReverse(clip(), true), 2);
    expect(c.length).toBe(200);
    expect(idx(readClip(src, c, 0, 2)[0])).toEqual([599, 597]);
  });

  it('a loop repeats what the clip played when stretched', () => {
    const c = loopClipTo(clip(), 100 + 1000);
    expect(c.length).toBe(1000);
    expect(c.sound?.loop).toBe(true);
    expect(loopSeams(c)).toEqual([400, 800]);
    // away from the seams it reads the cycle over and over
    expect(idx(readClip(src, c, 100, 2)[0])).toEqual([300, 301]);
    expect(idx(readClip(src, c, 500, 2)[0])).toEqual([300, 301]);
    expect(idx(readClip(src, c, 900, 2)[0])).toEqual([300, 301]);
    expect(idx(readClip(src, c, 400, 1)[0])).toEqual([200]);
  });

  it('crossfades loop seams into the run-up before the cycle', () => {
    const c = loopClipTo(clip(), 100 + 800);
    const out = readClip(src, c, 350, 50)[0];
    // just before the seam the next cycle's run-up (source just before 200) takes over
    expect(Math.round(out[49] * 10000)).toBeGreaterThan(190);
    expect(Math.round(out[49] * 10000)).toBeLessThan(260);
  });

  it('dips at the seam when the cycle has no run-up', () => {
    const c = loopClipTo(clip({ offset: 0 }), 100 + 800);
    const out = readClip(src, c, 399, 2)[0];
    // 399 would read 0.0399 and 400 wraps to 0: both are pulled towards silence
    expect(out[0]).toBeLessThan(0.0399 * 0.6);
    expect(Math.abs(out[1])).toBeLessThan(1e-6);
  });

  it('trimming the left edge of a loop keeps the phase', () => {
    const c = loopClipTo(clip(), 1100);
    // the same clip grown 50 frames to the left
    const grown = { ...c, start: c.start - 50, offset: c.offset - 50, length: c.length + 50 };
    expect(idx(readClip(src, grown, 50 + 100, 1)[0])).toEqual(idx(readClip(src, c, 100, 1)[0]));
    expect(idx(readClip(src, grown, 10, 1)[0])).toEqual([560]);
    expect(minClipOffset(c)).toBe(-Infinity);
    expect(minClipOffset(clip())).toBe(0);
  });

  it('loop off ends the clip with the cycle it starts in', () => {
    const c = setClipLoop(loopClipTo(clip(), 1100), false);
    expect(c.length).toBe(400);
    expect(c.sound).toBeUndefined();
  });

  it('splitting a sound-designed clip keeps the halves seamless', () => {
    let p = addTrack(createProject('S', 1000));
    p.tracks[0].clips.push(setClipRate(setClipReverse(clip(), true), 1.5));
    const whole = p.tracks[0].clips[0];
    p = splitClipsAt(p, new Set(['c']), 200).project;
    const [l, r] = p.tracks[0].clips;
    const joined = [...idx(readClip(src, l, 0, l.length)[0]), ...idx(readClip(src, r, 0, r.length)[0])];
    expect(joined).toEqual(idx(readClip(src, whole, 0, whole.length)[0]));
  });

  it('pieces stay single for one-shot clips and split per cycle for loops', () => {
    expect(clipPieces(setClipReverse(clip(), true))).toHaveLength(1);
    expect(clipPieces(loopClipTo(clip(), 1300))).toHaveLength(3);
  });

  it('reset plays the clip as recorded again', () => {
    const c = resetClipSound(loopClipTo(setClipRate(setClipReverse(clip(), true), 2), 2000));
    expect(c.sound).toBeUndefined();
  });

  it('survives saving and loading', () => {
    const p = addTrack(createProject('S', 1000));
    p.tracks[0].clips.push(loopClipTo(setClipRate(clip(), 1.25), 2000));
    const back = normalizeProject(JSON.parse(JSON.stringify(p)));
    expect(back.tracks[0].clips[0].sound).toEqual(p.tracks[0].clips[0].sound);
    const broken = JSON.parse(JSON.stringify(p));
    broken.tracks[0].clips[0].sound = { loop: true };
    expect(normalizeProject(broken).tracks[0].clips[0].sound).toBeUndefined();
  });

  it('reads typed speeds', () => {
    expect(parseRateInput('1.5')).toBe(1.5);
    expect(parseRateInput('2x')).toBe(2);
    expect(parseRateInput('80 %')).toBe(0.8);
    expect(parseRateInput('+12 st')).toBeCloseTo(2);
    expect(parseRateInput('-12st')).toBeCloseTo(0.5);
    expect(parseRateInput('100')).toBe(4);
    expect(parseRateInput('fast')).toBeNull();
  });
});

describe('sound design clip ops', () => {
  function project() {
    let p = createProject('C', 1000);
    p = addTrack(p, { name: 'A' });
    p = addTrack(p, { name: 'B' });
    p.tracks[0].clips.push(clip({ id: 'amb', start: 0, length: 500 }), clip({ id: 'next', start: 3000, length: 500 }));
    p.tracks[1].clips.push(clip({ id: 'b', start: 0, length: 5000 }));
    return p;
  }

  it('loops a clip until the next one on its track', () => {
    const c = loopClipsToNext(project(), new Set(['amb'])).tracks[0].clips[0];
    expect(c.length).toBe(3000);
    expect(c.sound?.loop).toBe(true);
  });

  it('loops the last clip to the end of the episode', () => {
    const c = loopClipsToNext(project(), new Set(['next'])).tracks[0].clips[1];
    expect(c.start + c.length).toBe(5000);
  });

  it('loops a clip over a selected range', () => {
    const c = loopClipsOver(project(), new Set(['amb']), [1000, 2500]).tracks[0].clips[0];
    expect([c.start, c.length]).toEqual([1000, 1500]);
  });

  it('reverses several clips at once', () => {
    const p = reverseClips(project(), new Set(['amb', 'b']), true);
    expect(p.tracks[0].clips[0].sound?.reverse).toBe(true);
    expect(p.tracks[1].clips[0].sound?.reverse).toBe(true);
    expect(p.tracks[0].clips[1].sound).toBeUndefined();
  });
});
