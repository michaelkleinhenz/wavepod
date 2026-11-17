import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { StageRenderer, earAngles, earDelay, shadowAlpha } from '../src/core/binaural';
import {
  azimuthToPan,
  formatAzimuth,
  formatDistance,
  parseAzimuth,
  placeOnStage,
  removeFromStage,
  setStageMode,
  stageAt,
  stageMode,
  wrapAzimuth,
} from '../src/core/stage';
import { setTrackAutomation, shiftAutomation, mapTrackAutomation } from '../src/core/automation';
import { Mixer, ReaderCache } from '../src/core/mixer';
import { addTrack, createProject, normalizeProject } from '../src/core/project';
import { createFx } from '../src/core/fx/definitions';
import { writeWavFile } from '../src/core/wav';
import { radiusDistance, stageRadius } from '../src/renderer/stagePanel';
import type { Project, StagePosition } from '../src/shared/types';
import { sine, tmpDir } from './helpers';

const SR = 48000;
const rms = (x: Float32Array, from = 0, to = x.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / (to - from));
};
const db = (a: number, b: number) => 20 * Math.log10(a / b);

/** Renders a mono signal at a fixed place through a fresh renderer. */
function place(signal: Float32Array, pos: StagePosition, speakers = false): [Float32Array, Float32Array] {
  const r = new StageRenderer(SR);
  const l = new Float32Array(signal.length);
  const rr = new Float32Array(signal.length);
  r.process(signal, l, rr, signal.length, pos, { speakers, distanceCues: true });
  return [l, rr];
}

/** Lag (frames) of b behind a, found by cross-correlation within ±maxLag. */
function lag(a: Float32Array, b: Float32Array, maxLag: number): number {
  let best = 0;
  let bestV = -Infinity;
  for (let k = -maxLag; k <= maxLag; k++) {
    let s = 0;
    for (let i = maxLag; i < a.length - maxLag; i++) s += a[i] * b[i + k];
    if (s > bestV) {
      bestV = s;
      best = k;
    }
  }
  return best;
}

function noise(n: number, seed = 1): Float32Array {
  let x = seed;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (x / 0x7fffffff - 0.5) * 0.5;
  }
  return out;
}

describe('head model', () => {
  it('delays the far ear by up to about 0.65 ms', () => {
    expect(earDelay(0)).toBe(0);
    expect(earDelay(Math.PI / 2)).toBeCloseTo(0.0875 / 343, 6);
    expect(earDelay(Math.PI) * 1000).toBeGreaterThan(0.6);
    expect(earDelay(Math.PI) * 1000).toBeLessThan(0.7);
  });

  it('lifts the highs at the near ear and shades them at the far one', () => {
    expect(shadowAlpha(0)).toBeCloseTo(2, 5);
    expect(shadowAlpha((150 * Math.PI) / 180)).toBeCloseTo(0.1, 5);
    const [l, r] = earAngles({ azimuth: 90, elevation: 0, distance: 1 });
    expect(r).toBeCloseTo(0, 5);
    expect(l).toBeCloseTo(Math.PI, 5);
  });
});

