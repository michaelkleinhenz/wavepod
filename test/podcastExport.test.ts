import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportProject, measureLoudness } from '../src/core/exporter';
import { DEFAULT_EXPORT_SETTINGS, clampTarget, isPresetTarget, normalizeExportSettings, targetForMono } from '../src/core/exportSettings';
import { exportChecks, imageSize } from '../src/core/exportChecks';
import { findSilences } from '../src/core/loudness';
import { addTrack, createProject, normalizeProject } from '../src/core/project';
import { normalizeTemplate, projectFromTemplate, projectToTemplate } from '../src/core/template';
import { readWavFile, writeWavFile } from '../src/core/wav';
import type { EpisodeMetadata, ExportSettings, LoudnessStats } from '../src/shared/types';
import { sine, tmpDir } from './helpers';

const meta = (patch: Partial<EpisodeMetadata> = {}): EpisodeMetadata => ({
  title: 'Ep 1', podcast: 'Pod', author: 'Me', episode: '1', description: 'About it', year: '2026', artwork: 'cover.jpg', ...patch,
});
const stats = (patch: Partial<LoudnessStats>): LoudnessStats => ({
  integrated: -16, range: 5, shortTermMax: -12, momentaryMax: -10, truePeak: -2, samplePeak: -2, duration: 600, history: [], historyStep: 1, ...patch,
});

/** A minimal PNG header with the given size. */
function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}

/** A minimal JPEG: SOI, an APP0 segment, then SOF0 with the size. */
function jpeg(w: number, h: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 0, 0, 0]);
}

describe('export settings', () => {
  it('defaults to one MP3 with chapters at −16 LUFS, without WAV', () => {
    expect(DEFAULT_EXPORT_SETTINGS.formats).toEqual(['mp3']);
    expect(DEFAULT_EXPORT_SETTINGS.targetLufs).toBe(-16);
    expect(DEFAULT_EXPORT_SETTINGS.chapterFiles).toBe(true);
  });

  it('checks settings read from a file', () => {
    expect(normalizeExportSettings(null)).toBeUndefined();
    const s = normalizeExportSettings({ formats: ['opus', 'aiff', 'mp3'], mp3Bitrate: 100, targetLufs: -40, peakCeiling: 3, mono: true })!;
    expect(s.formats).toEqual(['mp3', 'opus']);
    expect(s.mp3Bitrate).toBe(128);
    expect(s.targetLufs).toBe(-30);
    expect(s.peakCeiling).toBe(-1);
    expect(s.mono).toBe(true);
    expect(normalizeExportSettings({ targetLufs: -14 })!.targetLufs).toBe(-14);
  });

  it('offers −14 LUFS and keeps custom targets in range', () => {
    expect(isPresetTarget(-14)).toBe(true);
    expect(isPresetTarget(-18)).toBe(false);
    expect(clampTarget(-17.3)).toBe(-17.5);
    expect(clampTarget(-3)).toBe(-9);
    expect(clampTarget(Number.NaN)).toBeNull();
  });

  it('moves −16 to −19 for mono and back, and leaves other targets alone', () => {
    expect(targetForMono(-16, true)).toBe(-19);
    expect(targetForMono(-19, false)).toBe(-16);
    expect(targetForMono(-14, true)).toBe(-14);
    expect(targetForMono(-23, false)).toBe(-23);
  });

  it('are kept with the episode and carried by its template into new episodes', () => {
    const settings: ExportSettings = { ...DEFAULT_EXPORT_SETTINGS, mono: true, mp3Bitrate: 64, targetLufs: -19 };
    const p = normalizeProject({ ...createProject('Ep', 48000), exportSettings: settings });
    expect(p.exportSettings).toEqual(settings);
    const t = normalizeTemplate(JSON.parse(JSON.stringify(projectToTemplate(p, 'Show'))));
    expect(t.exportSettings).toEqual(settings);
    expect(projectFromTemplate(t, 'Ep 2', 48000).exportSettings).toEqual(settings);
    // never exported: nothing stored
    expect(projectToTemplate(createProject('x', 48000), 'Show').exportSettings).toBeUndefined();
  });
});

