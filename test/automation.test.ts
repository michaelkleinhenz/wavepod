import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addAutomationPoint,
  automationValueAt,
  fillAutomation,
  formatPan,
  normalizeAutomation,
  parsePan,
  setTrackAutomation,
  shiftAutomation,
  showTrackAutomation,
  simplifyAutomation,
} from '../src/core/automation';
import { Mixer, ReaderCache } from '../src/core/mixer';
import { addTrack, createProject, insertSilence, normalizeProject, rippleDelete } from '../src/core/project';
import { rippleMove, rippleSet } from '../src/core/rippleMove';
import { projectToTemplate } from '../src/core/template';
import { panGains } from '../src/core/dsp';
import { writeWavFile } from '../src/core/wav';
import type { AutomationPoint } from '../src/shared/types';
import { tmpDir } from './helpers';

const pts = (...xs: Array<[number, number]>): AutomationPoint[] => xs.map(([pos, value]) => ({ pos, value }));

describe('automation lanes', () => {
  it('interpolates between points, holds outside them and steps at shared positions', () => {
    expect(automationValueAt(undefined, 5, 0.3)).toBe(0.3);
    const p = pts([100, -1], [200, 1], [300, 1], [300, 0]);
    expect(automationValueAt(p, 0)).toBe(-1);
    expect(automationValueAt(p, 150)).toBeCloseTo(0, 6);
    expect(automationValueAt(p, 299)).toBe(1);
    expect(automationValueAt(p, 300)).toBe(0);
    expect(automationValueAt(p, 1000)).toBe(0);
    const out = new Float32Array(5);
    fillAutomation(p, 148, 5, out);
    expect(Array.from(out).map((v) => Math.round(v * 100))).toEqual([-4, -2, 0, 2, 4]);
  });

  it('adds points in order and clamps values to the lane', () => {
    const { points, index } = addAutomationPoint('pan', pts([0, 0], [100, 0]), 50, 3);
    expect(index).toBe(1);
    expect(points[1]).toEqual({ pos: 50, value: 1 });
    expect(addAutomationPoint('volume', [], 10, -200).points[0].value).toBe(-60);
  });

  it('simplifies flat stretches and repeated end values but keeps steps', () => {
    expect(simplifyAutomation(pts([0, 0], [10, 0], [20, 0]))).toEqual(pts([0, 0]));
    expect(simplifyAutomation(pts([0, 0], [10, 0], [10, 1], [20, 1]))).toEqual(pts([10, 0], [10, 1]));
  });

  it('shifts points with ripple edits, holding the value across inserted time', () => {
    const p = pts([0, 0], [100, 1]);
    // insert 50 frames at 50: the ramp stops at 0.5, holds, then carries on
    const ins = shiftAutomation(p, 50, 50);
    expect(automationValueAt(ins, 50)).toBeCloseTo(0.5, 6);
    expect(automationValueAt(ins, 99)).toBeCloseTo(0.5, 6);
    expect(automationValueAt(ins, 150)).toBe(1);
    // delete [20, 60): the value at 20 meets the value at 60 with a step
    const del = shiftAutomation(p, 60, -40);
    expect(automationValueAt(del, 19)).toBeCloseTo(0.19, 6);
    expect(automationValueAt(del, 20)).toBeCloseTo(0.6, 6);
    expect(automationValueAt(del, 60)).toBe(1);
  });

  it('moves along with ripple delete, insert silence and ripple moves', () => {
    let p = addTrack(createProject('A', 48000), { name: 'Voice' });
    const id = p.tracks[0].id;
    p.tracks[0].clips.push({ id: 'c1', file: 'a.wav', start: 0, offset: 0, length: 1000, gain: 0, fadeIn: 0, fadeOut: 0 });
    p.tracks[0].clips.push({ id: 'c2', file: 'a.wav', start: 2000, offset: 0, length: 1000, gain: 0, fadeIn: 0, fadeOut: 0 });
    p = setTrackAutomation(p, id, 'pan', pts([2000, -1], [3000, 1]));
    expect(rippleDelete(p, 1000, 1500).tracks[0].automation!.pan).toEqual(pts([1500, -1], [2500, 1]));
    expect(insertSilence(p, 500, 100).tracks[0].automation!.pan).toEqual(pts([2100, -1], [3100, 1]));
    const moved = rippleMove(p, rippleSet(p, ['c2'], 'track'), -500);
    expect(moved.tracks[0].clips[1].start).toBe(1500);
    expect(moved.tracks[0].automation!.pan).toEqual(pts([1500, -1], [2500, 1]));
  });

  it('is saved with the episode, cleaned on load and left out of templates', () => {
    let p = addTrack(createProject('A', 48000), { name: 'Voice' });
    const id = p.tracks[0].id;
    p = setTrackAutomation(p, id, 'volume', pts([100, -6], [50, 0], [NaN, 3]));
    p = showTrackAutomation(p, id, 'volume');
    expect(p.tracks[0].automation).toEqual({ volume: pts([50, 0], [100, -6]), shown: 'volume' });
    const back = normalizeProject(JSON.parse(JSON.stringify(p)));
    expect(back.tracks[0].automation).toEqual(p.tracks[0].automation);
    expect(normalizeAutomation({ pan: [{ pos: 0, value: 9 }], shown: 'x' })).toEqual({ pan: pts([0, 1]) });
    expect(normalizeAutomation({ pan: [] })).toBeUndefined();
    expect(setTrackAutomation(p, id, 'volume', []).tracks[0].automation).toEqual({ shown: 'volume' });
    expect('automation' in projectToTemplate(p, 'T').tracks[0]).toBe(false);
  });

  it('reads and shows pan values', () => {
    expect(parsePan('C')).toBe(0);
    expect(parsePan('L 40')).toBe(-0.4);
    expect(parsePan('r25')).toBe(0.25);
    expect(parsePan('-100')).toBe(-1);
    expect(parsePan('30 L')).toBe(-0.3);
    expect(parsePan('250')).toBe(1);
    expect(parsePan('left')).toBeNull();
    expect(formatPan(0)).toBe('C');
    expect(formatPan(-0.4)).toBe('L 40');
    expect(formatPan(0.251)).toBe('R 25');
  });
});