describe('binaural rendering', () => {
  const sig = noise(SR / 2);

  it('keeps a voice in front centred, at the level of a centred pan', () => {
    const [l, r] = place(sig, { azimuth: 0, elevation: 0, distance: 1 });
    expect(Math.abs(db(rms(l), rms(r)))).toBeLessThan(0.01);
    expect(lag(l, r, 40)).toBe(0);
    expect(Math.abs(db(rms(l), rms(sig)))).toBeLessThan(2);
  });

  it('puts a voice on the right: louder and earlier in the right ear', () => {
    const [l, r] = place(sig, { azimuth: 90, elevation: 0, distance: 1 });
    expect(db(rms(r), rms(l))).toBeGreaterThan(4);
    // the left ear hears it about 0.65 ms (31 frames at 48 kHz) later
    const d = lag(r, l, 40);
    expect(d).toBeGreaterThanOrEqual(28);
    expect(d).toBeLessThanOrEqual(34);
    const [l2, r2] = place(sig, { azimuth: -90, elevation: 0, distance: 1 });
    expect(db(rms(l2), rms(r2))).toBeGreaterThan(4);
  });

  it('dulls a voice behind compared with the same voice in front', () => {
    const hi = sine(8000, 0.5, SR);
    const [fl] = place(hi, { azimuth: 30, elevation: 0, distance: 1 });
    const [bl] = place(hi, { azimuth: 150, elevation: 0, distance: 1 });
    expect(db(rms(fl, 2000), rms(bl, 2000))).toBeGreaterThan(4);
    // low frequencies hardly change: front/back is in the highs
    const lo = sine(200, 0.5, SR);
    const [fl2] = place(lo, { azimuth: 30, elevation: 0, distance: 1 });
    const [bl2] = place(lo, { azimuth: 150, elevation: 0, distance: 1 });
    expect(Math.abs(db(rms(fl2, 2000), rms(bl2, 2000)))).toBeLessThan(1.5);
  });

  it('makes a voice quieter and duller further away', () => {
    const [near] = place(sig, { azimuth: 0, elevation: 0, distance: 1 });
    const [far] = place(sig, { azimuth: 0, elevation: 0, distance: 8 });
    expect(db(rms(near), rms(far))).toBeGreaterThan(12);
  });

  it('pans by the angle in speakers mode, with no interaural delay', () => {
    const [l, r] = place(sig, { azimuth: 90, elevation: 0, distance: 1 }, true);
    expect(rms(l)).toBeLessThan(1e-6);
    expect(rms(r)).toBeGreaterThan(0.1);
    const [l2, r2] = place(sig, { azimuth: 0, elevation: 0, distance: 1 }, true);
    expect(Math.abs(db(rms(l2), rms(r2)))).toBeLessThan(0.01);
    expect(azimuthToPan(180)).toBeCloseTo(0, 6);
  });

  it('glides when the voice moves, without clicks', () => {
    const r = new StageRenderer(SR);
    const tone = sine(300, 1, SR, 0.5);
    const l = new Float32Array(tone.length);
    const rr = new Float32Array(tone.length);
    const block = 512;
    for (let p = 0; p < tone.length; p += block) {
      const az = -90 + (180 * (p + block)) / tone.length;
      r.process(tone.subarray(p, p + block), l.subarray(p, p + block), rr.subarray(p, p + block), block, { azimuth: az, elevation: 0, distance: 1 });
    }
    // a 300 Hz sine at 0.5 changes by at most ~0.02 per sample; a click would jump far more
    let maxStep = 0;
    for (let i = 1; i < l.length; i++) maxStep = Math.max(maxStep, Math.abs(l[i] - l[i - 1]), Math.abs(rr[i] - rr[i - 1]));
    expect(maxStep).toBeLessThan(0.05);
    // it started on the left and ended on the right
    expect(rms(l, 0, 4800)).toBeGreaterThan(rms(rr, 0, 4800));
    expect(rms(rr, SR - 4800)).toBeGreaterThan(rms(l, SR - 4800));
  });
});

