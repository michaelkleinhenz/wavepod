// Speech synthesis for editing by text (experimental): ElevenLabs text-to-speech says a word or a
// short phrase in a speaker's voice (cloned from their own track, or one of the account's voices),
// and the result is spliced into the episode where the transcript says it belongs.
//   text-to-speech: https://elevenlabs.io/docs/api-reference/text-to-speech/convert
//   instant voice clone: https://elevenlabs.io/docs/api-reference/voices/ivc/create
import type { FileTranscript, Frames, Project, SpeechSettings, TimelineWord, TranscriptWord } from '../shared/types';
import { ELEVENLABS_BASE } from './elevenlabs';
import { rippleDelete, insertSilence } from './project';
import { uid } from '../shared/time';

export const TTS_MODELS: Array<{ id: string; name: string; description: string }> = [
  { id: 'eleven_multilingual_v2', name: 'Multilingual v2', description: 'Most natural and closest to a cloned voice; takes the words around it into account.' },
  { id: 'eleven_turbo_v2_5', name: 'Turbo v2.5', description: 'Faster and cheaper, a little less natural.' },
  { id: 'eleven_flash_v2_5', name: 'Flash v2.5', description: 'Fastest and cheapest.' },
];

export const DEFAULT_SPEECH: SpeechSettings = { model: 'eleven_multilingual_v2', hq: false, stability: 0.5, similarity: 0.85 };

export function normalizeSpeechSettings(raw: unknown): SpeechSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<SpeechSettings>;
  const unit = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d);
  return {
    model: typeof r.model === 'string' && r.model.trim() ? r.model.trim() : DEFAULT_SPEECH.model,
    hq: !!r.hq,
    stability: unit(r.stability, DEFAULT_SPEECH.stability),
    similarity: unit(r.similarity, DEFAULT_SPEECH.similarity),
  };
}

/** Raw 16-bit mono PCM; 44.1 kHz needs a Pro plan, 24 kHz works on every plan. */
export function speechFormat(s: SpeechSettings): { format: string; sampleRate: number } {
  return s.hq ? { format: 'pcm_44100', sampleRate: 44100 } : { format: 'pcm_24000', sampleRate: 24000 };
}

export interface ElevenVoice {
  id: string;
  name: string;
  /** "cloned", "premade", "generated", "professional"… */
  category: string;
}

type Opts = { base?: string; signal?: AbortSignal; fetchFn?: typeof fetch };

/** A readable message for a failed ElevenLabs request. */
export async function elevenError(res: Response, what: string): Promise<string> {
  let detail = '';
  try {
    const body = (await res.json()) as { detail?: { message?: string; status?: string } | string };
    detail = typeof body.detail === 'string' ? body.detail : (body.detail?.message ?? '');
  } catch {
    /* not JSON */
  }
  if (res.status === 401) return `ElevenLabs didn't accept the API key${detail ? ` (${detail})` : ''}. Check it in Edit › Settings.`;
  if (res.status === 429) return `ElevenLabs is rate limiting or your quota is used up${detail ? `: ${detail}` : ''}.`;
  return `${what} failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}.`;
}

export interface SpeakRequest {
  voiceId: string;
  text: string;
  /** The speaker's words just before and after, so the intonation fits in. */
  previousText?: string;
  nextText?: string;
}

/** The text-to-speech request body. */
export function speakBody(req: SpeakRequest, s: SpeechSettings): Record<string, unknown> {
  return {
    text: req.text,
    model_id: s.model,
    ...(req.previousText ? { previous_text: req.previousText } : {}),
    ...(req.nextText ? { next_text: req.nextText } : {}),
    voice_settings: { stability: s.stability, similarity_boost: s.similarity, use_speaker_boost: true },
  };
}

