import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportProject } from '../src/core/exporter';
import { addTrack, createProject, insertSilence, normalizeProject, rippleDelete } from '../src/core/project';
import { addRegion, normalizeRegions, regionOutputBase, removeRegion, updateRegion } from '../src/core/regions';
import { rippleMove, rippleSet } from '../src/core/rippleMove';
import { projectFromTemplate, projectToTemplate } from '../src/core/template';
import { writeWavFile } from '../src/core/wav';
import { sine, tmpDir } from './helpers';

describe('regions', () => {
  it('adds, renames and removes regions, sorted by start', () => {
    let p = createProject('R', 48000);
    p = addRegion(p, 500, 300).project;
    const r = addRegion(p, 100, 200, 'Intro');
    p = r.project;
    expect(p.regions!.map((x) => [x.start, x.end, x.title])).toEqual([[100, 200, 'Intro'], [300, 500, 'Part 1']]);
    p = updateRegion(p, r.region.id, { start: 900, end: 800, title: 'Outro' });
    expect(p.regions!.map((x) => [x.start, x.end, x.title])).toEqual([[300, 500, 'Part 1'], [800, 900, 'Outro']]);
    p = removeRegion(p, r.region.id);
    expect(p.regions).toHaveLength(1);
  });

  it('follow ripple cuts, inserted time and ripple moves on all tracks', () => {
    let p = addTrack(createProject('R', 48000));
    p.tracks[0].clips.push({ id: 'a', file: 'a.wav', start: 0, offset: 0, length: 1000, gain: 0, fadeIn: 0, fadeOut: 0 });
    p.tracks[0].clips.push({ id: 'b', file: 'a.wav', start: 2000, offset: 0, length: 1000, gain: 0, fadeIn: 0, fadeOut: 0 });
    p = addRegion(p, 100, 400, 'A').project;
    p = addRegion(p, 600, 900, 'B').project;
    p = addRegion(p, 2000, 3000, 'C').project;
    const cut = rippleDelete(p, 300, 700);
    expect(cut.regions!.map((x) => [x.start, x.end])).toEqual([[100, 300], [300, 500], [1600, 2600]]);
    const ins = insertSilence(p, 200, 50);
    expect(ins.regions!.map((x) => [x.start, x.end])).toEqual([[100, 450], [650, 950], [2050, 3050]]);
    const moved = rippleMove(p, rippleSet(p, ['b'], 'all'), 500);
    expect(moved.regions!.map((x) => [x.start, x.end])).toEqual([[100, 400], [600, 900], [2500, 3500]]);
    const trackOnly = rippleMove(p, rippleSet(p, ['b'], 'track'), 500);
    expect(trackOnly.regions![2].start).toBe(2000);
  });

  it('survive loading and drop broken entries', () => {
    expect(normalizeRegions([{ id: 'x', start: 10, end: 5, title: 'T' }, { start: 3, end: 3 }, null, { start: 'a' }])).toEqual([{ id: 'x', start: 5, end: 10, title: 'T' }]);
    const p = normalizeProject({ ...createProject('R'), regions: [{ id: 'r', start: 1, end: 2, title: 'R' }] });
    expect(p.regions).toHaveLength(1);
  });

  it('name their export files', () => {
    expect(regionOutputBase('/x/Show', 0, 'Episode 1: Hello?')).toBe('/x/Show - 01 Episode 1_ Hello_');
    expect(regionOutputBase('/x/Show', 11, '')).toBe('/x/Show - 12');
  });
});

describe('podcast category', () => {
  it('is written as the genre and kept in templates', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'media'));
    const sr = 44100;
    writeWavFile(path.join(dir, 'media/a.wav'), [sine(300, 1, sr, 0.1)], sr);
    let p = addTrack(createProject('Cat', sr), { name: 'Host' });
    p.tracks[0].clips.push({ id: 'a', file: 'media/a.wav', start: 0, offset: 0, length: sr, gain: 0, fadeIn: 0, fadeOut: 0 });
    p.metadata = { ...p.metadata, podcast: 'Show', category: 'Technology' };
    exportProject(p, dir, { outputBase: path.join(dir, 'out'), formats: ['mp3', 'flac'], mp3Bitrate: 64, normalize: false, targetLufs: -16, peakCeiling: -1, stems: false, chapterFiles: false });
    const mp3 = fs.readFileSync(path.join(dir, 'out.mp3'));
    const tcon = mp3.indexOf('TCON');
    expect(tcon).toBeGreaterThan(0);
    expect(mp3.subarray(tcon + 13, tcon + 40).toString('utf16le')).toContain('Technology');
    expect(fs.readFileSync(path.join(dir, 'out.flac')).toString('latin1')).toContain('GENRE=Technology');
    const t = projectToTemplate(p, 'T');
    expect(t.metadata.category).toBe('Technology');
    expect(projectFromTemplate(t, 'Next', sr).metadata.category).toBe('Technology');
  });
});
