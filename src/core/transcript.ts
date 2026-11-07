// Transcripts: words with times, kept per recorded file (in that file's own frames) so every
// edit — cuts, moves, trims, splits — keeps them in place. The timeline view of a transcript is
// worked out from the clips each time, the same way volume lines are.
import type { FileTranscript, Frames, Project, TimelineWord, TranscriptWord } from '../shared/types';
import { filterQuietWords, type WordFilter } from './wordLevels';

/** One entry of the `words` list ElevenLabs' speech-to-text returns; times in seconds. */
export interface ScribeWord {
  text: string;
  start: number;
  end: number;
  type?: 'word' | 'spacing' | 'audio_event' | string;
}

/** Turns the speech-to-text words into transcript words in file frames (spacing and sound events dropped). */
export function wordsFromScribe(words: ScribeWord[], sampleRate: number): TranscriptWord[] {
  const out: TranscriptWord[] = [];
  for (const w of words ?? []) {
    if ((w.type && w.type !== 'word') || !w.text?.trim()) continue;
    const start = Math.max(0, Math.round(w.start * sampleRate));
    out.push({ text: w.text.trim(), start, end: Math.max(start, Math.round(w.end * sampleRate)) });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The sound events (laughter, coughing, applause…) of the speech-to-text words, in file frames. */
export function eventsFromScribe(words: ScribeWord[], sampleRate: number): TranscriptWord[] {
  return (words ?? [])
    .filter((w) => w.type === 'audio_event' && w.end > w.start)
    .map((w) => ({ text: w.text?.trim() ?? '', start: Math.max(0, Math.round(w.start * sampleRate)), end: Math.round(w.end * sampleRate) }))
    .sort((a, b) => a.start - b.start);
}

/** The word without punctuation, lower case: what filler and search matching look at. */
export function bareWord(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}']+/gu, '')
    .replace(/^'+|'+$/g, '');
}

// "er" and "um" are real words in German, so they only count as fillers in English.
const FILLERS_ANY = /^(ä+h+m*|ö+h+m*|e+h+m+|ehm|h+m+|m+h+m+|u+h+m*|uhm+|e+r+m+|a+h+m+)$/;
const FILLERS_EN = /^(u+m+|e+r+|a+h+|e+h+)$/;
const FILLERS_DE = /^(e+h+|a+h+)$/;

/** True for hesitation sounds: äh, ähm, öhm, hm, uh, um, erm… (by transcript language). */
export function isFiller(text: string, language = ''): boolean {
  const w = bareWord(text);
  if (!w) return false;
  if (FILLERS_ANY.test(w)) return true;
  // Whisper-style "de"/"en" or ISO 639-3 "deu"/"eng"
  const lang = language.toLowerCase();
  if (lang.startsWith('en')) return FILLERS_EN.test(w);
  if (lang.startsWith('de')) return FILLERS_DE.test(w);
  return false;
}

/**
 * The transcript as it plays: every word of every track whose source still is on the timeline,
 * at its timeline position, sorted by time. Words muted by a cough region are flagged. With a
 * `filter`, crosstalk from other tracks and words below the level threshold are left out.
 */
export function timelineWords(
  project: Project,
  transcripts: ReadonlyMap<string, FileTranscript> | Record<string, FileTranscript>,
  filter?: WordFilter | null,
): TimelineWord[] {
  const all = allTimelineWords(project, transcripts);
  return filter ? filterQuietWords(project, transcripts, all, filter).words : all;
}

/** Every transcribed word on the timeline, crosstalk included. */
export function allTimelineWords(project: Project, transcripts: ReadonlyMap<string, FileTranscript> | Record<string, FileTranscript>): TimelineWord[] {
  const get = (file: string) => (transcripts instanceof Map ? transcripts.get(file) : (transcripts as Record<string, FileTranscript>)[file]);
  const out: TimelineWord[] = [];
  for (const track of project.tracks) {
    if (track.kind === 'soundboard') continue;
    for (const clip of track.clips) {
      const t = get(clip.file);
      // reversed, sped up or looped audio no longer lines up with the file's words
      if (!t?.words.length || clip.sound) continue;
      // file frames → project frames (files are recorded at the project rate, but imports may not be)
      const scale = project.sampleRate / (t.sampleRate || project.sampleRate);
      const from = clip.offset / scale;
      const to = (clip.offset + clip.length) / scale;
      const words = t.words;
      let i = lowerBound(words, from);
      for (; i < words.length && words[i].start < to; i++) {
        const w = words[i];
        const mid = (w.start + w.end) / 2;
        // a word belongs to the clip that holds most of it
        if (mid < from || mid >= to) continue;
        const start = clip.start + Math.round(w.start * scale) - clip.offset;
        const end = clip.start + Math.round(w.end * scale) - clip.offset;
        const muted = (track.muteRegions ?? []).some(([a, b]) => start >= a && end <= b);
        out.push({
          text: w.text,
          start: Math.max(clip.start, start),
          end: Math.min(clip.start + clip.length, Math.max(start, end)),
          trackId: track.id,
          clipId: clip.id,
          filler: isFiller(w.text, t.language),
          ...(muted ? { muted: true } : {}),
        });
      }
    }
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** First index whose word ends after `pos` (words are sorted by start, and don't overlap much). */
function lowerBound(words: TranscriptWord[], pos: number): number {
  let lo = 0;
  let hi = words.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].end <= pos) lo = mid + 1;
    else hi = mid;
  }
  // step back over long words that started earlier but still reach in
  while (lo > 0 && words[lo - 1].end > pos) lo--;
  return lo;
}

/** A run of words by one speaker, for showing the transcript as paragraphs. */
export interface TranscriptParagraph {
  trackId: string;
  start: Frames;
  /** Indices into the timeline word list. */
  words: number[];
}

/**
 * Groups timeline words into paragraphs: a new one starts when another track speaks, or after
 * a pause of `pauseSeconds`. Short interjections of another speaker inside a turn ("mhm") stay
 * in their own paragraph, so the order stays true to the recording.
 */
export function paragraphs(words: TimelineWord[], sampleRate: number, pauseSeconds = 2): TranscriptParagraph[] {
  const out: TranscriptParagraph[] = [];
  const gap = pauseSeconds * sampleRate;
  const lastEnd = new Map<string, number>();
  let cur: TranscriptParagraph | null = null;
  words.forEach((w, i) => {
    const prevEnd = lastEnd.get(w.trackId);
    if (!cur || cur.trackId !== w.trackId || (prevEnd !== undefined && w.start - prevEnd > gap)) {
      cur = { trackId: w.trackId, start: w.start, words: [] };
      out.push(cur);
    }
    cur.words.push(i);
    lastEnd.set(w.trackId, w.end);
  });
  return out;
}

/** Index of the word playing at `pos` (or the last one before it), -1 before the first. */
export function wordAt(words: TimelineWord[], pos: Frames): number {
  let lo = 0;
  let hi = words.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start <= pos) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** The time range a word selection covers: from the first word's start to the last word's end. */
export function wordsRange(words: TimelineWord[], from: number, to: number): [Frames, Frames] | null {
  const a = Math.max(0, Math.min(from, to));
  const b = Math.min(words.length - 1, Math.max(from, to));
  if (b < a) return null;
  let start = Infinity;
  let end = -Infinity;
  for (let i = a; i <= b; i++) {
    start = Math.min(start, words[i].start);
    end = Math.max(end, words[i].end);
  }
  return end > start ? [start, end] : null;
}

/** Plain text of the transcript with speaker names and times, for copying or saving. */
export function transcriptText(project: Project, words: TimelineWord[], withTimes = true): string {
  const names = new Map(project.tracks.map((t) => [t.id, t.name]));
  const fmt = (f: Frames) => {
    const s = Math.floor(f / project.sampleRate);
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    return `${hh ? `${hh}:` : ''}${String(mm).padStart(hh ? 2 : 1, '0')}:${String(ss).padStart(2, '0')}`;
  };
  return paragraphs(words, project.sampleRate)
    .map((p) => `${withTimes ? `[${fmt(p.start)}] ` : ''}${names.get(p.trackId) ?? ''}: ${p.words.map((i) => words[i].text).join(' ')}`)
    .join('\n\n');
}

/** WebVTT subtitles: cues of up to `maxWords` words / `maxSeconds`, one speaker each. */
export function transcriptVtt(project: Project, words: TimelineWord[], maxWords = 12, maxSeconds = 5): string {
  const names = new Map(project.tracks.map((t) => [t.id, t.name]));
  const sr = project.sampleRate;
  const ts = (f: Frames) => {
    const ms = Math.max(0, Math.round((f / sr) * 1000));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
  };
  const cues: string[] = [];
  for (const p of paragraphs(words, sr, 1)) {
    let chunk: number[] = [];
    const flush = () => {
      if (!chunk.length) return;
      const first = words[chunk[0]];
      const last = words[chunk[chunk.length - 1]];
      cues.push(`${ts(first.start)} --> ${ts(Math.max(last.end, first.start + sr / 2))}\n<v ${names.get(p.trackId) ?? ''}>${chunk.map((i) => words[i].text).join(' ')}`);
      chunk = [];
    };
    for (const i of p.words) {
      if (chunk.length && (chunk.length >= maxWords || words[i].end - words[chunk[0]].start > maxSeconds * sr)) flush();
      chunk.push(i);
      if (/[.!?…]$/.test(words[i].text) && chunk.length >= 4) flush();
    }
    flush();
  }
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

/** Files that need a transcript: the recorded/imported files of speech tracks that don't have one yet. */
export function filesToTranscribe(project: Project, have: (file: string) => boolean, trackIds?: string[]): Array<{ file: string; trackId: string }> {
  const seen = new Set<string>();
  const out: Array<{ file: string; trackId: string }> = [];
  for (const t of project.tracks) {
    if (t.kind === 'soundboard' || (trackIds && !trackIds.includes(t.id))) continue;
    for (const c of t.clips) {
      if (seen.has(c.file) || have(c.file)) continue;
      seen.add(c.file);
      out.push({ file: c.file, trackId: t.id });
    }
  }
  return out;
}

/** Where a file's transcript is stored inside the project folder. */
export function transcriptPath(file: string): string {
  const safe = file.replace(/[\\/:]+/g, '_').replace(/^_+/, '');
  return `transcripts/${safe}.json`;
}
