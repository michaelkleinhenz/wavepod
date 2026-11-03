import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Mixer, ReaderCache } from '../src/core/mixer';
import { addMuteRegion, insertIntoRegions, mergeRegions, muteGainAt, removeMuteRegion, rippleRegions, updateMuteRegion } from '../src/core/muteRegions';
import { addTrack, createProject, insertSilence, normalizeProject, rippleDelete } from '../src/core/project';
import { writeWavFile } from '../src/core/wav';
import { tmpDir } from './helpers';

describe('mute regions', () => {
  it('merges overlapping regions and drops empty ones', () => {
    expect(mergeRegions([[50, 80], [10, 20], [15, 30], [40, 40], [80, 90]])).toEqual([[10, 30], [50, 90]]);
  });

  it('adds, updates and removes regions per track', () => {
    let p = addTrack(createProject(), { name: 'Host' });
    const id = p.tracks[0].id;
    p = addMuteRegion(p, id, 300, 100);
    p = addMuteRegion(p, id, 1000, 1200);
    expect(p.tracks[0].muteRegions).toEqual([[100, 300], [1000, 1200]]);
    p = updateMuteRegion(p, id, 0, 100, 1100);
    expect(p.tracks[0].muteRegions).toEqual([[100, 1200]]);
    p = removeMuteRegion(p, id, 0);
    expect(p.tracks[0].muteRegions).toEqual([]);
    expect(normalizeProject(JSON.parse(JSON.stringify(addMuteRegion(p, id, 5, 9)))).tracks[0].muteRegions).toEqual([[5, 9]]);
  });

  it('follow ripple deletes and inserted silence', () => {
    expect(rippleRegions([[0, 10], [20, 40], [50, 60], [100, 120]], 30, 55)).toEqual([[0, 10], [20, 35], [75, 95]]);
    expect(insertIntoRegions([[0, 10], [20, 40], [50, 60]], 30, 100)).toEqual([[0, 10], [20, 30], [130, 140], [150, 160]]);
    let p = addTrack(createProject(), { name: 'Host' });
    p = addMuteRegion(p, p.tracks[0].id, 1000, 2000);
    expect(rippleDelete(p, 0, 500).tracks[0].muteRegions).toEqual([[500, 1500]]);
    expect(insertSilence(p, 0, 500).tracks[0].muteRegions).toEqual([[1500, 2500]]);
  });

  it('ramps at the edges and is silent inside', () => {
    const r: Array<[number, number]> = [[100, 200]];
    expect(muteGainAt(r, 99, 10)).toBe(1);
    expect(muteGainAt(r, 100, 10)).toBe(1);
    expect(muteGainAt(r, 105, 10)).toBeCloseTo(0.5);
    expect(muteGainAt(r, 150, 10)).toBe(0);
    expect(muteGainAt(r, 195, 10)).toBeCloseTo(0.5);
    expect(muteGainAt(r, 200, 10)).toBe(1);
    expect(muteGainAt(undefined, 150, 10)).toBe(1);
  });

  it('silences the track in the mixer without touching the audio file', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'media'));
    writeWavFile(path.join(dir, 'media/dc.wav'), [new Float32Array(48000).fill(0.5)], 48000);
    let p = addTrack(createProject('M', 48000), { name: 'Host', pan: 0 });
    p.tracks[0].clips.push({ id: 'c', file: 'media/dc.wav', start: 0, offset: 0, length: 48000, gain: 0, fadeIn: 0, fadeOut: 0 });
    p = addMuteRegion(p, p.tracks[0].id, 10000, 20000);
    const readers = new ReaderCache(dir);
    const out = [new Float32Array(48000), new Float32Array(48000)];
    new Mixer(p, readers).render(0, 48000, out);
    readers.closeAll();
    const ref = out[0][5000];
    expect(ref).toBeGreaterThan(0.2);
    expect(out[0][15000]).toBe(0);
    expect(out[0][10240]).toBeCloseTo(ref / 2, 2); // halfway through the 10 ms ramp
    expect(out[0][25000]).toBeCloseTo(ref, 5);
  });
});