describe('automation in the mixer', () => {
  const render = (dir: string, p: ReturnType<typeof createProject>) => {
    const readers = new ReaderCache(dir);
    const out = new Mixer(p, readers).render(0, 48000, [new Float32Array(48000), new Float32Array(48000)]);
    readers.closeAll();
    return out;
  };

  it('moves a mono voice across the stage and rides its level', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'media'));
    writeWavFile(path.join(dir, 'media/dc.wav'), [new Float32Array(48000).fill(0.5)], 48000);
    let p = addTrack(createProject('M', 48000), { name: 'Voice', pan: 0 });
    const id = p.tracks[0].id;
    p.tracks[0].clips.push({ id: 'c', file: 'media/dc.wav', start: 0, offset: 0, length: 48000, gain: 0, fadeIn: 0, fadeOut: 0 });
    p = setTrackAutomation(p, id, 'pan', pts([0, -1], [48000, 1]));
    let out = render(dir, p);
    const [l0, r0] = panGains(-1);
    expect(out[0][0]).toBeCloseTo(0.5 * l0, 4);
    expect(out[1][0]).toBeCloseTo(0.5 * r0, 4);
    const [lc, rc] = panGains(0);
    expect(out[0][24000]).toBeCloseTo(0.5 * lc, 3);
    expect(out[1][24000]).toBeCloseTo(0.5 * rc, 3);
    expect(out[1][47999]).toBeGreaterThan(out[0][47999] * 10);

    // volume automation multiplies with the track gain: -6 dB on top of the fader
    p = setTrackAutomation(p, id, 'pan', []);
    p.tracks[0].gain = -6;
    p = setTrackAutomation(p, id, 'volume', pts([0, 0], [24000, 0], [24000, -6]));
    out = render(dir, p);
    const g = Math.pow(10, -6 / 20);
    expect(out[0][1000]).toBeCloseTo(0.5 * lc * g, 4);
    expect(out[0][30000]).toBeCloseTo(0.5 * lc * g * g, 3);

    // fully down silences the track
    p = setTrackAutomation(p, id, 'volume', pts([0, -60]));
    out = render(dir, p);
    expect(out[0][100]).toBe(0);
  });

  it('uses balance for stereo material', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'media'));
    writeWavFile(path.join(dir, 'media/st.wav'), [new Float32Array(48000).fill(0.5), new Float32Array(48000).fill(0.5)], 48000);
    let p = addTrack(createProject('M', 48000), { name: 'Music', pan: 0 });
    p.tracks[0].clips.push({ id: 'c', file: 'media/st.wav', start: 0, offset: 0, length: 48000, gain: 0, fadeIn: 0, fadeOut: 0 });
    p = setTrackAutomation(p, p.tracks[0].id, 'pan', pts([0, 0], [24000, 0], [24000, 1]));
    const out = render(dir, p);
    expect(out[0][100]).toBeCloseTo(0.5, 5);
    expect(out[1][100]).toBeCloseTo(0.5, 5);
    expect(out[0][30000]).toBe(0);
    expect(out[1][30000]).toBeCloseTo(0.5, 5);
  });
});
