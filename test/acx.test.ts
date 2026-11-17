import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACX_HEAD_TARGET,
  ACX_TAIL_TARGET,
  AcxMeter,
  acxRangeNote,
  acxResults,
  predictAcx,
  roomToneFill,
  roomTonePlan,
} from '../src/core/acx';
import { exportProject, measureAcx } from '../src/core/exporter';
import { exportJobs, plannedFiles, rangeAvailable } from '../src/core/exportPlan';
import { normalizeExportSettings, withAcx, DEFAULT_EXPORT_SETTINGS } from '../src/core/exportSettings';
import { readId3Chapters } from '../src/core/id3';
import { addMarker, addTrack, createProject } from '../src/core/project';
import { writeWavFile } from '../src/core/wav';
import type { AcxStats, Project } from '../src/shared/types';
import { tmpDir } from './helpers';

/** Deterministic white noise at `rms` (linear). */
function noise(n: number, rms: number, seed = 1): Float32Array {
  const out = new Float32Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = ((x / 0x7fffffff) * 2 - 1) * rms * Math.sqrt(3);
  }
  return out;
}

/**
 * A narration: room noise at `noiseDb`, with "speech" (a 200 Hz tone with a syllable rhythm) from
 * `head` seconds until `tail` seconds before the end.
 */
function narration(sr: number, seconds: number, head: number, tail: number, amp: number, noiseDb = -70): Float32Array {
  const n = Math.round(seconds * sr);
  const out = noise(n, 10 ** (noiseDb / 20));
  const from = Math.round(head * sr);
  const to = n - Math.round(tail * sr);
  for (let i = from; i < to; i++) {
    const t = (i - from) / sr;
    const env = 0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t);
    out[i] += amp * env * Math.sin(2 * Math.PI * 200 * t);
  }
  return out;
}

function measure(ch: Float32Array, sr: number, capture = false): AcxMeter {
  const m = new AcxMeter(sr, 1, capture);
  for (let pos = 0; pos < ch.length; pos += 1000) m.push([ch.subarray(pos, pos + 1000)], Math.min(1000, ch.length - pos));
  return m;
}

const stats = (patch: Partial<AcxStats>): AcxStats => ({
  duration: 60,
  rmsDb: -20,
  peakDb: -6,
  noiseFloorDb: -65,
  head: 0.7,
  tail: 2,
  leadSilence: 0,
  trailSilence: 0,
  silentGaps: false,
  ...patch,
});

/** MPEG frame headers of an MP3 after its ID3 tag: sample rate and bitrate of each frame. */
function mp3Frames(bytes: Buffer): Array<{ rate: number; kbps: number }> {
  const KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const RATES = [44100, 48000, 32000];
  let at = 0;
  if (bytes.toString('latin1', 0, 3) === 'ID3') at = 10 + ((bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9]);
  const out: Array<{ rate: number; kbps: number }> = [];
  while (at + 4 <= bytes.length && bytes[at] === 0xff) {
    const kbps = KBPS[bytes[at + 2] >> 4];
    const rate = RATES[(bytes[at + 2] >> 2) & 3];
    const pad = (bytes[at + 2] >> 1) & 1;
    out.push({ rate, kbps });
    at += Math.floor((144000 * kbps) / rate) + pad;
  }
  return out;
}

