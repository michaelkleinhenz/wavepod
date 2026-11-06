import { describe, expect, it } from 'vitest';
import { addTrack, createProject } from '../src/core/project';
import { timelineWords } from '../src/core/transcript';
import { filterQuietWords, levelCurve, peakLevel, sameWord } from '../src/core/wordLevels';
import { normalizeTranscriptionSettings } from '../src/core/elevenlabs';
import * as path from 'node:path';
import { wavLevelCurve, wavToSpeechPcm, SPEECH_RATE } from '../src/core/speechAudio';
import { writeWavFile } from '../src/core/wav';
import { tmpDir } from './helpers';
import type { Clip, FileTranscript, Project } from '../src/shared/types';

const SR = 48000;
const PCM = 16000;
const clip = (id: string, file: string, start: number, offset = 0, length = 10 * SR): Clip => ({ id, file, start, offset, length, gain: 0, fadeIn: 0, fadeOut: 0 });

/** 10 s of 16 kHz audio with a 500 Hz tone at the given dBFS in each [from, to, db] span. */
function audio(spans: Array<[number, number, number]>): Float32Array {
  const x = new Float32Array(10 * PCM);
  for (const [a, b, db] of spans) {
    const amp = Math.SQRT2 * 10 ** (db / 20);
    for (let i = Math.round(a * PCM); i < Math.round(b * PCM); i++) x[i] = amp * Math.sin((2 * Math.PI * 500 * i) / PCM);
  }
  return x;
}

const tr = (file: string, words: Array<[string, number, number]>, spans: Array<[number, number, number]> | null): FileTranscript => ({
  version: 1,
  file,
  sampleRate: SR,
  language: 'de',
  model: 'scribe_v2',
  created: '',
  words: words.map(([text, a, b]) => ({ text, start: a * SR, end: b * SR })),
  ...(spans ? { levels: levelCurve(audio(spans), PCM, SR) } : {}),
});

/** Anna speaks at -20 dB from 1–2 s; her voice bleeds into Ben's mic at -45 dB, and Ben's transcript has those words too. */
function episode(): { p: Project; transcripts: Record<string, FileTranscript> } {
  let p = createProject('T', SR);
  p = addTrack(p, { name: 'Anna' });
  p = addTrack(p, { name: 'Ben' });
  p.tracks[0].clips.push(clip('a', 'anna.wav', 0));
  p.tracks[1].clips.push(clip('b', 'ben.wav', 0));
  return {
    p,
    transcripts: {
      'anna.wav': tr('anna.wav', [['Hallo', 1, 1.4], ['Ben', 1.5, 1.9], ['ja', 5.1, 5.3]], [[1, 2, -20], [5.1, 5.3, -30]]),
      'ben.wav': tr('ben.wav', [['Hallo', 1, 1.4], ['Ben', 1.5, 1.9], ['Hi', 4, 4.4], ['genau', 5, 5.5]], [[1, 2, -45], [4, 4.5, -18], [5, 5.5, -22]]),
    },
  };
}