/** Says the text; returns mono float samples at the format's rate. */
export async function synthesizeSpeech(apiKey: string, req: SpeakRequest, s: SpeechSettings, opts: Opts = {}): Promise<{ samples: Float32Array; sampleRate: number }> {
  const { format, sampleRate } = speechFormat(s);
  const url = `${opts.base ?? ELEVENLABS_BASE}/v1/text-to-speech/${encodeURIComponent(req.voiceId)}?output_format=${format}`;
  const res = await (opts.fetchFn ?? fetch)(url, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'content-type': 'application/json', accept: 'audio/pcm' },
    body: JSON.stringify(speakBody(req, s)),
    signal: opts.signal,
  });
  if (!res.ok) {
    const msg = await elevenError(res, 'ElevenLabs text-to-speech');
    throw new Error(s.hq && res.status === 403 ? `${msg} High quality (44.1 kHz) needs a Pro plan; turn it off in the dialog.` : msg);
  }
  return { samples: pcm16ToFloat(new Uint8Array(await res.arrayBuffer())), sampleRate };
}

export async function listVoices(apiKey: string, opts: Opts = {}): Promise<ElevenVoice[]> {
  const res = await (opts.fetchFn ?? fetch)(`${opts.base ?? ELEVENLABS_BASE}/v1/voices`, { headers: { 'xi-api-key': apiKey }, signal: opts.signal });
  if (!res.ok) throw new Error(await elevenError(res, 'Loading the ElevenLabs voices'));
  const body = (await res.json()) as { voices?: Array<{ voice_id?: string; name?: string; category?: string }> };
  return (body.voices ?? [])
    .filter((v) => typeof v.voice_id === 'string' && v.voice_id)
    .map((v) => ({ id: v.voice_id!, name: v.name || v.voice_id!, category: v.category ?? '' }))
    .sort((a, b) => Number(b.category === 'cloned') - Number(a.category === 'cloned') || a.name.localeCompare(b.name));
}

/** Instant voice clone from one WAV of the speaker; returns the new voice's id. */
export async function cloneVoice(apiKey: string, name: string, wav: Uint8Array, description: string, opts: Opts = {}): Promise<string> {
  const form = new FormData();
  form.append('name', name);
  form.append('description', description);
  form.append('remove_background_noise', 'false');
  form.append('files', new Blob([wav as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }), 'sample.wav');
  const res = await (opts.fetchFn ?? fetch)(`${opts.base ?? ELEVENLABS_BASE}/v1/voices/add`, { method: 'POST', headers: { 'xi-api-key': apiKey }, body: form, signal: opts.signal });
  if (!res.ok) throw new Error(await elevenError(res, 'Cloning the voice'));
  const body = (await res.json()) as { voice_id?: string };
  if (!body.voice_id) throw new Error('ElevenLabs made no voice.');
  return body.voice_id;
}

export async function deleteVoice(apiKey: string, voiceId: string, opts: Opts = {}): Promise<void> {
  const res = await (opts.fetchFn ?? fetch)(`${opts.base ?? ELEVENLABS_BASE}/v1/voices/${encodeURIComponent(voiceId)}`, { method: 'DELETE', headers: { 'xi-api-key': apiKey }, signal: opts.signal });
  // already gone is fine
  if (!res.ok && res.status !== 404) throw new Error(await elevenError(res, 'Deleting the voice'));
}

/** Little-endian signed 16-bit PCM to floats. */
export function pcm16ToFloat(bytes: Uint8Array): Float32Array {
  const n = bytes.length >> 1;
  const out = new Float32Array(n);
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 0x8000;
  return out;
}

/**
 * Where the speech is: the first and last 10 ms window above `thresholdDb` (relative to full
 * scale). TTS output starts and ends with some silence; that would leave odd pauses.
 */
export function speechBounds(x: Float32Array, sampleRate: number, thresholdDb = -45): [number, number] | null {
  const win = Math.max(1, Math.round(sampleRate * 0.01));
  const thr = 10 ** (thresholdDb / 20);
  let first = -1;
  let last = -1;
  for (let i = 0; i < x.length; i += win) {
    const end = Math.min(x.length, i + win);
    let e = 0;
    for (let j = i; j < end; j++) e += x[j] * x[j];
    if (Math.sqrt(e / (end - i)) >= thr) {
      if (first < 0) first = i;
      last = end;
    }
  }
  return first < 0 ? null : [first, last];
}

