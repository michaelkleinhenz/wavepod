import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { addTrack, createProject, rippleDelete } from '../src/core/project';
import { bareWord, filesToTranscribe, isFiller, isWholeTranscript, mergeTranscript, selectionToTranscribe, subtractSpans, unionSpans, paragraphs, timelineWords, transcriptPath, transcriptText, transcriptVtt, wordAt, wordsFromScribe, wordsRange } from '../src/core/transcript';
import { keytermList, normalizeTranscriptionSettings, scribeForm, transcribeWithScribe } from '../src/core/elevenlabs';
import { pcmToWav, wavToSpeechPcm } from '../src/core/speechAudio';
import { writeWavFile, parseWavHeader } from '../src/core/wav';
import type { Clip, FileTranscript, Project } from '../src/shared/types';
import { sine, tmpDir } from './helpers';

const SR = 48000;
const clip = (id: string, file: string, start: number, offset: number, length: number): Clip => ({ id, file, start, offset, length, gain: 0, fadeIn: 0, fadeOut: 0 });
const tr = (file: string, words: Array<[string, number, number]>, language = 'deu'): FileTranscript => ({
  version: 1,
  file,
  sampleRate: SR,
  language,
  model: 'scribe_v2',
  created: '',
  words: words.map(([text, a, b]) => ({ text, start: a * SR, end: b * SR })),
});

function episode(): { p: Project; transcripts: Record<string, FileTranscript> } {
  let p = createProject('T', SR);
  p = addTrack(p, { name: 'Anna' });
  p = addTrack(p, { name: 'Ben' });
  p.tracks[0].clips.push(clip('a', 'media/anna.wav', 0, 0, 10 * SR));
  p.tracks[1].clips.push(clip('b', 'media/ben.wav', 0, 0, 10 * SR));
  return {
    p,
    transcripts: {
      'media/anna.wav': tr('media/anna.wav', [['Hallo', 0.5, 0.9], ['ähm,', 1.0, 1.4], ['Ben.', 1.5, 1.9], ['Weiter', 6, 6.5]]),
      'media/ben.wav': tr('media/ben.wav', [['Hi', 2.5, 2.8], ['Anna!', 2.9, 3.3]]),
    },
  };
}