describe('stage edits', () => {
  const project = () => addTrack(addTrack(createProject('S', SR), { name: 'Anna', pan: -0.5 }), { name: 'Ben' });

  it('puts a track on the stage where its pan was, at 1 m', () => {
    const base = project();
    const p = placeOnStage(base, [base.tracks[0].id]);
    const t = placeOnStage(base, base.tracks.map((x) => x.id)).tracks;
    expect(t[0].stage).toEqual({ azimuth: -45, elevation: 0, distance: 1 });
    expect(t[1].stage).toEqual({ azimuth: 0, elevation: 0, distance: 1 });
    expect(p.tracks[1].stage).toBeUndefined();
  });

  it('changes only the values given, and clamps them', () => {
    let p = project();
    const id = p.tracks[0].id;
    p = placeOnStage(p, [id], { distance: 3 });
    p = placeOnStage(p, [id], { elevation: 200, azimuth: 270 });
    expect(p.tracks[0].stage).toEqual({ azimuth: -90, elevation: 90, distance: 3 });
    p = placeOnStage(p, [id], { distance: 0.01 });
    expect(p.tracks[0].stage!.distance).toBe(0.3);
  });

  it('takes a track off the stage with its angle and distance lanes', () => {
    let p = project();
    const id = p.tracks[0].id;
    p = placeOnStage(p, [id]);
    p = setTrackAutomation(p, id, 'angle', [{ pos: 0, value: -90 }, { pos: SR, value: 90 }]);
    p = setTrackAutomation(p, id, 'volume', [{ pos: 0, value: -3 }]);
    p.tracks[0].automation!.shown = 'angle';
    p = removeFromStage(p, [id]);
    expect(p.tracks[0].stage).toBeUndefined();
    expect(p.tracks[0].automation).toEqual({ volume: [{ pos: 0, value: -3 }] });
  });

  it('follows the angle and distance lanes over time', () => {
    let p = project();
    const id = p.tracks[0].id;
    p = placeOnStage(p, [id], { elevation: 20 });
    p = setTrackAutomation(p, id, 'angle', [{ pos: 0, value: -90 }, { pos: SR, value: 90 }]);
    p = setTrackAutomation(p, id, 'distance', [{ pos: 0, value: 1 }, { pos: SR, value: 5 }]);
    expect(stageAt(p.tracks[0], SR / 2)).toEqual({ azimuth: 0, elevation: 20, distance: 3 });
    // lanes are clamped to their ranges
    p = setTrackAutomation(p, id, 'distance', [{ pos: 0, value: 500 }]);
    expect(p.tracks[0].automation!.distance![0].value).toBe(30);
    // ripple edits move them along with the audio
    const t = structuredClone(p.tracks[0]);
    mapTrackAutomation(t, (pts) => shiftAutomation(pts, 0, 1000));
    expect(t.automation!.angle![0].pos).toBe(1000);
  });

  it('switches between binaural and speakers', () => {
    let p = project();
    expect(stageMode(p)).toBe('binaural');
    p = setStageMode(p, 'speakers');
    expect(stageMode(p)).toBe('speakers');
    p = setStageMode(p, 'binaural');
    expect(p.stage).toBeUndefined();
  });

  it('survives saving and loading, and drops broken values', () => {
    let p = project();
    p = placeOnStage(p, [p.tracks[0].id], { azimuth: 120, distance: 4 });
    p = setStageMode(p, 'speakers');
    p = setTrackAutomation(p, p.tracks[0].id, 'distance', [{ pos: 10, value: 2 }]);
    const back = normalizeProject(JSON.parse(JSON.stringify(p)));
    expect(back.tracks[0].stage).toEqual({ azimuth: 120, elevation: 0, distance: 4 });
    expect(back.stage).toEqual({ mode: 'speakers' });
    expect(back.tracks[0].automation!.distance).toEqual([{ pos: 10, value: 2 }]);
    const broken = normalizeProject({ ...p, stage: { mode: 'x' as never }, tracks: [{ ...p.tracks[0], stage: { azimuth: 'left' as never, elevation: 0, distance: 1 } }] });
    expect(broken.tracks[0].stage).toBeUndefined();
    expect(broken.stage).toBeUndefined();
  });

  it('reads and shows angles and distances the way people write them', () => {
    expect(parseAzimuth('R 30')).toBe(30);
    expect(parseAzimuth('l45')).toBe(-45);
    expect(parseAzimuth('-120°')).toBe(-120);
    expect(parseAzimuth('behind')).toBe(180);
    expect(parseAzimuth('front')).toBe(0);
    expect(parseAzimuth('270')).toBe(-90);
    expect(parseAzimuth('up')).toBeNull();
    expect(formatAzimuth(0)).toBe('Front');
    expect(formatAzimuth(-180)).toBe('Behind');
    expect(formatAzimuth(30.4)).toBe('R 30°');
    expect(formatAzimuth(-90)).toBe('L 90°');
    expect(formatDistance(1.25)).toBe('1.3 m');
    expect(formatDistance(12.4)).toBe('12 m');
    expect(wrapAzimuth(-180)).toBe(180);
    expect(wrapAzimuth(540)).toBe(180);
  });

  it('maps distances to the stage drawing and back', () => {
    for (const d of [0.3, 1, 3, 10, 30]) expect(radiusDistance(stageRadius(d, 150), 150)).toBeCloseTo(d, 6);
    expect(stageRadius(1, 150)).toBeLessThan(stageRadius(3, 150));
  });
});

