// Retakes and false starts in the transcript: a speaker starts a sentence, breaks off (or finishes
// it badly) and says it again. The earlier attempt is cut, so the last one stays.
import type { CleanupItem, Frames, TimelineWord } from '../shared/types';

/** The repeated start must be at least this many words long… */
export const RETAKE_MIN_WORDS = 3;
/** …or this many when the first attempt broke off right after them (a false start: "I think— I think that"). */
export const FALSE_START_MIN_WORDS = 2;
/** When the first attempt was a finished sentence, the next must repeat this many words to count. */
export const COMPLETE_MIN_WORDS = 5;
/** The new attempt starts at most this long after the first one (seconds). */
export const RETAKE_MAX_SPAN = 20;
/** A sentence starts after a pause this long (seconds), or after another speaker. */
const SENTENCE_GAP = 0.25;
/** A false start breaks off with a pause at least this long before the new attempt (seconds). */
const BREAK_GAP = 0.15;
/** Another speaker may say this many words in between (a "mhm"); more and it's a conversation. */
const MAX_OTHER_WORDS = 2;

/** A word reduced for comparing: lower case, without punctuation. */
export function normWord(text: string): string {
  return text
    .toLocaleLowerCase()
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}']+/gu, '')
    .replace(/^'+|'+$/g, '');
}

/** Same word, allowing a slip in a longer word (speech-to-text may spell one take differently). */
export function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 5 || b.length < 5) return false;
  return editDistance(a, b) <= Math.floor(Math.max(a.length, b.length) / 5);
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

interface Spoken {
  word: TimelineWord;
  norm: string;
  /** Index in the full word list (all speakers). */
  at: number;
}

const ends = (text: string) => /[.!?…]["»”)]*$/.test(text.trim());

/**
 * Finds retakes: a speaker's sentence start that the same speaker says again within
 * RETAKE_MAX_SPAN seconds, with nobody else talking in between. Each find cuts from the start of
 * the first attempt to the start of the last one, on all tracks, so the gap closes. Three tries
 * at one sentence give one cut that keeps the third.
 */
export function findRetakes(words: TimelineWord[], sampleRate: number): CleanupItem[] {
  const all = [...words].filter((w) => !w.muted).sort((a, b) => a.start - b.start);
  const maxSpan = RETAKE_MAX_SPAN * sampleRate;
  const byTrack = new Map<string, Spoken[]>();
  all.forEach((w, at) => {
    if (w.filler) return;
    const norm = normWord(w.text);
    if (!norm) return;
    const list = byTrack.get(w.trackId) ?? [];
    list.push({ word: w, norm, at });
    byTrack.set(w.trackId, list);
  });

  const items: CleanupItem[] = [];
  for (const [trackId, list] of byTrack) {
    // where a sentence may start: after a pause, after another speaker, or after a full stop
    const startsSentence = (i: number): boolean => {
      if (i === 0) return true;
      const prev = list[i - 1];
      const w = list[i].word;
      if (w.start - prev.word.end >= SENTENCE_GAP * sampleRate) return true;
      if (ends(prev.word.text)) return true;
      // someone else spoke since this speaker's last word
      return all.slice(prev.at + 1, list[i].at).some((x) => x.trackId !== trackId && !x.filler);
    };
    let i = 0;
    while (i < list.length) {
      if (!startsSentence(i)) {
        i++;
        continue;
      }
      // the latest later attempt that repeats this start; then look again from there
      let last = -1;
      let lastMatched = 0;
      for (let j = i + 1; j < list.length && list[j].word.start - list[i].word.start <= maxSpan; j++) {
        if (!startsSentence(j)) continue;
        if (othersBetween(all, trackId, list[i].at, list[j].at) > MAX_OTHER_WORDS) break;
        const matched = matchLength(list, i, j);
        // a finished sentence followed by another that merely starts alike is speech, not a retake
        const finished = ends(list[j - 1].word.text) && j - i > matched;
        const need = finished ? COMPLETE_MIN_WORDS : RETAKE_MIN_WORDS;
        if (matched >= need || (matched >= FALSE_START_MIN_WORDS && brokeOff(list, i, j, matched, sampleRate))) {
          last = j;
          lastMatched = matched;
        }
      }
      if (last < 0) {
        i++;
        continue;
      }
      const first = list[i].word;
      const kept = list[last].word;
      const dropped = list.slice(i, last).map((s) => s.word.text.trim());
      items.push({
        id: `retake-${trackId}-${first.start}`,
        kind: 'retake',
        start: first.start,
        end: kept.start,
        trackId,
        text: shorten(dropped),
        kept: list.slice(last, last + Math.max(lastMatched + 2, 5)).map((s) => s.word.text.trim()).join(' '),
        action: 'cut',
      });
      i = last;
    }
  }
  return items.sort((a, b) => a.start - b.start);
}

/** Words that two attempts starting at list[i] and list[j] have in common from their start. */
function matchLength(list: Spoken[], i: number, j: number): number {
  let n = 0;
  while (i + n < j && j + n < list.length && sameWord(list[i + n].norm, list[j + n].norm)) n++;
  return n;
}

/** The first attempt stopped right after the shared words: nothing more of it before the new attempt but a pause. */
function brokeOff(list: Spoken[], i: number, j: number, matched: number, sampleRate: number): boolean {
  // at most one more (cut-off) word before the new attempt
  if (j - i > matched + 1) return false;
  return list[j].word.start - list[j - 1].word.end >= BREAK_GAP * sampleRate;
}

/** Words of other speakers (not hesitations) between two words of the list. */
function othersBetween(all: TimelineWord[], trackId: string, from: number, to: number): number {
  let n = 0;
  for (let k = from + 1; k < to; k++) if (all[k].trackId !== trackId && !all[k].filler) n++;
  return n;
}

function shorten(words: string[], max = 14): string {
  return words.length <= max ? words.join(' ') : `${words.slice(0, max - 4).join(' ')} … ${words.slice(-3).join(' ')}`;
}

/** The retake cuts are placed between words: start a little before the first attempt, end just before the kept one. */
export const RETAKE_REACH_SECONDS = 0.12;

/** The range refineCut() should search for a retake, so the end lands before the kept attempt's first word. */
export function retakeSearchRange(item: Pick<CleanupItem, 'start' | 'end'>, sampleRate: number): [Frames, Frames] {
  // refineCut lets the end move up to its reach later: start the search that much earlier
  return [item.start, Math.max(item.start + 1, item.end - Math.round(RETAKE_REACH_SECONDS * sampleRate))];
}
