// The recording journal: a small file in the project folder, written when a take starts,
// that says which files are being recorded for which tracks. A clean stop removes it after
// the project is saved. If it is still there when the project is opened, the app (or the
// computer) went down mid-take: the files are repaired and put on their tracks.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BitDepth, Project, RecordedTake, RecordingEvent } from '../shared/types';
import { addClip, addMarker, addTrack } from './project';
import { repairWav, syncDir, syncFd } from './wav';
import { uid } from '../shared/time';
import { SOUNDBOARD_TRACK_ID, ensureSoundboardTrack } from './soundboard';
import { punchInClip, punchTakeClip } from './punch';

export const JOURNAL_FILE = 'recording-in-progress.json';

export interface JournalTake {
  trackId: string;
  trackName: string;
  /** Project-relative path of the WAV file. */
  file: string;
  channels: number[];
}

export interface RecordingJournal {
  version: 1;
  startedAt: string;
  sampleRate: number;
  bitDepth: BitDepth;
  /** Timeline position where the take starts. */
  recordStart: number;
  /** Punch-in pass: only [in, out) of the takes replaces the audio on their tracks. */
  punch?: [number, number];
  takes: JournalTake[];
  /** Jingles of the take that already finished playing. */
  jingles: RecordedTake[];
  /** Problems found so far. */
  events: RecordingEvent[];
}

/** Writes the journal so that it survives a crash or power cut (temp file, fsync, rename). */
export function writeJournal(dir: string, journal: RecordingJournal): void {
  const file = path.join(dir, JOURNAL_FILE);
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(journal, null, 2));
    syncFd(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  syncDir(dir);
}

export function readJournal(dir: string): RecordingJournal | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, JOURNAL_FILE), 'utf8')) as RecordingJournal;
    if (j?.version !== 1 || !Array.isArray(j.takes)) return null;
    return { ...j, jingles: j.jingles ?? [], events: j.events ?? [] };
  } catch {
    return null;
  }
}

export function clearJournal(dir: string): void {
  fs.rmSync(path.join(dir, JOURNAL_FILE), { force: true });
  fs.rmSync(path.join(dir, `${JOURNAL_FILE}.tmp`), { force: true });
}

/** Adds an edit marker for each problem found in a take. */
export function addProblemMarkers(project: Project, recordStart: number, events: RecordingEvent[]): Project {
  let p = project;
  for (const e of events) {
    const n = e.count ?? 1;
    const title = `⚠ ${e.text}${n > 1 && e.kind !== 'dropout' ? ` (${n}×)` : ''}`;
    // don't add the same marker twice (recovery after a save that already had it)
    if (p.markers.some((m) => m.kind === 'edit' && m.title === title && m.position === recordStart + e.frame)) continue;
    p = addMarker(p, recordStart + e.frame, 'edit', title).project;
  }
  return p;
}

export interface Recovery {
  project: Project;
  /** Takes put back on the timeline. */
  takes: number;
  /** Length of the longest recovered take, in seconds. */
  seconds: number;
  startedAt: string;
  /** Files the journal names that are gone or unreadable. */
  missing: string[];
}

/**
 * Recovers the take a crash interrupted, if the project folder has a journal.
 * Takes already in the project (the crash came after saving) are only repaired.
 * Leaves the journal in place; clear it once the returned project is saved.
 */
export function recoverRecording(dir: string, project: Project): Recovery | null {
  const j = readJournal(dir);
  if (!j) return null;
  let p = project;
  const has = (file: string) => p.tracks.some((t) => t.clips.some((c) => c.file === file));
  let takes = 0;
  let longest = 0;
  const missing: string[] = [];
  for (const t of j.takes) {
    let frames = 0;
    try {
      frames = repairWav(path.join(dir, t.file)).frames;
    } catch {
      missing.push(t.file);
      continue;
    }
    if (frames <= 0 || has(t.file)) continue;
    let trackId = t.trackId;
    if (!p.tracks.some((x) => x.id === trackId)) {
      p = addTrack(p, { name: `${t.trackName} (recovered)`, inputChannels: t.channels });
      trackId = p.tracks[p.tracks.length - 1].id;
    }
    if (j.punch) {
      const placed = punchTakeClip({ file: t.file, recordStart: j.recordStart, frames }, { in: j.punch[0], out: j.punch[1] }, j.sampleRate);
      if (!placed) continue;
      p = punchInClip(p, trackId, placed.clip, placed.range);
    } else {
      p = addClip(p, trackId, { id: uid('clp'), file: t.file, start: j.recordStart, offset: 0, length: frames, gain: 0, fadeIn: 0, fadeOut: 0 });
    }
    takes++;
    longest = Math.max(longest, frames / j.sampleRate);
  }
  for (const jt of j.jingles) {
    if (has(jt.clip.file) && p.tracks.some((t) => t.clips.some((c) => c.file === jt.clip.file && c.start === jt.clip.start))) continue;
    if (jt.trackId === SOUNDBOARD_TRACK_ID) p = ensureSoundboardTrack(p);
    p = addClip(p, jt.trackId, { ...jt.clip, id: uid('clp') });
  }
  if (takes > 0) p = addProblemMarkers(p, j.recordStart, j.events);
  return { project: p, takes, seconds: longest, startedAt: j.startedAt, missing };
}