describe('export checks', () => {
  const s = DEFAULT_EXPORT_SETTINGS;

  it('finds nothing to say about a complete episode', () => {
    expect(exportChecks(meta(), s, { width: 3000, height: 3000 }, stats({}))).toEqual([]);
  });

  it('names missing episode details, but not for WAV only', () => {
    const c = exportChecks(meta({ episode: '', description: ' ' }), s, { width: 1400, height: 1400 });
    expect(c.map((x) => x.id)).toEqual(['details']);
    expect(c[0].message).toContain('episode number or description');
    expect(exportChecks(meta({ episode: '', artwork: undefined }), { ...s, formats: ['wav'] })).toEqual([]);
  });

  it('checks the cover: missing, unreadable, not square, too small, too large', () => {
    const ids = (m: EpisodeMetadata, size?: { width: number; height: number } | null) => exportChecks(m, s, size).map((c) => c.id);
    expect(ids(meta({ artwork: undefined }))).toEqual(['no-cover']);
    expect(ids(meta(), null)).toEqual(['cover-unreadable']);
    expect(ids(meta(), { width: 1600, height: 1400 })).toEqual(['cover-square']);
    expect(ids(meta(), { width: 1000, height: 1000 })).toEqual(['cover-small']);
    expect(ids(meta(), { width: 4000, height: 4000 })).toEqual(['cover-large']);
    // size not known yet: no verdict
    expect(ids(meta(), undefined)).toEqual([]);
  });

  it('checks the analysed mix: off target or over the ceiling without normalising, very quiet, dead air', () => {
    const off = { ...s, normalize: false };
    expect(exportChecks(meta(), off, undefined, stats({ integrated: -21.3 })).map((c) => c.id)).toEqual(['off-target']);
    expect(exportChecks(meta(), off, undefined, stats({ truePeak: 0.4 })).map((c) => c.id)).toEqual(['peaks']);
    expect(exportChecks(meta(), s, undefined, stats({ integrated: -21.3 }))).toEqual([]);
    expect(exportChecks(meta(), s, undefined, stats({ integrated: -32 })).map((c) => c.id)).toEqual(['quiet']);
    const dead = exportChecks(meta(), s, undefined, stats({ silences: [[60, 68], [300, 306]] }));
    expect(dead[0].id).toBe('silence');
    expect(dead[0].at).toEqual([60, 300]);
  });

  it('reads the size of PNG and JPEG files', () => {
    expect(imageSize(png(1400, 1400))).toEqual({ width: 1400, height: 1400 });
    expect(imageSize(jpeg(3000, 2000))).toEqual({ width: 3000, height: 2000 });
    expect(imageSize(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
});

describe('dead air', () => {
  it('finds silences of 5 s and more in the momentary loudness blocks', () => {
    const loud = 10 ** ((-20 + 0.691) / 10);
    // 100 ms blocks: 10 s loud, 6 s silent, 2 s loud, 2 s silent (too short), 3 s loud
    const blocks = [...Array(100).fill(loud), ...Array(60).fill(0), ...Array(20).fill(loud), ...Array(20).fill(0), ...Array(30).fill(loud)];
    const s = findSilences(blocks);
    expect(s).toHaveLength(1);
    expect(s[0][0]).toBeCloseTo(10, 1);
    expect(s[0][1] - s[0][0]).toBeGreaterThanOrEqual(5.9);
  });

  it('is reported by the loudness analysis of a mix', () => {
    const dir = tmpDir();
    const sr = 8000;
    fs.mkdirSync(path.join(dir, 'media'));
    writeWavFile(path.join(dir, 'media/a.wav'), [sine(300, 3, sr, 0.2)], sr);
    let p = createProject('Gap', sr);
    p = addTrack(p, { name: 'Host' });
    const clip = (id: string, start: number) => ({ id, file: 'media/a.wav', start, offset: 0, length: 3 * sr, gain: 0, fadeIn: 0, fadeOut: 0 });
    p.tracks[0].clips.push(clip('a', 0), clip('b', 10 * sr));
    const s = measureLoudness(p, dir);
    expect(s.silences).toHaveLength(1);
    expect(s.silences![0][0]).toBeGreaterThan(2.5);
    expect(s.silences![0][1]).toBeLessThan(10.5);
  });
});

describe('mono export', () => {
  it('writes one channel in every format and measures it as mono', () => {
    const dir = tmpDir();
    const sr = 48000;
    fs.mkdirSync(path.join(dir, 'media'));
    writeWavFile(path.join(dir, 'media/a.wav'), [sine(300, 4, sr, 0.05)], sr);
    let p = createProject('Mono', sr);
    p = addTrack(p, { name: 'Host' });
    p.tracks[0].clips.push({ id: 'a', file: 'media/a.wav', start: 0, offset: 0, length: 4 * sr, gain: 0, fadeIn: 0, fadeOut: 0 });
    const base = path.join(dir, 'export', 'mono');
    const res = exportProject(p, dir, { ...DEFAULT_EXPORT_SETTINGS, formats: ['wav', 'mp3', 'flac', 'opus'], mono: true, targetLufs: -19, outputBase: base });
    expect(res.files.map((f) => path.extname(f)).sort()).toEqual(['.flac', '.mp3', '.opus', '.wav']);
    const wav = readWavFile(`${base}.wav`);
    expect(wav.channels).toHaveLength(1);
    expect(wav.info.channels).toBe(1);
    // the mono file reaches the target measured as mono
    expect(res.outputLoudness!).toBeCloseTo(-19, 0);
    // a centred voice folded to mono measures 3 LU lower than in stereo
    const stereo = measureLoudness(p, dir).integrated;
    expect(measureLoudness(p, dir, undefined, true).integrated - stereo).toBeCloseTo(-3, 0);
    // FLAC STREAMINFO: channels − 1 in bits 1–3 of byte 20 (after "fLaC" and the block header)
    const flac = fs.readFileSync(`${base}.flac`);
    expect(((flac[8 + 12] >> 1) & 7) + 1).toBe(1);
    // OpusHead channel count
    const opus = fs.readFileSync(`${base}.opus`);
    expect(opus[opus.indexOf('OpusHead') + 9]).toBe(1);
    // MP3: the first frame header's channel mode is 3 (single channel)
    const mp3 = fs.readFileSync(`${base}.mp3`);
    const tagSize = ((mp3[6] & 0x7f) << 21) | ((mp3[7] & 0x7f) << 14) | ((mp3[8] & 0x7f) << 7) | (mp3[9] & 0x7f);
    let i = 10 + tagSize;
    while (!(mp3[i] === 0xff && (mp3[i + 1] & 0xe0) === 0xe0)) i++;
    expect(mp3[i + 3] >> 6).toBe(3);
  });
});