describe('ACX meter', () => {
  it('measures RMS, peak, noise floor and the room tone at both ends', () => {
    const sr = 8000;
    const audio = narration(sr, 10, 0.3, 3, 0.2, -70);
    const s = measure(audio, sr).stats();
    expect(s.duration).toBeCloseTo(10, 5);
    // the tone at 0.2 × (0.6…1) for 6.7 s of 10 s
    expect(s.rmsDb).toBeGreaterThan(-23);
    expect(s.rmsDb).toBeLessThan(-15);
    expect(s.peakDb).toBeCloseTo(20 * Math.log10(0.2), 0);
    expect(s.noiseFloorDb).toBeCloseTo(-70, 0);
    expect(s.head).toBeCloseTo(0.3, 1);
    expect(s.tail).toBeCloseTo(3, 1);
    expect(s.leadSilence).toBe(0);
    expect(s.silentGaps).toBe(false);
  });

  it('leaves digital silence out of the noise floor and reports it', () => {
    const sr = 8000;
    const audio = narration(sr, 6, 0.6, 1.5, 0.2, -66);
    // dead silence at the start and a gap between two "clips"
    audio.fill(0, 0, sr * 0.2);
    audio.fill(0, sr * 3, sr * 3.5);
    const s = measure(audio, sr).stats();
    expect(s.noiseFloorDb).toBeCloseTo(-66, 0);
    expect(s.leadSilence).toBeCloseTo(0.2, 2);
    expect(s.silentGaps).toBe(true);
    expect(acxResults(s).find((r) => r.id === 'silence')!.value).toBe('between clips');
  });

  it('keeps the quietest half second as room tone', () => {
    const sr = 8000;
    const audio = narration(sr, 5, 2, 0.8, 0.2, -60);
    // a quieter stretch of room inside the long head
    audio.set(noise(sr, 10 ** (-75 / 20), 7), sr / 2);
    const tone = measure(audio, sr, true).roomTone()!;
    expect(tone.samples[0].length).toBe(sr / 2);
    expect(tone.at).toBeGreaterThanOrEqual(0.5);
    expect(tone.at).toBeLessThanOrEqual(1);
    const rms = Math.sqrt(tone.samples[0].reduce((a, v) => a + v * v, 0) / tone.samples[0].length);
    expect(20 * Math.log10(rms)).toBeCloseTo(-75, 0);
  });
});

describe('room tone', () => {
  it('plans cuts and room tone for each end', () => {
    // fine as it is
    expect(roomTonePlan(stats({}))).toEqual({ trimHead: 0, padHead: 0, trimTail: 0, padTail: 0 });
    // too short: lengthened to 0.75 s and 2 s
    let p = roomTonePlan(stats({ head: 0.1, tail: 0.3 }));
    expect(p.padHead).toBeCloseTo(ACX_HEAD_TARGET - 0.1);
    expect(p.padTail).toBeCloseTo(ACX_TAIL_TARGET - 0.3);
    // too long: cut to 0.75 s and 2 s
    p = roomTonePlan(stats({ head: 4, tail: 9 }));
    expect(p.trimHead).toBeCloseTo(4 - ACX_HEAD_TARGET);
    expect(p.trimTail).toBeCloseTo(9 - ACX_TAIL_TARGET);
    // digital silence at the ends is cut, and room tone put in its place
    p = roomTonePlan(stats({ head: 0.8, leadSilence: 0.6, tail: 1.5, trailSilence: 1.2 }));
    expect(p.trimHead).toBeCloseTo(0.6);
    expect(p.padHead).toBeCloseTo(ACX_HEAD_TARGET - 0.2);
    expect(p.trimTail).toBeCloseTo(1.2);
    expect(p.padTail).toBeCloseTo(ACX_TAIL_TARGET - 0.3);
    // nothing but room tone: left alone
    expect(roomTonePlan(stats({ head: 60, tail: 60 }))).toEqual({ trimHead: 0, padHead: 0, trimTail: 0, padTail: 0 });
  });

  it('loops room tone without a jump at the seams', () => {
    const sr = 8000;
    const t = noise(sr / 2, 0.01);
    const [out] = roomToneFill([t], sr * 2, sr);
    expect(out.length).toBe(sr * 2);
    expect(Array.from(out.subarray(0, 100))).toEqual(Array.from(t.subarray(0, 100)));
    // the level stays the same throughout (equal-power crossfades)
    const rms = (a: Float32Array) => Math.sqrt(a.reduce((x, v) => x + v * v, 0) / a.length);
    for (let s = 0; s < 4; s++) expect(rms(out.subarray((s * sr) / 2, ((s + 1) * sr) / 2)) / 0.01).toBeCloseTo(1, 0);
  });
});