/** RMS of the loud parts only (10 ms windows within 30 dB of the loudest), so pauses don't count. */
export function activeRms(x: Float32Array, sampleRate: number): number {
  const win = Math.max(1, Math.round(sampleRate * 0.01));
  const energies: number[] = [];
  for (let i = 0; i + win <= x.length; i += win) {
    let e = 0;
    for (let j = i; j < i + win; j++) e += x[j] * x[j];
    energies.push(e / win);
  }
  if (!energies.length) return 0;
  const max = Math.max(...energies);
  if (max <= 0) return 0;
  const gate = max / 1000; // -30 dB
  let sum = 0;
  let n = 0;
  for (const e of energies) {
    if (e < gate) continue;
    sum += e;
    n++;
  }
  return Math.sqrt(sum / n);
}

/** Clip gain (dB) that brings the generated speech to the speaker's level, within ±24 dB. */
export function matchGainDb(referenceRms: number, generatedRms: number): number {
  if (!(referenceRms > 0) || !(generatedRms > 0)) return 0;
  const db = 20 * Math.log10(referenceRms / generatedRms);
  return Math.round(Math.min(24, Math.max(-24, db)) * 10) / 10;
}

/**
 * The generated word, ready for the timeline: silence trimmed, short fades so it doesn't click,
 * `pad` seconds of silence on both sides.
 */
export function prepareSpeech(samples: Float32Array, sampleRate: number, padSeconds: number): Float32Array {
  const b = speechBounds(samples, sampleRate);
  // keep 15 ms before and 40 ms after the detected speech: soft onsets and tails sit below the threshold
  const from = b ? Math.max(0, b[0] - Math.round(0.015 * sampleRate)) : 0;
  const to = b ? Math.min(samples.length, b[1] + Math.round(0.04 * sampleRate)) : samples.length;
  const pad = Math.round(padSeconds * sampleRate);
  const out = new Float32Array(to - from + 2 * pad);
  out.set(samples.subarray(from, to), pad);
  const fade = Math.min(Math.round(0.005 * sampleRate), (to - from) >> 1);
  for (let i = 0; i < fade; i++) {
    const g = i / fade;
    out[pad + i] *= g;
    out[pad + (to - from) - 1 - i] *= g;
  }
  return out;
}

/** The speaker's own words around the edit (up to `max` each way), for the model's context. */
export function speechContext(words: TimelineWord[], trackId: string, from: number, to: number, max = 25): { previousText: string; nextText: string } {
  const before: string[] = [];
  for (let i = from - 1; i >= 0 && before.length < max; i--) if (words[i].trackId === trackId) before.unshift(words[i].text);
  const after: string[] = [];
  for (let i = to + 1; i < words.length && after.length < max; i++) if (words[i].trackId === trackId) after.push(words[i].text);
  return { previousText: before.join(' '), nextText: after.join(' ') };
}

export type SpeechEditMode = 'replace' | 'before' | 'after';

/**
 * Where the new words go: for replace, the selected words' time; for insert, inside the pause
 * next to the word (at most 120 ms away from it, so a long pause stays mostly where it was).
 * `words` are the timeline words, `from..to` the chosen ones (one track).
 */
export function speechEditRange(words: TimelineWord[], from: number, to: number, mode: SpeechEditMode, sampleRate: number): [Frames, Frames] {
  const a = words[from];
  const b = words[to];
  const trackId = a.trackId;
  const near = Math.round(0.12 * sampleRate);
  if (mode === 'replace') return [a.start, Math.max(a.start, b.end)];
  if (mode === 'after') {
    let next = Infinity;
    for (let i = to + 1; i < words.length; i++) {
      if (words[i].trackId !== trackId) continue;
      next = words[i].start;
      break;
    }
    const at = b.end + Math.min(near, Math.max(0, Math.floor((next - b.end) / 2)));
    return [at, at];
  }
  let prev = -Infinity;
  for (let i = from - 1; i >= 0; i--) {
    if (words[i].trackId !== trackId) continue;
    prev = words[i].end;
    break;
  }
  const at = a.start - Math.min(near, Math.max(0, Math.floor((a.start - prev) / 2)));
  return [Math.max(0, at), Math.max(0, at)];
}

/** Silence each side of the generated words: more when inserting, so the word stands apart. */
export function speechPad(mode: SpeechEditMode): number {
  return mode === 'replace' ? 0.02 : 0.06;
}

