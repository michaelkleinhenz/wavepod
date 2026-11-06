import { describe, expect, it } from 'vitest';
import { addTrack, createProject, normalizeProject } from '../src/core/project';
import { timelineWords } from '../src/core/transcript';
import {
  activeRms,
  cloneVoice,
  listVoices,
  matchGainDb,
  normalizeSpeechSettings,
  pcm16ToFloat,
  prepareSpeech,
  speechBounds,
  speechContext,
  speechEditRange,
  speechTranscript,
  spliceSpeech,
  synthesizeSpeech,
  voiceSampleRanges,
} from '../src/core/speech';
import type { Clip, FileTranscript, Project } from '../src/shared/types';

const SR = 48000;
const clip = (id: string, file: string, start: number, offset: number, length: number): Clip => ({ id, file, start, offset, length, gain: 0, fadeIn: 0, fadeOut: 0 });
const tr = (file: string, words: Array<[string, number, number]>): FileTranscript => ({
  version: 1,
  file,
  sampleRate: SR,
  language: 'de',
  model: 'scribe_v2',
  created: '',
  words: words.map(([text, a, b]) => ({ text, start: a * SR, end: b * SR })),
});

function episode(): Project {
  let p = createProject('T', SR);
  p = addTrack(p, { name: 'Anna' });
  p = addTrack(p, { name: 'Ben' });
  p.tracks[0].clips.push(clip('a', 'media/anna.wav', 0, 0, 10 * SR));
  p.tracks[1].clips.push(clip('b', 'media/ben.wav', 0, 0, 10 * SR));
  return p;
}
const transcripts = {
  'media/anna.wav': tr('media/anna.wav', [['Wir', 0.5, 0.7], ['waren', 0.75, 1.0], ['gestern', 1.05, 1.5], ['dort.', 1.55, 1.9], ['Weiter', 6, 6.5]]),
  'media/ben.wav': tr('media/ben.wav', [['Ah', 2.5, 2.8], ['ja!', 2.9, 3.3]]),
};

describe('speech synthesis: where the words go', () => {
  const p = episode();
  const words = timelineWords(p, transcripts);
  const gestern = words.findIndex((w) => w.text === 'gestern');

  it('replaces the chosen words exactly', () => {
    expect(speechEditRange(words, gestern, gestern, 'replace', SR)).toEqual([1.05 * SR, 1.5 * SR]);
  });

  it('inserts in the pause next to the word, not far into it', () => {
    // between "gestern" (ends 1.5) and "dort." (starts 1.55): the middle of the 50 ms gap
    expect(speechEditRange(words, gestern, gestern, 'after', SR)).toEqual([1.525 * SR, 1.525 * SR]);
    // after "dort." the speaker pauses for 4 s (Ben's words don't count): 120 ms after the word
    const dort = words.findIndex((w) => w.text === 'dort.');
    expect(speechEditRange(words, dort, dort, 'after', SR)[0]).toBe(1.9 * SR + 0.12 * SR);
    expect(speechEditRange(words, 0, 0, 'before', SR)[0]).toBe(0.5 * SR - 0.12 * SR);
  });

  it("sends the speaker's own words around the edit as context", () => {
    const ctx = speechContext(words, p.tracks[0].id, gestern, gestern);
    expect(ctx.previousText).toBe('Wir waren');
    expect(ctx.nextText).toBe('dort. Weiter');
  });
});

describe('speech synthesis: splicing', () => {
  it('replaces the range on every track, keeps sync and softens the cut', () => {
    const p = episode();
    const anna = p.tracks[0].id;
    const len = 0.8 * SR;
    const { project, clipId } = spliceSpeech(p, { trackId: anna, start: 1.05 * SR, end: 1.5 * SR, file: 'media/tts-x.wav', length: len, gain: 3 });
    const a = project.tracks[0].clips;
    expect(a.map((c) => [c.start, c.length])).toEqual([
      [0, 1.05 * SR],
      [1.05 * SR, len],
      [1.05 * SR + len, 10 * SR - 1.5 * SR],
    ]);
    const added = a.find((c) => c.id === clipId)!;
    expect(added.file).toBe('media/tts-x.wav');
    expect(added.gain).toBe(3);
    expect(added.fadeIn).toBeGreaterThan(0);
    expect(a[0].fadeOut).toBeGreaterThan(0);
    expect(a[2].fadeIn).toBeGreaterThan(0);
    expect(a[2].offset).toBe(1.5 * SR);
    // Ben's track: same cut and the same room, so both stay in sync
    const b = project.tracks[1].clips;
    expect(b.map((c) => c.start)).toEqual([0, 1.05 * SR + len]);
    expect(b[1].offset).toBe(1.5 * SR);
  });

  it('inserts without taking anything out', () => {
    const p = episode();
    const { project } = spliceSpeech(p, { trackId: p.tracks[0].id, start: SR, end: SR, file: 'f.wav', length: SR / 2, gain: 0 });
    const a = project.tracks[0].clips;
    expect(a.reduce((n, c) => n + c.length, 0)).toBe(10.5 * SR);
    expect(a[2].offset).toBe(SR);
  });
});

