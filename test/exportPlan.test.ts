import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportProject } from '../src/core/exporter';
import { cleanFileName, defaultExportName, exportJobs, joinExportPath, plannedFiles, rangeAvailable, rangeSpan, type ExportRange } from '../src/core/exportPlan';
import { addMarker, addTrack, createProject } from '../src/core/project';
import { addRegion } from '../src/core/regions';
import { writeWavFile } from '../src/core/wav';
import type { ExportSettings, Project } from '../src/shared/types';
import { sine, tmpDir } from './helpers';

const sr = 8000;

function episode(): Project {
  let p = addTrack(createProject('Raw session', sr), { name: 'Host' });
  p = addTrack(p, { name: 'Guest/Remote' });
  p.metadata = { ...p.metadata, title: 'Episode 12: Tools?' };
  p.tracks[0].clips.push({ id: 'a', file: 'media/a.wav', start: 0, offset: 0, length: 4 * sr, gain: 0, fadeIn: 0, fadeOut: 0 });
  p.tracks[1].clips.push({ id: 'b', file: 'media/a.wav', start: sr, offset: 0, length: 3 * sr, gain: 0, fadeIn: 0, fadeOut: 0 });
  p = addRegion(p, 0, 2 * sr, 'Intro').project;
  p = addRegion(p, 2 * sr, 4 * sr, 'Main / talk').project;
  p = addMarker(p, 0, 'chapter', 'Hello').project;
  p = addMarker(p, 3 * sr, 'chapter', 'Later').project;
  return p;
}

const settings: ExportSettings = { formats: ['mp3', 'wav'], mp3Bitrate: 64, normalize: false, targetLufs: -16, peakCeiling: -1, stems: false, chapterFiles: true };

describe('export plan', () => {
  it('proposes the episode title, plus the region title for one region', () => {
    const p = episode();
    expect(defaultExportName(p, { kind: 'all' })).toBe('Episode 12 - Tools_');
    const main = p.regions![1];
    expect(defaultExportName(p, { kind: 'region', regionId: main.id })).toBe('Episode 12 - Tools_ - Main _ talk');
    expect(defaultExportName(p, { kind: 'region', regionId: 'gone' })).toBe('Episode 12 - Tools_');
    expect(defaultExportName({ ...p, metadata: { ...p.metadata, title: '' } }, { kind: 'all' })).toBe('Raw session');
    expect(cleanFileName('  a:b   c ')).toBe('a_b c');
  });

  it('joins paths with the folder’s own separator', () => {
    expect(joinExportPath('/home/me/export', 'Ep')).toBe('/home/me/export/Ep');
    expect(joinExportPath('/home/me/export/', 'Ep')).toBe('/home/me/export/Ep');
    expect(joinExportPath('C:\\Users\\me', 'Ep')).toBe('C:\\Users\\me\\Ep');
  });

  it('knows which ranges apply and what they cover', () => {
    const p = episode();
    const sel: [number, number] = [100, 900];
    expect(rangeAvailable({ kind: 'selection' }, p, null)).toBe(false);
    expect(rangeAvailable({ kind: 'selection' }, p, sel)).toBe(true);
    expect(rangeAvailable({ kind: 'region', regionId: 'gone' }, p, null)).toBe(false);
    expect(rangeAvailable({ kind: 'regions' }, { ...p, regions: [] }, null)).toBe(false);
    expect(rangeSpan({ kind: 'all' }, p, null)).toEqual([0, 4 * sr]);
    expect(rangeSpan({ kind: 'selection' }, p, sel)).toEqual(sel);
    expect(rangeSpan({ kind: 'region', regionId: p.regions![1].id }, p, null)).toEqual([2 * sr, 4 * sr]);
    // a region that is gone falls back to the whole episode
    expect(rangeSpan({ kind: 'region', regionId: 'gone' }, p, null)).toEqual([0, 4 * sr]);
  });

  it('makes one job for a region and one per region for each region', () => {
    const p = episode();
    const [intro, main] = p.regions!;
    expect(exportJobs({ kind: 'all' }, p, null, '/x/Ep')).toEqual([{ outputBase: '/x/Ep' }]);
    expect(exportJobs({ kind: 'region', regionId: main.id }, p, null, '/x/Ep')).toEqual([{ outputBase: '/x/Ep', start: 2 * sr, end: 4 * sr, region: 'Main / talk' }]);
    const each = exportJobs({ kind: 'regions' }, p, null, '/x/Ep');
    expect(each.map((j) => j.outputBase)).toEqual(['/x/Ep - 01 Intro', '/x/Ep - 02 Main _ talk']);
    expect(each[0]).toMatchObject({ start: intro.start, end: intro.end });
  });

  it('lists the files the exporter really writes', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'media'));
    writeWavFile(path.join(dir, 'media', 'a.wav'), [sine(220, 4, sr, 0.2)], sr);
    const p = episode();
    const cases: Array<[ExportRange, ExportSettings]> = [
      [{ kind: 'all' }, settings],
      [{ kind: 'region', regionId: p.regions![0].id }, { ...settings, formats: ['flac'], stems: true }],
      [{ kind: 'region', regionId: p.regions![1].id }, { ...settings, formats: ['opus'], stems: true, stemMode: 'dme', stemMe: true, stemFormat: 'flac' }],
    ];
    for (const [i, [range, s]] of cases.entries()) {
      const out = path.join(dir, `case${i}`);
      fs.mkdirSync(out);
      const [job] = exportJobs(range, p, null, path.join(out, 'Ep'));
      const res = exportProject(p, dir, { ...s, outputBase: job.outputBase, ...(job.start !== undefined ? { start: job.start, end: job.end } : {}) });
      expect(plannedFiles(p, s, job).sort()).toEqual(res.files.sort());
    }
    // no chapter starts in this range, so there are no chapter files
    expect(plannedFiles(p, { ...settings, formats: [] }, { outputBase: '/x/E', start: 3.5 * sr, end: 4 * sr })).toEqual([]);
  });
});
