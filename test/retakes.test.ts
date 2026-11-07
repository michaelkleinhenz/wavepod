import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRetakes, normWord, sameWord } from '../src/core/retakes';
import { applyCleanup } from '../src/core/cleanup';
import { scanCleanup } from '../src/core/cleanupScan';
import { addTrack, createProject, projectLength } from '../src/core/project';
import { writeWavFile } from '../src/core/wav';
import type { Project, TimelineWord } from '../src/shared/types';
import { tmpDir } from './helpers';

const SR = 1000;

/** Words of one speaker, one per entry as [text, start s, end s]. */
function say(trackId: string, ...ws: Array<[string, number, number]>): TimelineWord[] {
  return ws.map(([text, s, e]) => ({ text, start: s * SR, end: e * SR, trackId, clipId: 'c', filler: false }));
}

/** A sentence of evenly spaced words starting at `t`: 0.3 s per word with 0.05 s between. */
function sentence(trackId: string, t: number, text: string): TimelineWord[] {
  return say(trackId, ...text.split(' ').map((w, i): [string, number, number] => [w, t + i * 0.35, t + i * 0.35 + 0.3]));
}

describe('retakes', () => {
  it('compares words without case, punctuation and small slips', () => {
    expect(normWord('Heute,')).toBe('heute');
    expect(normWord('„Okay“')).toBe('okay');
    expect(sameWord('podcast', 'podcast')).toBe(true);
    expect(sameWord('wichtigste', 'wichtigsten')).toBe(true);
    expect(sameWord('the', 'they')).toBe(false);
  });

  it('cuts the first attempt of a sentence said again, up to where the new one starts', () => {
    const words = [
      ...sentence('a', 0, 'Heute sprechen wir über'),
      ...sentence('a', 2, 'Heute sprechen wir über das neue Album.'),
    ];
    const r = findRetakes(words, SR);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: 'retake', start: 0, end: 2 * SR, trackId: 'a', action: 'cut' });
    expect(r[0].text).toBe('Heute sprechen wir über');
    expect(r[0].kept?.startsWith('Heute sprechen wir über das')).toBe(true);
  });

  it('keeps the last of three attempts in one cut', () => {
    const words = [
      ...sentence('a', 0, 'Also das Wichtigste ist'),
      ...sentence('a', 2, 'Also das Wichtigste'),
      ...sentence('a', 4, 'Also das Wichtigste ist die Ruhe.'),
    ];
    const r = findRetakes(words, SR);
    expect(r).toHaveLength(1);
    expect(r[0].start).toBe(0);
    expect(r[0].end).toBe(4 * SR);
  });

  it('takes a two-word false start only when it broke off', () => {
    const broke = [...say('a', ['I', 0, 0.2], ['think', 0.25, 0.5]), ...sentence('a', 1, 'I think that works.')];
    expect(findRetakes(broke, SR)).toHaveLength(1);
    // two words in common but the first attempt went on: a new sentence, not a retake
    const went = [...sentence('a', 0, 'I think so. Really.'), ...sentence('a', 2, 'I think that works.')];
    expect(findRetakes(went, SR)).toHaveLength(0);
  });

  it('leaves two finished sentences that only begin alike', () => {
    const words = [...sentence('a', 0, 'Ich glaube das ist richtig so.'), ...sentence('a', 3, 'Ich glaube das ist ein guter Punkt.')];
    expect(findRetakes(words, SR)).toHaveLength(0);
    // with five words in common it is a retake after all
    const again = [...sentence('a', 0, 'Ich glaube das ist richtig so.'), ...sentence('a', 3, 'Ich glaube das ist richtig, ja.')];
    expect(findRetakes(again, SR)).toHaveLength(1);
  });

  it('ignores repeats when someone else talks in between, or across speakers, or too far apart', () => {
    const talk = [...sentence('a', 0, 'Was hältst du davon'), ...sentence('b', 1.5, 'Na ja ich weiß nicht so recht'), ...sentence('a', 4.5, 'Was hältst du davon jetzt?')];
    expect(findRetakes(talk, SR)).toHaveLength(0);
    const echo = [...sentence('a', 0, 'Das ist ja verrückt'), ...sentence('b', 2, 'Das ist ja verrückt!')];
    expect(findRetakes(echo, SR)).toHaveLength(0);
    const far = [...sentence('a', 0, 'Das ist ja verrückt'), ...sentence('a', 30, 'Das ist ja verrückt!')];
    expect(findRetakes(far, SR)).toHaveLength(0);
    // a quick "mhm" from the other side doesn't stop it
    const mhm = [...sentence('a', 0, 'Das ist ja verrückt'), ...say('b', ['Mhm.', 1.6, 1.8]), ...sentence('a', 2, 'Das ist ja völlig verrückt!')];
    expect(findRetakes(mhm, SR)).toHaveLength(1);
  });

  it('skips hesitations and muted words when comparing', () => {
    const words = [
      ...sentence('a', 0, 'Wir haben gestern'),
      { text: 'äh', start: 1.2 * SR, end: 1.4 * SR, trackId: 'a', clipId: 'c', filler: true },
      ...sentence('a', 2, 'Wir haben gestern gewonnen.'),
    ];
    expect(findRetakes(words, SR)).toHaveLength(1);
  });

  it('is found by the cleanup scan, placed before the kept attempt, and cut', () => {
    const sr = 8000;
    const dir = tmpDir();
    // speech 0–1.4 s (first attempt), quiet, speech 2–4 s (kept)
    let seed = 1;
    const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.002;
    const audio = new Float32Array(5 * sr).map((_, i) => {
      const t = i / sr;
      return ((t < 1.4 || (t >= 2 && t < 4)) ? 0.3 * Math.sin((2 * Math.PI * 220 * i) / sr) : 0) + noise();
    });
    writeWavFile(path.join(dir, 'a.wav'), [audio], sr, 32);
    let p: Project = createProject('R', sr);
    p = addTrack(p, { name: 'A' });
    p.tracks[0].clips.push({ id: 'c', file: 'a.wav', start: 0, offset: 0, length: 5 * sr, gain: 0, fadeIn: 0, fadeOut: 0 });
    const t = p.tracks[0].id;
    const w = (text: string, s: number, e: number): TimelineWord => ({ text, start: s * sr, end: e * sr, trackId: t, clipId: 'c', filler: false });
    const words = [w('Heute', 0, 0.3), w('sprechen', 0.35, 0.7), w('wir', 0.75, 1), w('über', 1.05, 1.35), w('Heute', 2, 2.3), w('sprechen', 2.35, 2.7), w('wir', 2.75, 3), w('über', 3.05, 3.35), w('Musik.', 3.4, 3.9)];
    const items = scanCleanup(p, dir, words, { pauses: false, maxPause: 1.5, keepPause: 0.6, fillers: true, retakes: true });
    expect(items.map((i) => i.kind)).toEqual(['retake']);
    // the cut ends in the quiet before the kept attempt, never inside it
    expect(items[0].end).toBeLessThanOrEqual(2 * sr);
    expect(items[0].end).toBeGreaterThan(1.4 * sr);
    const after = applyCleanup(p, items);
    expect(projectLength(p) - projectLength(after)).toBe(items[0].end - items[0].start);
  });
});
