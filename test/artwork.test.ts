import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportChapters, importChapters } from '../src/core/chapters';
import { exportProject } from '../src/core/exporter';
import { buildId3Tag, imageMime, readId3Chapters, readId3Cover } from '../src/core/id3';
import { LoudnessMeter } from '../src/core/loudness';
import { addMarker, addTrack, chapterWarnings, createProject } from '../src/core/project';
import { projectFromTemplate, projectToTemplate } from '../src/core/template';
import { readWavFile, writeWavFile } from '../src/core/wav';
import { importImage } from '../src/main/projectStore';
import { sine, tmpDir } from './helpers';

// smallest valid-looking headers are enough: WavePod only sniffs the type and copies the bytes
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-body')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg-body')]);

describe('ID3 pictures', () => {
  it('recognises JPEG and PNG only', () => {
    expect(imageMime(PNG)).toBe('image/png');
    expect(imageMime(JPEG)).toBe('image/jpeg');
    expect(imageMime(Buffer.from('GIF89a....'))).toBeNull();
  });

  it('embeds the cover and per-chapter images', () => {
    const tag = buildId3Tag({
      title: 'Ep',
      cover: { mime: 'image/jpeg', data: JPEG },
      chapters: [
        { start: 0, title: 'Intro', picture: { mime: 'image/png', data: PNG } },
        { start: 10, title: 'Talk' },
      ],
      durationSeconds: 20,
    });
    const cover = readId3Cover(tag)!;
    expect(cover.mime).toBe('image/jpeg');
    expect(cover.data.equals(JPEG)).toBe(true);
    const chapters = readId3Chapters(tag);
    expect(chapters[0].picture?.mime).toBe('image/png');
    expect(chapters[0].picture?.data.equals(PNG)).toBe(true);
    expect(chapters[1].picture).toBeUndefined();
  });
});

describe('chapter files with images', () => {
  it('writes and reads image references in PSC and Podcasting 2.0 JSON', () => {
    const list = [{ start: 0, title: 'Intro', image: 'ep-chapter-01.jpg' }, { start: 5, title: 'Talk' }];
    const psc = exportChapters(list, 'psc');
    expect(psc).toContain('image="ep-chapter-01.jpg"');
    expect(importChapters(psc)[0].image).toBe('ep-chapter-01.jpg');
    const json = exportChapters(list, 'json');
    expect(JSON.parse(json).chapters[0].img).toBe('ep-chapter-01.jpg');
    expect(importChapters(json)[0].image).toBe('ep-chapter-01.jpg');
    expect(importChapters(json)[1].image).toBeUndefined();
  });
});

describe('chapter warnings', () => {
  it('reports a missing chapter at the start and untitled chapters', () => {
    const sr = 48000;
    let p = createProject('W', sr);
    expect(chapterWarnings(p)).toEqual([]);
    p = addMarker(p, 10 * sr, 'chapter', 'Talk').project;
    p = addMarker(p, 70 * sr, 'chapter', '  ').project;
    p = addMarker(p, 5 * sr, 'edit', '').project; // edit markers don't count
    const w = chapterWarnings(p);
    expect(w.map((x) => x.kind)).toEqual(['no-start', 'untitled']);
    expect(w[1].message).toContain('1:10');
    // a chapter within half a second of the start is fine
    p = addMarker(p, sr / 4, 'chapter', 'Intro').project;
    expect(chapterWarnings(p).map((x) => x.kind)).toEqual(['untitled']);
    // against an exported range, the range start counts
    expect(chapterWarnings(p, 10 * sr, 60 * sr)).toEqual([]);
    expect(chapterWarnings(p, 9 * sr, 60 * sr).map((x) => x.kind)).toEqual(['no-start']);
  });
});

