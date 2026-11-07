// The recording journal: a small file in the project folder, written when a take starts,
// that says which files are being recorded for which tracks. A clean stop removes it after
// the project is saved. If it is still there when the project is opened, the app (or the
// computer) went down mid-take: the files are repaired and put on their tracks.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BitDepth, Project, RecordedTake, RecordingEvent } from '../shared/types';
import { addClip, addMarker, addTrack } from './project';
import { repairWav, syncDir, syncFd } from './wav';
import { uid } from '../shared/time';
import { SOUNDBOARD_TRACK_ID, ensureSoundboardTrack } from './soundboard';
import { loopFramePosition, loopTakeClips, pickTake, recordTakes } from './takes';
import { mergePunchTake, punchTakeClip } from './punch';

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
  /** Loop recording: the range the timeline jumped round in; each pass becomes a take. */
  loop?: [number, number];
  /** The process recording the take and its computer, so another WavePod leaves a running take alone. */
  owner?: JournalOwner;
}

export interface JournalOwner {
  pid: number;
  host: string;
}

/** Who is writing a journal: this process on this computer. */
export function journalOwner(): JournalOwner {
  return { pid: process.pid, host: os.hostname() };
}

export interface OwnerCheck {
  pid: number;
  host: string;
  /** Milliseconds since the epoch. */
  now: number;
  /** Seconds since this computer started. */
  uptime: number;
  alive(pid: number): boolean;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const OWNER_CHECK: () => OwnerCheck = () => ({ pid: process.pid, host: os.hostname(), now: Date.now(), uptime: os.uptime(), alive: processAlive });

/**
 * True while the take of `j` is still being recorded by another WavePod on this computer. Its
 * files are open and growing then, so they must not be repaired or put on the timeline, and the
 * journal must stay. A journal from before the last restart, or one whose process is gone, belongs
 * to a take that was interrupted.
 */
export function journalOwnerRunning(j: RecordingJournal, check: OwnerCheck = OWNER_CHECK()): boolean {
  const o = j.owner;
  if (!o || typeof o.pid !== 'number' || o.pid === check.pid || o.host !== check.host) return false;
  // the computer restarted since: the number may belong to another program by now
  const started = Date.parse(j.startedAt);
  if (!Number.isFinite(started) || started < check.now - check.uptime * 1000) return false;
  return check.alive(o.pid);
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

/**
 * Puts a finished recording on the timeline: each track's take (one per pass when loop recording)
 * goes onto its track, stacked as takes over anything recorded there before; jingles become clips on
 * the Soundboard track; problems found while recording become edit markers.
 */
export function mergeRecording(
  project: Project,
  takes: RecordedTake[],
  info: { recordStart: number; events: RecordingEvent[]; loop?: [number, number] },
  sampleRate: number,
): Project {
  let p = project;
  if (takes.some((t) => t.trackId === SOUNDBOARD_TRACK_ID)) p = ensureSoundboardTrack(p);
  for (const t of takes) {
    if (t.trackId === SOUNDBOARD_TRACK_ID) p = addClip(p, t.trackId, t.clip);
    // a punch-in take replaces its range, keeping what was there as a take
    else if (t.punch) p = mergePunchTake(p, t.trackId, t.clip, t.punch);
    else if (!info.loop) p = recordTakes(p, t.trackId, [t.clip]);
    else {
      const passes = loopTakeClips(t.clip, info.loop, sampleRate);
      p = recordTakes(p, t.trackId, passes);
      // a last pass cut short by Stop is kept as a take, but the last whole pass plays
      const takes = p.tracks.find((x) => x.id === t.trackId)?.takes ?? [];
      if (passes.length > 1 && passes[passes.length - 1].length < info.loop[1] - info.loop[0] && takes.length > 1) {
        p = pickTake(p, t.trackId, [...takes].sort((a, b) => a.n - b.n)[takes.length - 2].id);
      }
    }
  }
  if (info.events.length) {
    // in a loop recording, a problem goes where the pass was on the timeline
    const events = info.loop
      ? info.events.map((e) => ({
          ...e,
          frame: loopFramePosition(e.frame, info.recordStart, info.loop!) - info.recordStart,
          ...(e.lastFrame !== undefined ? { lastFrame: loopFramePosition(e.lastFrame, info.recordStart, info.loop!) - info.recordStart } : {}),
        }))
      : info.events;
    p = addProblemMarkers(p, info.recordStart, events);
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
 * Leaves the journal in place; clear it once the returned project is saved. Returns null without
 * touching anything while another WavePod is still recording that take (see journalOwnerRunning).
 */
export function recoverRecording(dir: string, project: Project, check?: OwnerCheck): Recovery | null {
  const j = readJournal(dir);
  if (!j || journalOwnerRunning(j, check)) return null;
  let p = project;
  const has = (file: string) => p.tracks.some((t) => t.clips.some((c) => c.file === file) || !!t.takes?.some((tk) => tk.clips.some((c) => c.file === file)));
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
    const clip = { id: uid('clp'), file: t.file, start: j.recordStart, offset: 0, length: frames, gain: 0, fadeIn: 0, fadeOut: 0 };
    if (j.punch) {
      // a punch pass: only its range goes back, as a take over what was there
      const placed = punchTakeClip({ file: t.file, recordStart: j.recordStart, frames }, { in: j.punch[0], out: j.punch[1] }, j.sampleRate);
      if (!placed) continue;
      p = mergeRecording(p, [{ trackId, clip: placed.clip, punch: placed.range }], { recordStart: j.recordStart, events: [] }, j.sampleRate);
    } else {
      p = mergeRecording(p, [{ trackId, clip }], { recordStart: j.recordStart, events: [], loop: j.loop }, j.sampleRate);
    }
    takes++;
    longest = Math.max(longest, frames / j.sampleRate);
  }
  for (const jt of j.jingles) {
    if (has(jt.clip.file) && p.tracks.some((t) => t.clips.some((c) => c.file === jt.clip.file && c.start === jt.clip.start))) continue;
    if (jt.trackId === SOUNDBOARD_TRACK_ID) p = ensureSoundboardTrack(p);
    p = addClip(p, jt.trackId, { ...jt.clip, id: uid('clp') });
  }
  if (takes > 0) p = mergeRecording(p, [], { recordStart: j.recordStart, events: j.events, loop: j.loop }, j.sampleRate);
  return { project: p, takes, seconds: longest, startedAt: j.startedAt, missing };
}
