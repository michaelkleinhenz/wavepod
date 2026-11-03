import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportProject, measureLoudness } from '../src/core/exporter';
import { readId3Chapters } from '../src/core/id3';
import { LoudnessMeter } from '../src/core/loudness';
import { addMarker, addTrack, createProject } from '../src/core/project';
import { readWavFile, writeWavFile } from '../src/core/wav';
import { sine, tmpDir } from './helpers';

describe('exporter', () => {
  it('normalises the mix and writes WAV, MP3 with chapters, stems and chapter files', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'media'));
    const sr = 44100;
    writeWavFile(path.join(dir, 'media/a.wav'), [sine(300, 4, sr, 0.05)], sr);
    writeWavFile(path.join(dir, 'media/b.wav'), [sine(500, 4, sr, 0.05)], sr);
    let p = createProject('Export', sr);
    p.metadata = { ...p.metadata, title: 'Ep 1', podcast: 'Pod', author: 'Me' };
    p = addTrack(p, { name: 'Host' });
    p = addTrack(p, { name: 'Guest' });
    p.tracks[0].clips.push({ id: 'a', file: 'media/a.wav', start: 0, offset: 0, length: 4 * sr, gain: 0, fadeIn: 0, fadeOut: 0 });
    p.tracks[1].clips.push({ id: 'b', file: 'media/b.wav', start: 2 * sr, offset: 0, length: 4 * sr, gain: 0, fadeIn: 0, fadeOut: 0 });
    p = addMarker(p, 0, 'chapter', 'Intro').project;
    p = addMarker(p, 3 * sr, 'chapter', 'Talk').project;
    p = addMarker(p, sr, 'edit', 'fix').project;

    const before = measureLoudness(p, dir);
    expect(before.integrated).toBeLessThan(-20);

    const phases = new Set<string>();
    const res = exportProject(
      p,
      dir,
      {
        outputBase: path.join(dir, 'export', 'ep1'),
        formats: ['wav', 'mp3'],
        mp3Bitrate: 128,
        normalize: true,
        targetLufs: -16,
        peakCeiling: -1,
        stems: true,
        chapterFiles: true,
      },
      (pr) => phases.add(pr.phase),
    );
    expect(phases.has('Rendering mix')).toBe(true);
    expect(res.appliedGainDb).toBeGreaterThan(5);
    const names = res.files.map((f) => path.basename(f));
    expect(names).toEqual(
      expect.arrayContaining(['ep1.wav', 'ep1.mp3', 'ep1-01-Host.wav', 'ep1-02-Guest.wav', 'ep1.psc.xml', 'ep1.chapters.json', 'ep1.chapters.txt']),
    );

    const { info, channels } = readWavFile(path.join(dir, 'export/ep1.wav'));
    expect(info.frames).toBe(6 * sr);
    const m = new LoudnessMeter(sr, 2);
    m.push(channels);
    expect(m.integrated()).toBeCloseTo(-16, 0);
    expect(m.peakDb()).toBeLessThanOrEqual(-1 + 0.01);

    const mp3 = fs.readFileSync(path.join(dir, 'export/ep1.mp3'));
    const ch = readId3Chapters(mp3);
    expect(ch.map((c) => c.title)).toEqual(['Intro', 'Talk']);
    expect(ch[1].start).toBeCloseTo(3);
    expect(mp3.length).toBeGreaterThan(50_000);

    const json = JSON.parse(fs.readFileSync(path.join(dir, 'export/ep1.chapters.json'), 'utf8'));
    expect(json.chapters).toHaveLength(2);
  });
});