describe('project images', () => {
  it('copies an outside image into images/ and keeps one inside the project where it is', () => {
    const dir = tmpDir();
    const outside = path.join(tmpDir(), 'My Cover!.png');
    fs.writeFileSync(outside, PNG);
    expect(importImage(dir, outside)).toBe('images/My Cover_.png');
    expect(importImage(dir, outside)).toBe('images/My Cover_-2.png');
    expect(importImage(dir, path.join(dir, 'images/My Cover_.png'))).toBe('images/My Cover_.png');
    const gif = path.join(dir, 'x.gif');
    fs.writeFileSync(gif, 'GIF89a');
    expect(() => importImage(dir, gif)).toThrow(/JPEG or PNG/);
  });

  it('templates keep the episode cover', () => {
    const p = createProject('T', 48000);
    p.metadata.artwork = 'images/cover.jpg';
    const t = projectToTemplate(p, 'Show');
    expect(t.metadata.artwork).toBe('images/cover.jpg');
    expect(projectFromTemplate(t, 'New', 48000).metadata.artwork).toBe('images/cover.jpg');
  });
});

describe('export with artwork', () => {
  it('embeds cover and chapter images and copies chapter images next to the chapter files', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'media'));
    fs.mkdirSync(path.join(dir, 'images'));
    fs.writeFileSync(path.join(dir, 'images/cover.jpg'), JPEG);
    fs.writeFileSync(path.join(dir, 'images/intro.png'), PNG);
    const sr = 44100;
    writeWavFile(path.join(dir, 'media/a.wav'), [sine(300, 2, sr, 0.1)], sr);
    let p = createProject('Art', sr);
    p.metadata.artwork = 'images/cover.jpg';
    p = addTrack(p, { name: 'Host' });
    p.tracks[0].clips.push({ id: 'a', file: 'media/a.wav', start: 0, offset: 0, length: 2 * sr, gain: 0, fadeIn: 0, fadeOut: 0 });
    p = addMarker(p, 0, 'chapter', 'Intro').project;
    p.markers[0].image = 'images/intro.png';
    p = addMarker(p, sr, 'chapter', 'Missing image').project;
    p.markers[1].image = 'images/gone.png';
    const base = path.join(dir, 'export', 'ep');
    const res = exportProject(p, dir, {
      outputBase: base,
      formats: ['mp3'],
      mp3Bitrate: 128,
      normalize: false,
      targetLufs: -16,
      peakCeiling: -1,
      stems: false,
      chapterFiles: true,
    });
    const mp3 = fs.readFileSync(`${base}.mp3`);
    expect(readId3Cover(mp3)!.data.equals(JPEG)).toBe(true);
    const chapters = readId3Chapters(mp3);
    expect(chapters[0].picture!.data.equals(PNG)).toBe(true);
    expect(chapters[1].picture).toBeUndefined();
    expect(res.files).toContain(path.join(dir, 'export', 'ep-chapter-01.png'));
    const json = JSON.parse(fs.readFileSync(`${base}.chapters.json`, 'utf8'));
    expect(json.chapters[0].img).toBe('ep-chapter-01.png');
    expect(json.chapters[1].img).toBeUndefined();
  });
});

describe('export peak ceiling', () => {
  it('limits normalisation by true peak, so the file stays under the ceiling in dBTP', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'media'));
    const sr = 44100;
    // a tone near a quarter of the sample rate, phased so samples miss the crests: true peak > sample peak
    const n = 3 * sr;
    const tone = new Float32Array(n);
    for (let i = 0; i < n; i++) tone[i] = 0.5 * Math.sin((2 * Math.PI * (sr / 4 - 50) * i) / sr + Math.PI / 4);
    writeWavFile(path.join(dir, 'media/t.wav'), [tone, tone], sr, 32);
    let p = createProject('Peak', sr);
    p = addTrack(p, { name: 'T', inputChannels: [0, 1] });
    p.tracks[0].clips.push({ id: 't', file: 'media/t.wav', start: 0, offset: 0, length: n, gain: 0, fadeIn: 0, fadeOut: 0 });
    const base = path.join(dir, 'out');
    exportProject(p, dir, {
      outputBase: base,
      formats: ['wav'],
      mp3Bitrate: 128,
      normalize: true,
      targetLufs: 20, // unreachable: the ceiling decides the gain
      peakCeiling: -1,
      stems: false,
      chapterFiles: false,
    });
    const wav = readWavFile(`${base}.wav`);
    const meter = new LoudnessMeter(sr, 2);
    meter.push(wav.channels, wav.channels[0].length);
    expect(meter.truePeakDb()).toBeLessThanOrEqual(-1 + 0.05);
    expect(meter.truePeakDb()).toBeGreaterThan(-1.3);
  });
});