describe('ACX checks', () => {
  it('passes a file that meets every rule and explains what does not', () => {
    expect(acxResults(stats({})).every((r) => r.ok)).toBe(true);
    const bad = acxResults(stats({ rmsDb: -26, peakDb: -1, noiseFloorDb: -52, head: 0.2, tail: 7, duration: 3 * 3600 }));
    expect(bad.filter((r) => !r.ok).map((r) => r.id)).toEqual(['rms', 'peak', 'noise', 'head', 'tail', 'length']);
    expect(bad.find((r) => r.id === 'noise')!.hint).toMatch(/Noise reduction/);
    expect(bad.find((r) => r.id === 'rms')!.value).toBe('−26.0 dB');
  });

  it('predicts what leveling and the room tone fix make of a file', () => {
    const raw = stats({ rmsDb: -27, peakDb: -4, noiseFloorDb: -72, head: 0.1, tail: 8 });
    const after = predictAcx(raw, { leveling: true, roomTone: true });
    expect(after.rmsDb).toBe(-20);
    // +7 dB would put the peaks at +3: the limiter holds them under −3
    expect(after.peakDb).toBe(-3.5);
    expect(after.noiseFloorDb).toBe(-65);
    expect(after.head).toBeCloseTo(ACX_HEAD_TARGET);
    expect(after.tail).toBeCloseTo(ACX_TAIL_TARGET);
    expect(acxResults(after).every((r) => r.ok)).toBe(true);
    // leveling a noisy recording lifts the noise over −60
    const noisy = predictAcx({ ...raw, noiseFloorDb: -64 }, { leveling: true, roomTone: true });
    expect(acxResults(noisy).find((r) => r.id === 'noise')!.ok).toBe(false);
    // without the fixes nothing changes
    expect(predictAcx(raw, { leveling: false, roomTone: false })).toEqual(raw);
  });

  it('asks for one file per chapter', () => {
    expect(acxRangeNote('chapters', 5, 0)).toBeNull();
    expect(acxRangeNote('regions', 0, 5)).toBeNull();
    expect(acxRangeNote('all', 5, 0)).toMatch(/whole book/);
    expect(acxRangeNote('all', 1, 0)).toMatch(/chapter marker/);
    expect(acxRangeNote('region', 5, 5)).toBeNull();
  });
});

describe('ACX export settings', () => {
  it('turns ACX on and off and keeps it with the episode', () => {
    const on = withAcx({ ...DEFAULT_EXPORT_SETTINGS, formats: ['mp3', 'wav'], normalize: false }, true);
    expect(on.formats).toEqual(['mp3']);
    expect(on.mp3Bitrate).toBe(192);
    expect(on.normalize).toBe(true);
    expect(on.acx).toEqual({ roomTone: true });
    expect(normalizeExportSettings(JSON.parse(JSON.stringify({ ...on, acx: { roomTone: false } })))!.acx).toEqual({ roomTone: false });
    const off = withAcx(on, false);
    expect(off.acx).toBeUndefined();
    expect(normalizeExportSettings(off)!.acx).toBeUndefined();
  });
});