describe('transcript words', () => {
  it('reads ElevenLabs words and drops spacing and sound events', () => {
    const words = wordsFromScribe(
      [
        { text: 'Hallo', start: 0.1, end: 0.4, type: 'word' },
        { text: ' ', start: 0.4, end: 0.45, type: 'spacing' },
        { text: '(lacht)', start: 0.45, end: 1, type: 'audio_event' },
        { text: 'Welt.', start: 1, end: 1.3, type: 'word' },
      ],
      SR,
    );
    expect(words).toEqual([
      { text: 'Hallo', start: 0.1 * SR, end: 0.4 * SR },
      { text: 'Welt.', start: SR, end: 1.3 * SR },
    ]);
  });

  it('knows hesitations by language', () => {
    expect(isFiller('Ähm,', 'deu')).toBe(true);
    expect(isFiller('äh', 'de')).toBe(true);
    expect(isFiller('Hmm…', 'en')).toBe(true);
    expect(isFiller('um', 'eng')).toBe(true);
    // real German words
    expect(isFiller('um', 'deu')).toBe(false);
    expect(isFiller('er', 'deu')).toBe(false);
    expect(isFiller('Hallo', 'deu')).toBe(false);
    expect(bareWord('»Ähm!«')).toBe('ähm');
  });

  it('places words on the timeline through cuts, and follows the clips', () => {
    const { p, transcripts } = episode();
    let words = timelineWords(p, transcripts);
    expect(words.map((w) => w.text)).toEqual(['Hallo', 'ähm,', 'Ben.', 'Hi', 'Anna!', 'Weiter']);
    expect(words[1].filler).toBe(true);
    // cut out 4–5.5 s: "Weiter" moves 1.5 s earlier; the words before stay
    const cut = rippleDelete(p, 4 * SR, 5.5 * SR);
    words = timelineWords(cut, transcripts);
    expect(words.at(-1)!.start).toBe(4.5 * SR);
    expect(words[0].start).toBe(0.5 * SR);
    // a cut through a word drops the word with the cut half
    const through = rippleDelete(p, 0.4 * SR, 0.8 * SR);
    expect(timelineWords(through, transcripts).map((w) => w.text)).not.toContain('Hallo');
  });

  it('groups words into speaker paragraphs and finds the playing word', () => {
    const { p, transcripts } = episode();
    const words = timelineWords(p, transcripts);
    const paras = paragraphs(words, SR);
    expect(paras.map((x) => p.tracks.find((t) => t.id === x.trackId)!.name)).toEqual(['Anna', 'Ben', 'Anna']);
    expect(wordAt(words, 2.6 * SR)).toBe(3);
    expect(wordAt(words, 0)).toBe(-1);
    expect(wordsRange(words, 0, 2)).toEqual([0.5 * SR, 1.9 * SR]);
    expect(transcriptText(p, words)).toBe('[0:00] Anna: Hallo ähm, Ben.\n\n[0:02] Ben: Hi Anna!\n\n[0:06] Anna: Weiter');
    const vtt = transcriptVtt(p, words);
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    expect(vtt).toContain('00:00:02.500 --> 00:00:03.300\n<v Ben>Hi Anna!');
  });

  it('lists the files still to transcribe', () => {
    const { p } = episode();
    expect(filesToTranscribe(p, (f) => f === 'media/anna.wav')).toEqual([{ file: 'media/ben.wav', trackId: p.tracks[1].id }]);
    expect(transcriptPath('media/anna.wav')).toBe('transcripts/media_anna.wav.json');
  });
});

describe('transcribing a timeline selection', () => {
  const s = (a: number, b: number): [number, number] => [a * SR, b * SR];

  it('joins and subtracts spans', () => {
    expect(unionSpans([s(5, 6), s(0, 2), s(1, 3)])).toEqual([s(0, 3), s(5, 6)]);
    expect(subtractSpans([s(0, 10)], [s(2, 3), s(5, 6)])).toEqual([s(0, 2), s(3, 5), s(6, 10)]);
    expect(subtractSpans([s(2, 3)], [s(0, 10)])).toEqual([]);
  });

  it('asks only for the parts of the files the selection plays, with room around them', () => {
    const { p } = episode();
    // Ben's clip is cut: the part at 4-10 s on the timeline plays the file from 20 s on
    p.tracks[1].clips = [clip('b1', 'media/ben.wav', 0, 0, 4 * SR), clip('b2', 'media/ben.wav', 4 * SR, 20 * SR, 6 * SR)];
    const todo = selectionToTranscribe(p, s(3, 5), () => null);
    expect(todo).toEqual([
      { file: 'media/anna.wav', trackId: p.tracks[0].id, spans: [s(2, 6)] },
      { file: 'media/ben.wav', trackId: p.tracks[1].id, spans: [s(2, 5), s(19, 22)] },
    ]);
    // only the tracks dragged across
    expect(selectionToTranscribe(p, s(3, 5), () => null, [p.tracks[0].id]).map((t) => t.file)).toEqual(['media/anna.wav']);
  });

  it('skips what is transcribed already', () => {
    const { p } = episode();
    const whole = tr('media/anna.wav', []);
    const part = { ...tr('media/ben.wav', []), spans: [s(0, 4)] };
    const have = (f: string) => (f === 'media/anna.wav' ? whole : part);
    expect(isWholeTranscript(whole)).toBe(true);
    expect(isWholeTranscript(part)).toBe(false);
    // Ben 1-3 s is covered: nothing to do
    expect(selectionToTranscribe(p, s(1, 3), have)).toEqual([]);
    // Ben 3-6 s: only 4-6 s (and its room) is new
    expect(selectionToTranscribe(p, s(3, 6), have)).toEqual([{ file: 'media/ben.wav', trackId: p.tracks[1].id, spans: [s(3, 7)] }]);
  });

  it('adds the words of new parts to a partial transcript', () => {
    const old = { ...tr('media/ben.wav', [['eins', 1, 1.5], ['zwei', 3.8, 4.4]]), spans: [s(0, 5)] };
    // the new part starts at 4 s: "zwei" comes back cut as "ei" and is kept whole from before
    const part = { ...tr('media/ben.wav', [['ei', 4, 4.4], ['drei', 6, 6.5]]), spans: [s(4.6, 8)] };
    const merged = mergeTranscript(old, part);
    expect(merged.words.map((w) => w.text)).toEqual(['eins', 'zwei', 'drei']);
    expect(merged.spans).toEqual([s(0, 8)]);
    // words heard again in a part replace the old ones there
    const again = mergeTranscript(old, { ...tr('media/ben.wav', [['Eins!', 1, 1.5]]), spans: [s(0.5, 2)] });
    expect(again.words.map((w) => w.text)).toEqual(['Eins!', 'zwei']);
    // a whole-file transcript stays whole
    expect(mergeTranscript(tr('media/ben.wav', [['eins', 1, 1.5]]), part).spans).toBeUndefined();
    expect(mergeTranscript(null, part)).toBe(part);
  });
});

