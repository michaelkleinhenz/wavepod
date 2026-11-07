import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { alignClips, alignedPosition, applyAlignment, bestLag, stretchTranscript, stretchWav, syncedFileName } from '../src/core/align';
import { addTrack, createProject } from '../src/core/project';
import { readWavFile, writeWavFile } from '../src/core/wav';
import type { Clip, FileTranscript } from '../src/shared/types';
import { tmpDir } from './helpers';

/** Random numbers that are the same on every run. */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 48271) % 2147483647;
    return s / 2147483647;
  };
}

/** Speech-like: noise syllables of random length with random pauses, only while `talking(t)`. */
function speech(n: number, sr: number, seed: number, talking: (sec: number) => boolean = () => true): Float32Array {
  const r = rng(seed);
  const x = new Float32Array(n);
  let i = 0;
  while (i < n) {
    const syl = Math.round((0.08 + r() * 0.25) * sr);
    const amp = 0.2 + r() * 0.5;
    for (let k = 0; k < syl && i + k < n; k++) if (talking((i + k) / sr)) x[i + k] = (r() - 0.5) * amp * Math.sin((Math.PI * k) / syl);
    i += syl + Math.round((0.03 + r() * (r() < 0.15 ? 0.8 : 0.15)) * sr);
  }
  return x;
}

const clip = (id: string, file: string, start: number, length: number): Clip => ({ id, file, start, offset: 0, length, gain: 0, fadeIn: 0, fadeOut: 0 });