describe('ACX export', () => {
  function book(dir: string, sr: number): Project {
    fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
    // two chapters of 6 s, quiet (about −30 dB RMS), with with too little room tone at the start
    // and too much at the end; the second starts with dead digital silence
    const one = narration(sr, 6, 0.15, 4, 0.1, -85);
    const two = narration(sr, 6, 0.3, 0.2, 0.1, -85);
    two.fill(0, 0, Math.round(0.1 * sr));
    // a pause between two paragraphs
    two.set(noise(Math.round(0.8 * sr), 10 ** (-85 / 20), 3), Math.round(2.5 * sr));
    writeWavFile(path.join(dir, 'media/one.wav'), [one], sr);
    writeWavFile(path.join(dir, 'media/two.wav'), [two], sr);
    let p = addTrack(createProject('Book', sr), { name: 'Narrator' });
    p.metadata = { ...p.metadata, title: 'My Book' };
    p.tracks[0].clips.push({ id: 'a', file: 'media/one.wav', start: 0, offset: 0, length: 6 * sr, gain: 0, fadeIn: 0, fadeOut: 0 });
    p.tracks[0].clips.push({ id: 'b', file: 'media/two.wav', start: 6 * sr, offset: 0, length: 6 * sr, gain: 0, fadeIn: 0, fadeOut: 0 });
    p = addMarker(p, 0, 'chapter', 'Chapter One').project;
    p = addMarker(p, 6 * sr, 'chapter', 'Chapter Two').project;
    return p;
  }

  it('cuts the book into chapters', () => {
    const p = book(tmpDir(), 8000);
    expect(rangeAvailable({ kind: 'chapters' }, p, null)).toBe(true);
    const jobs = exportJobs({ kind: 'chapters' }, p, null, '/out/My Book');
    expect(jobs.map((j) => [path.basename(j.outputBase), j.start, j.end])).toEqual([
      ['My Book - 01 Chapter One', 0, 48000],
      ['My Book - 02 Chapter Two', 48000, 96000],
    ]);
    const s = withAcx(DEFAULT_EXPORT_SETTINGS, true);
    expect(plannedFiles(p, { ...s, chapterFiles: false }, jobs[1]).map((f) => path.basename(f))).toEqual(['My Book - 02 Chapter Two.mp3']);
  });

  it('writes each chapter as a 192 kbps 44.1 kHz MP3 that passes the ACX check', () => {
    const dir = tmpDir();
    const sr = 48000;
    const p = book(dir, sr);
    // before: too quiet, room tone off at both ends, dead silence at the start of chapter two
    const before = measureAcx(p, dir, [[0, 6 * sr], [6 * sr, 12 * sr]]);
    expect(before[0].rmsDb).toBeLessThan(-26);
    expect(before[1].head).toBeCloseTo(0.3, 1);
    expect(before[0].head).toBeLessThan(0.5);
    expect(before[0].tail).toBeGreaterThan(3.5);
    expect(before[1].leadSilence).toBeCloseTo(0.1, 2);
    expect(acxResults(before[0]).some((r) => !r.ok)).toBe(true);

    const settings = { ...withAcx(DEFAULT_EXPORT_SETTINGS, true), mono: true };
    for (const job of exportJobs({ kind: 'chapters' }, p, null, path.join(dir, 'export', 'My Book'))) {
      const res = exportProject(p, dir, { ...settings, outputBase: job.outputBase, start: job.start, end: job.end });
      const s = res.acx!;
      expect(s.rmsDb).toBeGreaterThanOrEqual(-20.5);
      expect(s.rmsDb).toBeLessThanOrEqual(-19.5);
      expect(s.peakDb).toBeLessThanOrEqual(-3);
      expect(s.noiseFloorDb).toBeLessThan(-60);
      expect(s.head).toBeGreaterThanOrEqual(0.5);
      expect(s.head).toBeLessThanOrEqual(1);
      expect(s.tail).toBeGreaterThanOrEqual(1);
      expect(s.tail).toBeLessThanOrEqual(5);
      expect(s.leadSilence).toBe(0);
      expect(acxResults(s).every((r) => r.ok)).toBe(true);
      const mp3 = fs.readFileSync(`${job.outputBase}.mp3`);
      const frames = mp3Frames(mp3);
      expect(frames.length).toBeGreaterThan(100);
      expect(new Set(frames.map((f) => f.rate))).toEqual(new Set([44100]));
      expect(new Set(frames.map((f) => f.kbps))).toEqual(new Set([192]));
      // the chapter's own marker stays at the very start of its file
      expect(readId3Chapters(mp3)[0].start).toBe(0);
    }
  });

  it('adds no room tone made of speech', () => {
    const sr = 8000;
    const s = measure(narration(sr, 6, 0.2, 0.2, 0.1, -85), sr).stats();
    expect(predictAcx(s, { leveling: true, roomTone: true }).head).toBeCloseTo(s.head);
  });

  it('leaves room tone alone when the fix is off', () => {
    const dir = tmpDir();
    const sr = 8000;
    const p = book(dir, sr);
    const res = exportProject(p, dir, { ...withAcx(DEFAULT_EXPORT_SETTINGS, true), acx: { roomTone: false }, outputBase: path.join(dir, 'x'), start: 0, end: 6 * sr });
    expect(res.acx!.duration).toBeCloseTo(6, 2);
    expect(res.acx!.head).toBeLessThan(0.5);
    expect(res.acx!.rmsDb).toBeCloseTo(-20, 0);
  });
});