describe('ElevenLabs speech-to-text', () => {
  it('sends a word-timed request with the key and the settings', async () => {
    let seen: { url: string; key: string | null; form: FormData } | null = null;
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen = { url, key: new Headers(init.headers).get('xi-api-key'), form: init.body as FormData };
      return new Response(JSON.stringify({ language_code: 'deu', words: [{ text: 'Hallo', start: 0, end: 0.3, type: 'word' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const s = normalizeTranscriptionSettings({ model: 'scribe_v2', language: 'de', keyterms: 'WavePod, RØDECaster\nWavePod' });
    const res = await transcribeWithScribe('k123', new Uint8Array(10), 'a.wav', s, { base: 'http://mock', fetchFn });
    expect(res.language_code).toBe('deu');
    expect(seen!.url).toBe('http://mock/v1/speech-to-text');
    expect(seen!.key).toBe('k123');
    expect(seen!.form.get('model_id')).toBe('scribe_v2');
    expect(seen!.form.get('language_code')).toBe('de');
    expect(seen!.form.get('timestamps_granularity')).toBe('word');
    expect(seen!.form.getAll('keyterms')).toEqual(['WavePod', 'RØDECaster']);
    expect(scribeForm(new Uint8Array(1), 'x.wav', { ...s, language: 'auto' }).has('language_code')).toBe(false);
    expect(keytermList('')).toEqual([]);
  });

  it('explains a rejected key', async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ detail: { message: 'invalid' } }), { status: 401 })) as unknown as typeof fetch;
    await expect(transcribeWithScribe('bad', new Uint8Array(1), 'a.wav', normalizeTranscriptionSettings(null), { fetchFn })).rejects.toThrow(/API key/);
  });

  it('uploads speech as 16 kHz mono 16-bit', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'a.wav');
    writeWavFile(file, [sine(440, 1, SR, 0.5), sine(440, 1, SR, 0.5)], SR, 24);
    const { pcm, sampleRate } = wavToSpeechPcm(file);
    expect(sampleRate).toBe(SR);
    expect(Math.abs(pcm.length - 16000)).toBeLessThan(80);
    const peak = pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(peak / 0x7fff).toBeGreaterThan(0.45);
    const wav = pcmToWav(pcm);
    const info = parseWavHeader(wav, wav.length);
    expect([info.sampleRate, info.channels, info.bitDepth, info.frames]).toEqual([16000, 1, 16, pcm.length]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
