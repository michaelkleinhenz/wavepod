import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { addTrack, createProject, projectLength } from '../src/core/project';
import { applyCleanup, cleanupSaving, fillerItems, findPauses, levelsDb, othersSpeak, refineCut, silenceThreshold } from '../src/core/cleanup';
import { scanCleanup } from '../src/core/cleanupScan';
import { timelineWords } from '../src/core/transcript';
import { writeWavFile } from '../src/core/wav';
import type { CleanupItem, Clip, FileTranscript, Project } from '../src/shared/types';
import { tmpDir } from './helpers';

const SR = 8000;
const clip = (id: string, file: string, length: number): Clip => ({ id, file, start: 0, offset: 0, length, gain: 0, fadeIn: 0, fadeOut: 0 });
/** "Speech" (a tone) where `on` says, a faint noise floor elsewhere. */
function speech(seconds: number, on: (t: number) => boolean): Float32Array {
  let seed = 1;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.002;
  return new Float32Array(seconds * SR).map((_, i) => (on(i / SR) ? 0.3 * Math.sin((2 * Math.PI * 220 * i) / SR) : 0) + noise());
}

describe('cleanup', () => {
  it('finds long pauses and keeps a natural gap in the middle', () => {
    const x = speech(10, (t) => t < 2 || (t >= 5 && t < 6) || t >= 6.8);
    const hop = 80;
    const levels = levelsDb(x, hop);
    expect(silenceThreshold(levels)).toBeLessThan(-35);
    const pauses = findPauses(levels, hop, SR, 1.5, 0.6);
    // 2–5 s is a 3 s pause; 6–6.8 s is short and stays
    expect(pauses).toHaveLength(1);
    const p = pauses[0];
    expect(Math.abs(p.pauseStart - 2 * SR)).toBeLessThanOrEqual(hop);
    expect(Math.abs(p.pauseEnd - 5 * SR)).toBeLessThanOrEqual(hop);
    expect(Math.abs(p.end - p.start - 2.4 * SR)).toBeLessThanOrEqual(2 * hop);
    expect(Math.abs(p.start - (p.pauseStart + 0.3 * SR))).toBeLessThanOrEqual(1);
  });

  it('moves a hesitation cut onto the quiet points around it', () => {
    // the sound runs 1.0–1.5 s, the transcript says 1.05–1.42 s
    const x = speech(3, (t) => t >= 1 && t < 1.5);
    const hop = 40;
    const [a, b] = refineCut(levelsDb(x, hop), hop, 0, 1.05 * SR, 1.42 * SR, SR);
    expect(a).toBeLessThanOrEqual(1.0 * SR);
    expect(a).toBeGreaterThan(0.85 * SR);
    expect(b).toBeGreaterThanOrEqual(1.5 * SR);
    expect(b).toBeLessThan(1.65 * SR);
  });

  it('mutes a hesitation instead of cutting when someone else talks over it', () => {
    let p = createProject('C', SR);
    p = addTrack(p, { name: 'A' });
    p = addTrack(p, { name: 'B' });
    p.tracks[0].clips.push(clip('a', 'a.wav', 10 * SR));
    p.tracks[1].clips.push(clip('b', 'b.wav', 10 * SR));
    const t = (file: string, words: Array<[string, number, number]>): FileTranscript => ({ version: 1, file, sampleRate: SR, language: 'deu', model: 'm', created: '', words: words.map(([text, s, e]) => ({ text, start: s * SR, end: e * SR })) });
    const words = timelineWords(p, { 'a.wav': t('a.wav', [['ähm', 1, 1.3], ['äh', 4, 4.2]]), 'b.wav': t('b.wav', [['Genau', 3.9, 4.4]]) });
    const items = fillerItems(words);
    expect(items.map((i) => i.action)).toEqual(['cut', 'mute']);
    expect(othersSpeak(words, p.tracks[0].id, 1 * SR, 1.3 * SR)).toBe(false);
    const after = applyCleanup(p, items);
    expect(projectLength(after)).toBe(projectLength(p) - 0.3 * SR);
    // the mute moved with the cut before it
    expect(after.tracks[0].muteRegions).toEqual([[3.7 * SR, 3.9 * SR]]);
  });

  it('applies overlapping cuts once and adds up what they save', () => {
    let p = createProject('C', SR);
    p = addTrack(p, { name: 'A' });
    p.tracks[0].clips.push(clip('a', 'a.wav', 10 * SR));
    const items: CleanupItem[] = [
      { id: '1', kind: 'pause', start: 2 * SR, end: 4 * SR, action: 'cut' },
      { id: '2', kind: 'filler', start: 3.5 * SR, end: 4.5 * SR, action: 'cut', trackId: p.tracks[0].id },
    ];
    expect(cleanupSaving(items)).toBe(2.5 * SR);
    expect(projectLength(applyCleanup(p, items))).toBe(7.5 * SR);
  });

  it('scans an episode: pauses from the mix, hesitations from the transcript', () => {
    const dir = tmpDir();
    writeWavFile(path.join(dir, 'a.wav'), [speech(10, (t) => t < 2 || (t >= 2.5 && t < 2.8) || t >= 6)], SR, 32);
    let p: Project = createProject('C', SR);
    p = addTrack(p, { name: 'A' });
    p.tracks[0].clips.push(clip('a', 'a.wav', 10 * SR));
    const tr: FileTranscript = { version: 1, file: 'a.wav', sampleRate: SR, language: 'deu', model: 'm', created: '', words: [{ text: 'Hallo', start: 0.2 * SR, end: 1.8 * SR }, { text: 'ähm', start: 2.52 * SR, end: 2.75 * SR }, { text: 'Weiter', start: 6.1 * SR, end: 6.8 * SR }] };
    const words = timelineWords(p, { 'a.wav': tr });
    const items = scanCleanup(p, dir, words, { pauses: true, maxPause: 1.5, keepPause: 0.6, fillers: true });
    expect(items.map((i) => i.kind)).toEqual(['filler', 'pause']);
    const pause = items[1];
    expect(pause.pauseLength! / SR).toBeGreaterThan(3);
    const filler = items[0];
    expect(filler.start).toBeLessThanOrEqual(2.5 * SR);
    expect(filler.end).toBeGreaterThanOrEqual(2.8 * SR);
  });
});
