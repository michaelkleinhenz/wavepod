import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportProject } from '../src/core/exporter';
import { addTrack, createProject, normalizeProject } from '../src/core/project';
import { stemFilePath, trackStem } from '../src/core/stems';
import { readWavFile, writeWavFile } from '../src/core/wav';
import type { Clip, Track } from '../src/shared/types';
import { tmpDir } from './helpers';

const SR = 8000;
const clip = (id: string, file: string, start: number, length: number): Clip => ({ id, file, start, offset: 0, length, gain: 0, fadeIn: 0, fadeOut: 0 });
const tone = (freq: number, seconds: number, amp: number) => new Float32Array(Math.round(seconds * SR)).map((_, i) => amp * Math.sin((2 * Math.PI * freq * i) / SR));
const rmsDb = (x: Float32Array, a: number, b: number) => 10 * Math.log10(x.slice(a, b).reduce((s, v) => s + v * v, 0) / (b - a));
const track = (patch: Partial<Track>): Track => ({ id: 't', name: 'Track', color: '#fff', inputChannels: [0], armed: false, mute: false, solo: false, gain: 0, pan: 0, clips: [], ...patch });

describe('stem assignment', () => {
  it('keeps the user’s choice and guesses the rest from name and settings', () => {
    expect(trackStem(track({ name: 'Host' }))).toBe('dialogue');
    expect(trackStem(track({ name: 'Musik' }))).toBe('music');
    expect(trackStem(track({ name: 'Intro jingle' }))).toBe('music');
    expect(trackStem(track({ name: 'SFX' }))).toBe('effects');
    expect(trackStem(track({ name: 'Atmo Wald' }))).toBe('effects');
    expect(trackStem(track({ name: 'Geräusche' }))).toBe('effects');
    expect(trackStem(track({ name: 'Bed 2', duck: { enabled: true, depth: 12 } }))).toBe('music');
    expect(trackStem(track({ name: 'Soundboard', kind: 'soundboard' }))).toBe('music');
    expect(trackStem(track({ name: 'Musik', stem: 'none' }))).toBe('none');
    expect(trackStem(track({ name: 'Host', stem: 'effects' }))).toBe('effects');
  });

  it('keeps the choice when the episode is loaded again', () => {
    let p = createProject('S', SR);
    p = addTrack(p, { name: 'Host', stem: 'none' });
    p = addTrack(p, { name: 'Bed', stem: 'bogus' as never });
    const q = normalizeProject(JSON.parse(JSON.stringify(p)));
    expect(q.tracks[0].stem).toBe('none');
    expect(q.tracks[1].stem).toBeUndefined();
  });

  it('names the files after the stem', () => {
    expect(stemFilePath('/x/ep', 'dialogue', 'wav')).toBe('/x/ep-dialogue.wav');
    expect(stemFilePath('/x/ep', 'me', 'flac')).toBe('/x/ep-music-and-effects.flac');
  });
});