describe('stage in the mixer', () => {
  const setup = (opts: { fx?: boolean } = {}) => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'media'));
    writeWavFile(path.join(dir, 'media/v.wav'), [noise(SR)], SR);
    let p = addTrack(createProject('M', SR), { name: 'Voice', pan: 0 });
    p.tracks[0].clips.push({ id: 'c', file: 'media/v.wav', start: 0, offset: 0, length: SR, gain: 0, fadeIn: 0, fadeOut: 0 });
    if (opts.fx) p.tracks[0].fx = [createFx('space', { distance: 1, size: 30, decay: 0.4, room: 12, early: 20 })];
    p = placeOnStage(p, [p.tracks[0].id]);
    return { dir, p };
  };
  const render = (dir: string, p: Project) => {
    const readers = new ReaderCache(dir);
    const mixer = new Mixer(p, readers);
    const out = [new Float32Array(SR), new Float32Array(SR)];
    for (let pos = 0; pos < SR; pos += 1024) {
      const n = Math.min(1024, SR - pos);
      const o = mixer.render(pos, n, [new Float32Array(n), new Float32Array(n)]);
      out[0].set(o[0], pos);
      out[1].set(o[1], pos);
    }
    readers.closeAll();
    return out;
  };

  it('ignores pan for a placed track and renders it from its place', () => {
    let { dir, p } = setup();
    p.tracks[0].pan = -1;
    p = placeOnStage(p, [p.tracks[0].id], { azimuth: 90 });
    const [l, r] = render(dir, p);
    expect(db(rms(r), rms(l))).toBeGreaterThan(4);
  });

  it('moves the voice with the angle lane', () => {
    let { dir, p } = setup();
    p = setTrackAutomation(p, p.tracks[0].id, 'angle', [{ pos: 0, value: -90 }, { pos: SR, value: 90 }]);
    const [l, r] = render(dir, p);
    expect(db(rms(l, 0, 4800), rms(r, 0, 4800))).toBeGreaterThan(3);
    expect(db(rms(r, SR - 4800), rms(l, SR - 4800))).toBeGreaterThan(3);
  });

  it('lets a Room & distance filter take the stage distance instead of adding its own', () => {
    // same distance either way: the filter at its own 4 m vs. the stage at 4 m over a filter set to 1 m
    const a = setup({ fx: true });
    a.p.tracks[0].fx![0].params.distance = 4;
    const off = removeFromStage(a.p, [a.p.tracks[0].id]);
    const [lo, ro] = render(a.dir, off);
    const b = setup({ fx: true });
    const on = placeOnStage(b.p, [b.p.tracks[0].id], { distance: 4 });
    const [l, r] = render(b.dir, on);
    // not attenuated twice: within 1.5 dB of the filter on its own
    expect(Math.abs(db(rms(l) + rms(r), rms(lo) + rms(ro)))).toBeLessThan(1.5);
    // and still centred in front
    expect(Math.abs(db(rms(l), rms(r)))).toBeLessThan(1);
  });

  it('pans placed voices in speakers mode', () => {
    let { dir, p } = setup();
    p = placeOnStage(p, [p.tracks[0].id], { azimuth: -90 });
    p = setStageMode(p, 'speakers');
    const [l, r] = render(dir, p);
    expect(rms(r)).toBeLessThan(1e-6);
    expect(rms(l)).toBeGreaterThan(0.05);
  });
});