/**
 * Puts the generated clip in: takes [start, end) out of every track (nothing for an insert),
 * makes room for the new clip on every track, so the other tracks stay in sync, and adds it to
 * the speaker's track. The cut edges get short fades. Returns the new clip's id.
 */
export function spliceSpeech(
  project: Project,
  opts: { trackId: string; start: Frames; end: Frames; file: string; length: Frames; gain: number; fade?: Frames },
): { project: Project; clipId: string } {
  const { trackId, start, end, file, length, gain } = opts;
  const fade = opts.fade ?? Math.round(0.008 * project.sampleRate);
  let p = end > start ? rippleDelete(project, start, end) : project;
  p = insertSilence(p, start, length);
  const clipId = uid('clp');
  const track = p.tracks.find((t) => t.id === trackId);
  if (!track) return { project: p, clipId };
  for (const t of p.tracks) {
    for (const c of t.clips) {
      // the cut ends: soften them so the splice doesn't click
      if (c.start + c.length === start && c.fadeOut < fade) c.fadeOut = Math.min(fade, c.length);
      if (c.start === start + length && c.fadeIn < fade) c.fadeIn = Math.min(fade, c.length);
    }
  }
  track.clips = [...track.clips, { id: clipId, file, start, offset: 0, length, gain, fadeIn: Math.min(fade, length >> 1), fadeOut: Math.min(fade, length >> 1), note: 'Speech synthesis' }].sort(
    (x, y) => x.start - y.start,
  );
  return { project: p, clipId };
}

/** A transcript for the generated file: the words spread over the speech by their length. */
export function speechTranscript(file: string, text: string, sampleRate: number, length: Frames, padFrames: Frames): FileTranscript {
  const parts = text.split(/\s+/).filter(Boolean);
  const from = Math.min(padFrames, length);
  const to = Math.max(from, length - padFrames);
  const weights = parts.map((w) => w.length + 1);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const words: TranscriptWord[] = [];
  let pos = from;
  parts.forEach((w, i) => {
    const len = ((to - from) * weights[i]) / total;
    words.push({ text: w, start: Math.round(pos), end: Math.round(pos + len) });
    pos += len;
  });
  return { version: 1, file, sampleRate, language: '', model: 'tts', created: new Date().toISOString(), words };
}

/**
 * Pieces of a speaker's track to clone the voice from: their phrases (words with less than half
 * a second between them), longest first, hesitations and muted bits left out, up to `maxSeconds`.
 * Returned in file frames, by file, in the order they were spoken.
 */
export function voiceSampleRanges(
  project: Project,
  words: TimelineWord[],
  trackId: string,
  fileRate: (file: string) => number,
  maxSeconds = 90,
): Array<{ file: string; from: number; to: number }> {
  const sr = project.sampleRate;
  const clips = new Map(project.tracks.find((t) => t.id === trackId)?.clips.map((c) => [c.id, c]) ?? []);
  type Phrase = { clipId: string; start: number; end: number };
  const phrases: Phrase[] = [];
  let cur: Phrase | null = null;
  for (const w of words) {
    if (w.trackId !== trackId || w.filler || w.muted) {
      if (w.trackId === trackId) cur = null;
      continue;
    }
    if (cur && cur.clipId === w.clipId && w.start - cur.end < sr * 0.5) cur.end = Math.max(cur.end, w.end);
    else {
      cur = { clipId: w.clipId, start: w.start, end: w.end };
      phrases.push(cur);
    }
  }
  const picked: Phrase[] = [];
  let total = 0;
  const pad = Math.round(sr * 0.08);
  for (const ph of [...phrases].sort((a, b) => b.end - b.start - (a.end - a.start))) {
    if (total >= maxSeconds * sr) break;
    if (ph.end - ph.start < sr * 0.6) break;
    picked.push(ph);
    total += ph.end - ph.start;
  }
  return picked
    .sort((a, b) => a.start - b.start)
    .flatMap((ph) => {
      const c = clips.get(ph.clipId);
      if (!c) return [];
      const scale = sr / (fileRate(c.file) || sr);
      const start = Math.max(c.start, ph.start - pad);
      const end = Math.min(c.start + c.length, ph.end + pad);
      return [{ file: c.file, from: Math.round((start - c.start + c.offset) / scale), to: Math.round((end - c.start + c.offset) / scale) }];
    });
}