describe('speech synthesis: audio', () => {
  const tone = (n: number, amp: number) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin(i * 0.05));

  it('finds the speech in silence and trims to it with padding', () => {
    const x = new Float32Array(SR);
    x.set(tone(SR / 4, 0.5), SR / 2);
    const b = speechBounds(x, SR)!;
    expect(Math.abs(b[0] - SR / 2)).toBeLessThan(SR * 0.011);
    expect(Math.abs(b[1] - 0.75 * SR)).toBeLessThan(SR * 0.011);
    const out = prepareSpeech(x, SR, 0.05);
    // 250 ms speech + 15 ms before + 40 ms after + 2 × 50 ms pad (± a window)
    expect(out.length / SR).toBeCloseTo(0.405, 1);
    expect(out[0]).toBe(0);
    expect(speechBounds(new Float32Array(1000), SR)).toBeNull();
  });

  it('matches the level by the loud parts only', () => {
    const quiet = new Float32Array(SR);
    quiet.set(tone(SR / 2, 0.1));
    const loud = tone(SR / 2, 0.4);
    expect(activeRms(quiet, SR)).toBeCloseTo(activeRms(tone(SR / 2, 0.1), SR), 3);
    expect(matchGainDb(activeRms(quiet, SR), activeRms(loud, SR))).toBeCloseTo(-12, 0);
    expect(matchGainDb(0, 1)).toBe(0);
    expect(matchGainDb(1, 0.0001)).toBe(24);
  });

  it('reads 16-bit PCM', () => {
    const b = new Uint8Array([0x00, 0x40, 0x00, 0xc0]);
    expect([...pcm16ToFloat(b)]).toEqual([0.5, -0.5]);
  });

  it('gives the generated file a transcript of its own', () => {
    const t = speechTranscript('media/tts.wav', 'ganz  sicher', SR, SR, 0.1 * SR);
    expect(t.words.map((w) => w.text)).toEqual(['ganz', 'sicher']);
    expect(t.words[0].start).toBe(0.1 * SR);
    expect(t.words[1].end).toBe(0.9 * SR);
  });
});

describe('speech synthesis: voice clone samples', () => {
  it("takes the speaker's longest phrases, in file frames, without hesitations", () => {
    const p = episode();
    p.tracks[0].clips[0] = clip('a', 'media/anna.wav', SR, 0, 10 * SR);
    const words = timelineWords(p, transcripts);
    const r = voiceSampleRanges(p, words, p.tracks[0].id, () => SR);
    // "Wir waren gestern dort." is one phrase (0.5–1.9 s in the file); "Weiter" is too short
    expect(r).toHaveLength(1);
    expect(r[0].file).toBe('media/anna.wav');
    expect(r[0].from).toBe(0.5 * SR - 0.08 * SR);
    expect(r[0].to).toBe(1.9 * SR + 0.08 * SR);
  });
});

describe('ElevenLabs text-to-speech and voices', () => {
  it('asks for raw PCM with the context and the voice settings', async () => {
    let seen: { url: string; key: string | null; body: Record<string, unknown> } | null = null;
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen = { url, key: new Headers(init.headers).get('xi-api-key'), body: JSON.parse(String(init.body)) };
      return new Response(new Uint8Array([0, 0x40, 0, 0x40]), { status: 200 });
    }) as unknown as typeof fetch;
    const s = normalizeSpeechSettings(null);
    const res = await synthesizeSpeech('k1', { voiceId: 'v 1', text: 'Hallo', previousText: 'Wir', nextText: '' }, s, { base: 'http://mock', fetchFn });
    expect(seen!.url).toBe('http://mock/v1/text-to-speech/v%201?output_format=pcm_24000');
    expect(seen!.key).toBe('k1');
    expect(seen!.body).toMatchObject({ text: 'Hallo', model_id: 'eleven_multilingual_v2', previous_text: 'Wir' });
    expect(seen!.body.next_text).toBeUndefined();
    expect(res.sampleRate).toBe(24000);
    expect([...res.samples]).toEqual([0.5, 0.5]);
    await synthesizeSpeech('k1', { voiceId: 'v', text: 'x' }, { ...s, hq: true }, { base: 'http://mock', fetchFn });
    expect(seen!.url).toContain('output_format=pcm_44100');
  });

  it('lists voices, cloned ones first, and clones from a WAV', async () => {
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/voices'))
        return new Response(JSON.stringify({ voices: [{ voice_id: 'p', name: 'Aria', category: 'premade' }, { voice_id: 'c', name: 'Zoe', category: 'cloned' }] }));
      const form = init!.body as FormData;
      expect(form.get('name')).toBe('WavePod · Anna');
      expect(form.get('files')).toBeInstanceOf(Blob);
      return new Response(JSON.stringify({ voice_id: 'new1' }));
    }) as unknown as typeof fetch;
    expect((await listVoices('k', { fetchFn })).map((v) => v.id)).toEqual(['c', 'p']);
    expect(await cloneVoice('k', 'WavePod · Anna', new Uint8Array(4), 'd', { fetchFn })).toBe('new1');
  });

  it('keeps the track voice through loading', () => {
    const p = episode();
    p.tracks[0].voice = { id: 'v1', name: 'Anna clone', cloned: true };
    const q = normalizeProject(JSON.parse(JSON.stringify(p)));
    expect(q.tracks[0].voice).toEqual({ id: 'v1', name: 'Anna clone', cloned: true });
    expect(q.tracks[1].voice).toBeUndefined();
  });
});