describe('dialogue, music and effects export', () => {
  it('writes three stems (and M&E) that add up to the mix, with the music ducked as in the mix', () => {
    const dir = tmpDir();
    writeWavFile(path.join(dir, 'voice.wav'), [tone(500, 2, 0.3)], SR, 32);
    writeWavFile(path.join(dir, 'guest.wav'), [tone(700, 1, 0.2)], SR, 32);
    writeWavFile(path.join(dir, 'music.wav'), [tone(200, 6, 0.2)], SR, 32);
    writeWavFile(path.join(dir, 'door.wav'), [tone(1500, 0.5, 0.25)], SR, 32);
    let p = createProject('DME', SR);
    p = addTrack(p, { name: 'Host' });
    p = addTrack(p, { name: 'Guest' });
    p = addTrack(p, { name: 'Bed', duck: { enabled: true, depth: 12 } });
    p = addTrack(p, { name: 'Door', stem: 'effects' });
    p = addTrack(p, { name: 'Scratch', stem: 'none' });
    p = addTrack(p, { name: 'Muted', mute: true });
    p.tracks[0].clips.push(clip('v', 'voice.wav', 2 * SR, 2 * SR)); // speech from 2 s to 4 s
    p.tracks[1].clips.push(clip('g', 'guest.wav', 4.5 * SR, SR));
    p.tracks[2].clips.push(clip('m', 'music.wav', 0, 6 * SR));
    p.tracks[3].clips.push(clip('d', 'door.wav', 4.6 * SR, 0.5 * SR));
    p.tracks[4].clips.push(clip('s', 'guest.wav', 4.5 * SR, SR));
    p.tracks[5].clips.push(clip('x', 'voice.wav', 0, 2 * SR));
    p.masterGain = -3;

    const base = path.join(dir, 'out', 'ep');
    const phases = new Set<string>();
    const res = exportProject(
      p,
      dir,
      { outputBase: base, formats: ['wav'], mp3Bitrate: 128, normalize: false, targetLufs: -16, peakCeiling: -1, stems: true, stemMode: 'dme', stemMe: true, chapterFiles: false },
      (pr) => phases.add(pr.phase),
    );
    expect(phases.has('Stems (dialogue, music, effects)')).toBe(true);
    const names = ['dialogue', 'music', 'effects', 'music-and-effects'].map((g) => `${base}-${g}.wav`);
    expect(res.files).toEqual(expect.arrayContaining(names));
    expect(res.files.filter((f) => f.startsWith(`${base}-`))).toHaveLength(4);
    const [dia, mus, efx, me] = names.map((f) => readWavFile(f).channels[0]);
    const mix = readWavFile(`${base}.wav`).channels[0];

    // stems add up to the mix (24-bit rounding aside) where the left-out track is silent
    let worst = 0;
    for (let i = 0; i < mix.length; i++) if (i < 4.5 * SR || i >= 5.5 * SR) worst = Math.max(worst, Math.abs(dia[i] + mus[i] + efx[i] - mix[i]));
    expect(worst).toBeLessThan(1e-4);
    // the left-out track plays in the mix but is in no stem
    const rest = mix.slice(4.5 * SR, 5.5 * SR).map((v, j) => { const i = j + 4.5 * SR; return v - dia[i] - mus[i] - efx[i]; });
    expect(rmsDb(rest, 0, SR)).toBeGreaterThan(-30);

    // dialogue has the voices only, effects the door only, muted tracks nowhere
    expect(rmsDb(dia, 0.2 * SR, 1.8 * SR)).toBeLessThan(-100);
    expect(rmsDb(dia, 2.2 * SR, 3.8 * SR)).toBeGreaterThan(-20);
    expect(rmsDb(efx, 4.7 * SR, 5 * SR)).toBeGreaterThan(-20);
    expect(rmsDb(efx, 0, 4.5 * SR)).toBeLessThan(-100);
    // the bed ducks under the speech in its stem too
    const duck = rmsDb(mus, 0.2 * SR, 0.8 * SR) - rmsDb(mus, 2.6 * SR, 3.8 * SR);
    expect(duck).toBeGreaterThan(10);
    // M&E is music plus effects
    let meErr = 0;
    for (let i = 0; i < me.length; i++) meErr = Math.max(meErr, Math.abs(me[i] - mus[i] - efx[i]));
    expect(meErr).toBeLessThan(1e-4);
  });

  it('writes a silent file for a stem without tracks, and works without a mix file', () => {
    const dir = tmpDir();
    writeWavFile(path.join(dir, 'voice.wav'), [tone(500, 1, 0.3)], SR, 32);
    let p = createProject('DME', SR);
    p = addTrack(p, { name: 'Host' });
    p.tracks[0].clips.push(clip('v', 'voice.wav', 0, SR));
    const base = path.join(dir, 'ep');
    const res = exportProject(p, dir, { outputBase: base, formats: [], mp3Bitrate: 128, normalize: false, targetLufs: -16, peakCeiling: -1, stems: true, stemMode: 'dme', chapterFiles: false });
    expect(res.files.sort()).toEqual([`${base}-dialogue.wav`, `${base}-effects.wav`, `${base}-music.wav`]);
    const music = readWavFile(`${base}-music.wav`).channels[0];
    expect(music.length).toBe(SR);
    expect(music.every((v) => v === 0)).toBe(true);
    expect(fs.existsSync(`${base}.wav`)).toBe(false);
  });
});
