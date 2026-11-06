import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LiveTap, exportProject, measureLoudness } from '../src/core/exporter';
import { readId3Chapters } from '../src/core/id3';
import { LoudnessMeter } from '../src/core/loudness';
import { addMarker, addTrack, createProject } from '../src/core/project';
import { readWavFile, writeWavFile } from '../src/core/wav';
import type { ExportProgress } from '../src/shared/types';
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
    const renders: ExportProgress[] = [];
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
      (pr) => {
        phases.add(pr.phase);
        if (pr.phase === 'Rendering mix') renders.push(pr);
      },
    );
    expect(phases.has('Rendering mix')).toBe(true);
    // the live figures of the render pass end at the loudness of the written file
    const last = renders[renders.length - 1];
    expect(last.fraction).toBe(1);
    expect(last.live!.integrated).toBeCloseTo(-16, 0);
    // the waveform stretches together cover every column
    const wave = new Float32Array(last.wave!.columns * 2);
    for (const r of renders) wave.set(r.wave!.peaks, r.wave!.start * 2);
    expect(Math.min(...wave.filter((_, i) => i % 2 === 0))).toBeLessThan(0);
    expect(wave.filter((_, i) => i % 2 === 1).every((v) => v > 0)).toBe(true);
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

  it('follows the rendered audio with a waveform and running loudness', () => {
    const sr = 48000;
    const loud = sine(1000, 2, sr, 0.5);
    const quiet = sine(1000, 2, sr, 0.05);
    const tap = new LiveTap(4 * sr, new LoudnessMeter(sr, 2), 100);
    tap.push([loud, loud], loud.length);
    const first = tap.take();
    expect(first.wave.start).toBe(0);
    expect(first.wave.peaks.length).toBe(100);
    expect(first.wave.peaks[1]).toBeCloseTo(0.5, 2);
    expect(first.live.momentary).toBeGreaterThan(-10);
    expect(first.live.shortTerm).toBe(-Infinity); // not 3 s yet
    tap.push([quiet, quiet], quiet.length);
    const second = tap.take();
    expect(second.wave.start).toBe(50); // continues where the first stretch ended
    expect(second.wave.peaks.slice(-1)[0]).toBeCloseTo(0.05, 2);
    expect(second.live.momentary).toBeLessThan(first.live.momentary - 15);
    expect(second.live.truePeak).toBeCloseTo(first.live.truePeak, 3);
  });
  it('reaches the target with a limiter when the peaks would hit the ceiling first', () => {
    // quiet speech-like tone with short loud bursts: gain alone could only add ~1 dB
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'media'));
    const sr = 44100;
    const voice = sine(220, 6, sr, 0.03);
    for (let s = 0; s < 6; s++) for (let i = 0; i < 60; i++) voice[s * sr + i] = 0.9 * Math.sin((2 * Math.PI * 1000 * i) / sr);
    writeWavFile(path.join(dir, 'media/v.wav'), [voice], sr);
    let p = createProject('Peaky', sr);
    p = addTrack(p, { name: 'Host' });
    p.tracks[0].clips.push({ id: 'v', file: 'media/v.wav', start: 0, offset: 0, length: 6 * sr, gain: 0, fadeIn: 0, fadeOut: 0 });
    const before = measureLoudness(p, dir);
    expect(before.truePeak + (-16 - before.integrated)).toBeGreaterThan(5);

    const res = exportProject(p, dir, {
      outputBase: path.join(dir, 'export', 'peaky'),
      formats: ['wav'],
      mp3Bitrate: 128,
      normalize: true,
      targetLufs: -16,
      peakCeiling: -1,
      stems: false,
      chapterFiles: false,
    });
    expect(res.limiterReductionDb).toBeLessThan(-3);
    const { info, channels } = readWavFile(path.join(dir, 'export/peaky.wav'));
    // the limiter's delay is taken out again: same length, same timing
    expect(info.frames).toBe(6 * sr);
    const m = new LoudnessMeter(sr, 2);
    m.push(channels);
    expect(m.integrated()).toBeCloseTo(-16, 0);
    expect(Math.abs(m.integrated() - -16)).toBeLessThan(0.2);
    expect(m.truePeakDb()).toBeLessThanOrEqual(-1 + 0.05);
    expect(res.outputLoudness).toBeCloseTo(m.integrated(), 1);
    // the tone between the bursts is only turned up, not limited
    const g = channels[0][3 * sr + 30000] / voice[3 * sr + 30000];
    expect(20 * Math.log10(g)).toBeCloseTo(res.appliedGainDb, 1);
  });
});