describe('aligning by content', () => {
  it('finds a lag by cross-correlation', () => {
    const ref = speech(20000, 2000, 3);
    const probe = ref.slice(7000, 12000);
    const r = bestLag(ref, probe);
    expect(r.lag).toBe(7000);
    expect(r.fine).toBeCloseTo(7000, 1);
    expect(r.confidence).toBeGreaterThan(0.99);
  });

  it('moves a guest’s local recording onto the remote track', () => {
    const dir = tmpDir();
    const sr = 16000;
    const call = speech(120 * sr, sr, 11); // what the remote track recorded (the guest over the call)
    // the guest's own recording started 4.25 s before the call recording, and sounds a bit different
    const lead = Math.round(4.25 * sr);
    const noise = rng(5);
    const local = new Float32Array(call.length + lead);
    for (let i = 0; i < local.length; i++) local[i] = (i >= lead ? call[i - lead] * 1.7 : 0) + (noise() - 0.5) * 0.02;
    writeWavFile(path.join(dir, 'remote.wav'), [call], sr, 32);
    writeWavFile(path.join(dir, 'local.wav'), [local], sr, 32);
    let p = createProject('A', sr);
    p = addTrack(p, { name: 'Remote' });
    p = addTrack(p, { name: 'Guest local' });
    p.tracks[0].clips.push(clip('r', 'remote.wav', 10 * sr, call.length));
    // imported somewhere, not lined up
    p.tracks[1].clips.push(clip('l', 'local.wav', 20 * sr, local.length));
    const r = alignClips(p, dir, ['l'], p.tracks[0].id);
    expect(r.drift).toBe(0);
    expect(r.confidence).toBeGreaterThan(0.5);
    const moved = applyAlignment(p, ['l'], r);
    // local sample `lead` = remote sample 0 at 10 s, so local starts at 10 s - 4.25 s
    expect(Math.abs(moved.tracks[1].clips[0].start - (10 * sr - lead))).toBeLessThanOrEqual(2);
  });

  it('lines up two field recorders started minutes apart, with clock drift and bleed', () => {
    const dir = tmpDir();
    const sr = 8000;
    const minutes = 12;
    const n = minutes * 60 * sr;
    // host and guest take turns; each mic hears the other person quietly, a millisecond later
    const turn = (sec: number) => Math.floor(sec / 7 + Math.sin(sec / 13)) % 2 === 0;
    const host = speech(n + sr * 120, sr, 21, (t) => turn(t));
    const guest = speech(n + sr * 120, sr, 33, (t) => !turn(t));
    const d = Math.round(0.001 * sr);
    const noise = rng(9);
    const hostMic = (i: number) => host[i] + 0.15 * (guest[i - d] ?? 0) + (noise() - 0.5) * 0.005;
    const guestMic = (i: number) => guest[i] + 0.15 * (host[i - d] ?? 0) + (noise() - 0.5) * 0.005;
    // host recorder: true time 0 s .. ; guest recorder started 47.3 s earlier, its clock 80 ppm slow
    const eps = 80e-6;
    const lead = 47.3;
    const hostFile = new Float32Array(n);
    for (let i = 0; i < n; i++) hostFile[i] = hostMic(i + 60 * sr);
    const guestTrue = new Float32Array(n + 120 * sr);
    for (let i = 0; i < guestTrue.length; i++) guestTrue[i] = guestMic(i);
    const guestFile = new Float32Array(n);
    // guest file sample k was recorded at true time (k / (1 - eps)) / sr + 60 - lead
    for (let k = 0; k < n; k++) {
      const x = k / (1 - eps) + (60 - lead) * sr;
      const j = Math.floor(x);
      const f = x - j;
      guestFile[k] = guestTrue[j] * (1 - f) + (guestTrue[j + 1] ?? 0) * f;
    }
    fs.mkdirSync(path.join(dir, 'media'));
    writeWavFile(path.join(dir, 'media/host.wav'), [hostFile], sr, 32);
    writeWavFile(path.join(dir, 'media/guest.wav'), [guestFile], sr, 32);
    let p = createProject('A', sr);
    p = addTrack(p, { name: 'Host' });
    p = addTrack(p, { name: 'Guest' });
    const hostStart = 60 * sr;
    p.tracks[0].clips.push(clip('h', 'media/host.wav', hostStart, n));
    // both imported at the same place, as they come off the cards
    p.tracks[1].clips.push(clip('g', 'media/guest.wav', hostStart, n));

    const r = alignClips(p, dir, ['g'], p.tracks[0].id);
    expect(r.drift).toBeGreaterThan(eps * 0.8);
    expect(r.drift).toBeLessThan(eps * 1.2);
    expect(r.windows).toBeGreaterThanOrEqual(5);

    const copy = syncedFileName('media/guest.wav', (f) => fs.existsSync(path.join(dir, f)));
    expect(copy).toBe('media/guest-synced.wav');
    stretchWav(path.join(dir, 'media/guest.wav'), path.join(dir, copy), 1 + r.drift);
    const moved = applyAlignment(p, ['g'], r, { 'media/guest.wav': copy });
    const g = moved.tracks[1].clips[0];
    expect(g.file).toBe(copy);
    // where guest file sample k plays now, against where the host recorded the same moment
    for (const k of [sr * 5, n / 2, n - sr * 5]) {
      const trueSec = k / (1 - eps) / sr + 60 - lead; // seconds of true time
      const hostFrame = hostStart + (trueSec - 60) * sr;
      const plays = g.start + k * (1 + r.drift) - g.offset;
      expect(Math.abs(plays - hostFrame) / sr).toBeLessThan(0.0015);
    }
  }, 60_000);

  it('stretches a file with a clean resampler', () => {
    const dir = tmpDir();
    const sr = 8000;
    const f = 440;
    const n = 60 * sr;
    const tone = new Float32Array(n);
    for (let i = 0; i < n; i++) tone[i] = 0.5 * Math.sin((2 * Math.PI * f * i) / sr);
    writeWavFile(path.join(dir, 'a.wav'), [tone], sr, 32);
    const s = 1.0005;
    stretchWav(path.join(dir, 'a.wav'), path.join(dir, 'b.wav'), s);
    const out = readWavFile(path.join(dir, 'b.wav'));
    expect(out.info.frames).toBe(Math.round(n * s));
    expect(fs.existsSync(path.join(dir, 'b.wav.part'))).toBe(false);
    let worst = 0;
    for (const q of [1000, n / 2, n - 1000]) {
      for (let i = 0; i < 200; i++) worst = Math.max(worst, Math.abs(out.channels[0][q + i] - 0.5 * Math.sin((2 * Math.PI * f * ((q + i) / s)) / sr)));
    }
    expect(worst).toBeLessThan(0.002); // better than -48 dB
  });

  it('does not invent drift for recorders that run in step', () => {
    const dir = tmpDir();
    const sr = 8000;
    const n = 8 * 60 * sr;
    const host = speech(n + sr * 30, sr, 4);
    writeWavFile(path.join(dir, 'a.wav'), [host.subarray(0, n)], sr, 32);
    writeWavFile(path.join(dir, 'b.wav'), [host.subarray(sr * 30, sr * 30 + n)], sr, 32);
    let p = createProject('A', sr);
    p = addTrack(p, { name: 'A' });
    p = addTrack(p, { name: 'B' });
    p.tracks[0].clips.push(clip('a', 'a.wav', 0, n));
    p.tracks[1].clips.push(clip('b', 'b.wav', 0, n));
    const r = alignClips(p, dir, ['b'], p.tracks[0].id);
    expect(r.drift).toBe(0);
    expect(Math.round(alignedPosition(r, 0))).toBe(30 * sr);
  }, 30_000);

  it('moves every clip of a track together and trims what would land before the start', () => {
    let p = createProject('A', 1000);
    p = addTrack(p, { name: 'A' });
    p = addTrack(p, { name: 'B' });
    p.tracks[1].clips.push(clip('x', 'b.wav', 1000, 3000), { ...clip('y', 'b.wav', 5000, 1000), offset: 4000 });
    const moved = applyAlignment(p, ['x', 'y'], { shift: -2000, anchor: 0, drift: 0 });
    expect(moved.tracks[1].clips[0]).toMatchObject({ start: 0, offset: 1000, length: 2000 });
    expect(moved.tracks[1].clips[1]).toMatchObject({ start: 3000, offset: 4000, length: 1000 });
  });

  it('stretches clips onto the drift-corrected copy', () => {
    let p = createProject('A', 1000);
    p = addTrack(p, { name: 'B' });
    p.tracks[0].clips.push({ ...clip('x', 'b.wav', 10000, 100000), offset: 20000, fadeIn: 1000, envelope: [{ pos: 50000, db: -3 }] });
    const r = { shift: 500, anchor: 10000, drift: 0.001 };
    const c = applyAlignment(p, ['x'], r, { 'b.wav': 'b-synced.wav' }).tracks[0].clips[0];
    expect(c).toMatchObject({ file: 'b-synced.wav', start: 10500, offset: 20020, length: 100100, fadeIn: 1001 });
    expect(c.envelope![0].pos).toBe(50050);
  });

  it('carries the transcript over to the stretched copy', () => {
    const t: FileTranscript = { version: 1, file: 'a.wav', sampleRate: 48000, language: 'de', model: 'm', created: '', words: [{ text: 'Hallo', start: 1000, end: 2000 }], levels: { step: 960, db: '' } };
    const s = stretchTranscript(t, 'a-synced.wav', 1.001);
    expect(s.file).toBe('a-synced.wav');
    expect(s.words[0]).toMatchObject({ start: 1001, end: 2002 });
    expect(s.levels!.step).toBeCloseTo(960.96, 5);
  });

  it('rejects aligning a clip to its own track', () => {
    let p = createProject('A', 1000);
    p = addTrack(p, { name: 'T' });
    p.tracks[0].clips.push(clip('c', 'x.wav', 0, 10));
    expect(() => alignClips(p, tmpDir(), ['c'], p.tracks[0].id)).toThrow(/different track/);
  });
});