describe('word levels', () => {
  it('keeps a level curve that reads back the loudest level of a span', () => {
    const l = levelCurve(audio([[1, 2, -20]]), PCM, SR);
    expect(l.step).toBe(0.02 * SR);
    expect(peakLevel(l, 1.2 * SR, 1.6 * SR)).toBeCloseTo(-20, 0);
    // digital silence is the floor; only a span outside the file has no level at all
    expect(peakLevel(l, 3 * SR, 4 * SR)).toBe(-120);
    expect(peakLevel(l, 20 * SR, 21 * SR)).toBe(-Infinity);
  });

  it('reads the curve of a WAV file directly, matching the one made from speech audio', () => {
    const file = path.join(tmpDir(), 'take.wav');
    const x = new Float32Array(4 * SR);
    for (let i = SR; i < 2 * SR; i++) x[i] = 0.1 * Math.sin(i / 10);
    for (let i = 3 * SR; i < 4 * SR; i++) x[i] = 0.003 * Math.sin(i / 10);
    writeWavFile(file, [x, x], SR, 24);
    const fast = wavLevelCurve(file);
    const { pcm, sampleRate } = wavToSpeechPcm(file);
    const slow = levelCurve(pcm, SPEECH_RATE, sampleRate);
    expect(fast.step).toBe(slow.step);
    for (const [a, b] of [[1.2, 1.5], [3.2, 3.6]]) expect(peakLevel(fast, a * SR, b * SR)).toBeCloseTo(peakLevel(slow, a * SR, b * SR), 0);
  });

  it('leaves out crosstalk: words much louder on another track', () => {
    const { p, transcripts } = episode();
    const all = timelineWords(p, transcripts);
    expect(all).toHaveLength(7);
    const words = timelineWords(p, transcripts, { crosstalkDb: 15, minLevelDb: 0 });
    const by = (id: string) => words.filter((w) => w.trackId === p.tracks[id === 'a' ? 0 : 1].id).map((w) => w.text);
    expect(by('a')).toEqual(['Hallo', 'Ben', 'ja']);
    // Ben's copy of Anna's words is 25 dB down: gone. His own words stay, and Anna's "ja", 8 dB quieter than Ben, stays as well.
    expect(by('b')).toEqual(['Hi', 'genau']);
    expect(filterQuietWords(p, transcripts, all, { crosstalkDb: 15, minLevelDb: 0 }).hidden).toBe(2);
  });

  it('can keep everything, or cut by a plain level threshold', () => {
    const { p, transcripts } = episode();
    expect(timelineWords(p, transcripts, { crosstalkDb: 0, minLevelDb: 0 })).toHaveLength(7);
    const words = timelineWords(p, transcripts, { crosstalkDb: 0, minLevelDb: -40 });
    expect(words.map((w) => w.text)).toEqual(['Hallo', 'Ben', 'Hi', 'genau', 'ja']);
  });

  it('counts track and clip gain when comparing tracks', () => {
    const { p, transcripts } = episode();
    // Ben's mic recorded low, so he turned it up by 30 dB: the bleed now is as loud as Anna
    p.tracks[1].gain = 30;
    const words = timelineWords(p, transcripts, { crosstalkDb: 15, minLevelDb: 0 });
    expect(words.filter((w) => w.trackId === p.tracks[1].id).map((w) => w.text)).toContain('Hallo');
  });

  it('keeps words of transcripts without a level curve', () => {
    const { p, transcripts } = episode();
    const old = { ...transcripts['ben.wav'] };
    delete old.levels;
    const words = timelineWords(p, { ...transcripts, 'ben.wav': old }, { crosstalkDb: 15, minLevelDb: -60 });
    expect(words.filter((w) => w.trackId === p.tracks[1].id)).toHaveLength(4);
  });

  it('follows clips moved on the timeline', () => {
    const { p, transcripts } = episode();
    // Ben's clip moved 3 s later: his bleed of "Hallo" no longer lines up with Anna speaking
    p.tracks[1].clips[0] = clip('b', 'ben.wav', 3 * SR, 0, 7 * SR);
    const words = timelineWords(p, transcripts, { crosstalkDb: 15, minLevelDb: 0 });
    expect(words.filter((w) => w.trackId === p.tracks[1].id).map((w) => w.text)).toContain('Hallo');
  });

  it('leaves out echoes: the same words, quieter, at the same time on another track', () => {
    let p = createProject('T', SR);
    p = addTrack(p, { name: 'Anna' });
    p = addTrack(p, { name: 'Ben' });
    p.tracks[0].clips.push(clip('a', 'anna.wav', 0));
    p.tracks[1].clips.push(clip('b', 'ben.wav', 0));
    // close mics: Anna's voice reaches Ben's mic only 6 dB down; Ben says "ja" over her
    const transcripts = {
      'anna.wav': tr('anna.wav', [['Wir', 1, 1.2], ['haben', 1.25, 1.5], ['heute', 1.55, 1.8], ['einen', 1.85, 2.0], ['Gast.', 2.05, 2.4]], [[1, 2.5, -20]]),
      'ben.wav': tr(
        'ben.wav',
        // the speech-to-text heard "einen" on Ben's mic as "eine" and "heute" as "Leute"
        [['wir', 1.02, 1.2], ['haben', 1.27, 1.5], ['Leute', 1.56, 1.8], ['eine', 1.86, 2.0], ['Gast', 2.06, 2.4], ['ja', 3, 3.2]],
        [[1, 2.5, -26], [3, 3.3, -22]],
      ),
    };
    const level = timelineWords(p, transcripts, { crosstalkDb: 15, minLevelDb: 0 });
    expect(level).toHaveLength(11);
    const words = timelineWords(p, transcripts, { crosstalkDb: 15, minLevelDb: 0, matchWords: true });
    expect(words.filter((w) => w.trackId === p.tracks[0].id).map((w) => w.text)).toEqual(['Wir', 'haben', 'heute', 'einen', 'Gast.']);
    expect(words.filter((w) => w.trackId === p.tracks[1].id).map((w) => w.text)).toEqual(['ja']);
  });

  it('does not take different words said at the same time for echoes', () => {
    const { p, transcripts } = episode();
    // Ben really talks over Anna, quieter, with other words
    transcripts['ben.wav'] = tr('ben.wav', [['genau', 1.1, 1.4], ['richtig', 1.5, 1.9]], [[1, 2, -24]]);
    const words = timelineWords(p, transcripts, { crosstalkDb: 15, minLevelDb: 0, matchWords: true });
    expect(words.filter((w) => w.trackId === p.tracks[1].id).map((w) => w.text)).toEqual(['genau', 'richtig']);
  });

  it('keeps the speaker right when the other person laughs over part of a sentence', () => {
    let p = createProject('T', SR);
    p = addTrack(p, { name: 'Anna' });
    p = addTrack(p, { name: 'Ben' });
    p.tracks[0].clips.push(clip('a', 'anna.wav', 0));
    p.tracks[1].clips.push(clip('b', 'ben.wav', 0));
    const sentence: Array<[string, number, number]> = [
      ['Und', 1, 1.2], ['dann', 1.3, 1.5], ['ist', 1.6, 1.8], ['der', 1.9, 2.1], ['Hund', 2.2, 2.5],
      ['einfach', 2.6, 3.0], ['in', 3.1, 3.2], ['den', 3.3, 3.5], ['See', 3.6, 3.9], ['gesprungen.', 4.0, 4.5],
    ];
    // close mics: Anna 6 dB down on Ben's mic; Ben laughs loudly from 2.2 to 3.2 s (her bleed of it on her mic)
    const transcripts = {
      'anna.wav': tr('anna.wav', sentence, [[1, 4.6, -20], [2.2, 3.2, -18]]),
      'ben.wav': tr('ben.wav', [...sentence.map(([t, a, b]) => [t.toLowerCase(), a + 0.01, b] as [string, number, number]), ['haha', 2.2, 3.2]], [[1, 4.6, -26], [2.2, 3.2, -8]]),
    };
    const words = timelineWords(p, transcripts, { crosstalkDb: 6, minLevelDb: 0, matchWords: true });
    expect(words.filter((w) => w.trackId === p.tracks[0].id).map((w) => w.text)).toEqual(sentence.map(([t]) => t));
    // Ben keeps only his laugh, none of Anna's words
    expect(words.filter((w) => w.trackId === p.tracks[1].id).map((w) => w.text)).toEqual(['haha']);
  });

  it('does not drop words because another track only laughs or coughs', () => {
    const { p, transcripts } = episode();
    // Ben laughs loudly over Anna's "Hallo Ben" and nothing of it is transcribed on his track
    transcripts['ben.wav'] = tr('ben.wav', [['Hi', 4, 4.4]], [[1, 2, -8], [4, 4.5, -18]]);
    const words = timelineWords(p, transcripts, { crosstalkDb: 6, minLevelDb: 0, matchWords: true });
    expect(words.filter((w) => w.trackId === p.tracks[0].id).map((w) => w.text)).toEqual(['Hallo', 'Ben', 'ja']);
  });

  it('matches words with one letter off only when they are long enough', () => {
    expect(sameWord('okay', 'okey')).toBe(true);
    expect(sameWord('genau', 'genauu')).toBe(true);
    expect(sameWord('das', 'dass')).toBe(false);
    expect(sameWord('ja', 'je')).toBe(false);
    expect(sameWord('heute', 'leute')).toBe(true);
  });

  it('settings default to 15 dB and fall back on unknown values', () => {
    expect(normalizeTranscriptionSettings(null)).toMatchObject({ crosstalkDb: 15, minLevelDb: 0, matchWords: true });
    expect(normalizeTranscriptionSettings({ matchWords: false })).toMatchObject({ matchWords: false });
    expect(normalizeTranscriptionSettings({ crosstalkDb: 10, minLevelDb: -50 })).toMatchObject({ crosstalkDb: 10, minLevelDb: -50 });
    expect(normalizeTranscriptionSettings({ crosstalkDb: 7, minLevelDb: 3 })).toMatchObject({ crosstalkDb: 15, minLevelDb: 0 });
  });
});
