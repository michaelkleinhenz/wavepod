// ElevenLabs speech-to-text (Scribe): https://elevenlabs.io/docs/api-reference/speech-to-text/convert
// One request per file; the answer has every word with its start and end time.
import type { TranscriptionSettings } from '../shared/types';
import type { ScribeWord } from './transcript';
import { CROSSTALK_CHOICES, CROSSTALK_DEFAULT_DB, MIN_LEVEL_CHOICES } from './wordLevels';

export const ELEVENLABS_BASE = 'https://api.elevenlabs.io';

export const SCRIBE_MODELS: Array<{ id: string; name: string; description: string }> = [
  { id: 'scribe_v2', name: 'Scribe v2', description: 'The current model: most accurate, with word times.' },
  { id: 'scribe_v1', name: 'Scribe v1', description: 'The previous model.' },
];

export const TRANSCRIPT_LANGUAGES: Array<{ code: string; name: string }> = [
  { code: 'auto', name: 'Detect automatically' },
  { code: 'de', name: 'German' },
  { code: 'en', name: 'English' },
  { code: 'fr', name: 'French' },
  { code: 'es', name: 'Spanish' },
  { code: 'it', name: 'Italian' },
  { code: 'nl', name: 'Dutch' },
  { code: 'pl', name: 'Polish' },
  { code: 'pt', name: 'Portuguese' },
];

export const DEFAULT_TRANSCRIPTION: TranscriptionSettings = { model: 'scribe_v2', language: 'auto', keyterms: '', crosstalkDb: CROSSTALK_DEFAULT_DB, minLevelDb: 0 };

export function normalizeTranscriptionSettings(raw: unknown): TranscriptionSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<TranscriptionSettings>;
  return {
    model: typeof r.model === 'string' && r.model.trim() ? r.model.trim() : DEFAULT_TRANSCRIPTION.model,
    language: TRANSCRIPT_LANGUAGES.some((l) => l.code === r.language) ? r.language! : 'auto',
    keyterms: typeof r.keyterms === 'string' ? r.keyterms.slice(0, 2000) : '',
    crosstalkDb: CROSSTALK_CHOICES.includes(r.crosstalkDb as number) ? r.crosstalkDb! : DEFAULT_TRANSCRIPTION.crosstalkDb,
    minLevelDb: MIN_LEVEL_CHOICES.includes(r.minLevelDb as number) ? r.minLevelDb! : DEFAULT_TRANSCRIPTION.minLevelDb,
  };
}

/** The key terms as the API takes them: up to 100, each kept short. */
export function keytermList(text: string): string[] {
  return [...new Set(text.split(/[,\n]/).map((t) => t.trim()).filter(Boolean))].slice(0, 100).map((t) => t.slice(0, 50));
}

export interface ScribeResponse {
  language_code?: string;
  language_probability?: number;
  text?: string;
  words?: ScribeWord[];
}

/** The form for one file: word-level times, sound events tagged (and dropped later), verbatim. */
export function scribeForm(audio: Uint8Array, fileName: string, s: TranscriptionSettings): FormData {
  const form = new FormData();
  form.append('model_id', s.model);
  form.append('file', new Blob([audio as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }), fileName);
  if (s.language && s.language !== 'auto') form.append('language_code', s.language);
  form.append('timestamps_granularity', 'word');
  form.append('tag_audio_events', 'true');
  // each track is one speaker already
  form.append('diarize', 'false');
  for (const term of keytermList(s.keyterms)) form.append('keyterms', term);
  return form;
}

/** A readable message for a failed request. */
export async function scribeError(res: Response): Promise<string> {
  let detail = '';
  try {
    const body = (await res.json()) as { detail?: { message?: string; status?: string } | string };
    detail = typeof body.detail === 'string' ? body.detail : (body.detail?.message ?? '');
  } catch {
    /* not JSON */
  }
  if (res.status === 401) return 'ElevenLabs didn\'t accept the API key. Check it in Settings › Transcription.';
  if (res.status === 429) return `ElevenLabs is rate limiting or your quota is used up${detail ? `: ${detail}` : ''}.`;
  return `ElevenLabs speech-to-text failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}.`;
}

export async function transcribeWithScribe(
  apiKey: string,
  audio: Uint8Array,
  fileName: string,
  s: TranscriptionSettings,
  opts: { base?: string; signal?: AbortSignal; fetchFn?: typeof fetch } = {},
): Promise<ScribeResponse> {
  const res = await (opts.fetchFn ?? fetch)(`${opts.base ?? ELEVENLABS_BASE}/v1/speech-to-text`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey },
    body: scribeForm(audio, fileName, s),
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(await scribeError(res));
  return (await res.json()) as ScribeResponse;
}
