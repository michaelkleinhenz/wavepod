// Remote guests' uploaded recordings: which chunks of a take are on disk, what is missing, and
// where the finished file goes on the timeline. Pure functions; the main process does the I/O.
import type { Clip, Project } from '../shared/types';
import { CHUNK_SECONDS } from '../shared/remoteProtocol';
import { recordTake } from './takes';
import { uid } from '../shared/time';

export type RemoteTakeState = 'recording' | 'uploading' | 'complete' | 'placed';

/** One guest's raw recording of one take, as the host keeps track of it (remote-takes.json). */
export interface RemoteTake {
  guestId: string;
  trackId: string;
  takeId: string;
  /** Project-relative path of the raw WAV (24-bit mono). */
  file: string;
  sampleRate: number;
  /** Timeline frame where the host's take started. */
  recordStart: number;
  /** Frames the guest recorded before it got the start message (its pre-roll). */
  preRoll: number;
  /** Chunk numbers on disk, sorted. */
  received: number[];
  /** Number of chunks and samples in all, once the guest has finished the take. */
  chunks: number | null;
  frames: number | null;
  /** Round trip host → guest → host (ms) measured around the take; null if unknown. */
  rttMs: number | null;
  state: RemoteTakeState;
  /** Clip ids of the call audio of this take on the guest's track (the alignment reference). */
  callClipIds?: string[];
  /** The clip made from this take once placed. */
  clipId?: string;
  /** What happened when it was placed (alignment), for the guest list. */
  note?: string;
}

export const chunkFrames = (sampleRate: number) => Math.round(sampleRate * CHUNK_SECONDS);

/** Adds a chunk number (kept sorted, no duplicates). */
export function addReceived(received: number[], seq: number): number[] {
  if (received.includes(seq)) return received;
  const out = [...received, seq];
  out.sort((a, b) => a - b);
  return out;
}

/** Highest n such that chunks 0..n are all there (-1 for none). */
export function contiguousUpTo(received: number[]): number {
  let n = -1;
  for (const s of received) {
    if (s === n + 1) n = s;
    else if (s > n + 1) break;
  }
  return n;
}

/** Chunks still missing: below the highest one received, or below `chunks` once that is known. */
export function missingChunks(take: Pick<RemoteTake, 'received' | 'chunks'>): number[] {
  const have = new Set(take.received);
  const until = take.chunks ?? (take.received.length ? take.received[take.received.length - 1] + 1 : 0);
  const out: number[] = [];
  for (let i = 0; i < until; i++) if (!have.has(i)) out.push(i);
  return out;
}

export function isComplete(take: Pick<RemoteTake, 'received' | 'chunks'>): boolean {
  return take.chunks !== null && missingChunks(take).length === 0 && take.received.length === take.chunks;
}

/** Byte offset of a chunk's samples in the WAV file (after a 44-byte header). */
export function chunkOffset(seq: number, sampleRate: number, bytesPerSample = 3): number {
  return 44 + seq * chunkFrames(sampleRate) * bytesPerSample;
}

/** Guessed round trip when none was measured (seconds). */
export const DEFAULT_RTT_SECONDS = 0.2;

/**
 * Where the raw recording lands before the content alignment: the guest got the start message
 * half a round trip after the host started, and the host heard what they said half a round trip
 * after they said it. The clip starts at the host's take start; the pre-roll stays as a handle.
 */
export function initialClip(take: RemoteTake, projectRate: number): Clip {
  const frames = take.frames ?? take.received.length * chunkFrames(take.sampleRate);
  const rtt = (take.rttMs ?? DEFAULT_RTT_SECONDS * 1000) / 1000;
  // timeline frame of the first sample in the file
  const fileStart = take.recordStart + Math.round(rtt * projectRate) - take.preRoll;
  const offset = Math.max(0, Math.min(frames, take.recordStart - fileStart));
  return {
    id: uid('clp'),
    file: take.file,
    start: fileStart + offset,
    offset,
    length: Math.max(0, frames - offset),
    gain: 0,
    fadeIn: 0,
    fadeOut: 0,
  };
}

/**
 * Puts a finished raw take on the guest's track as a new take that plays; the call audio it
 * replaces stays as an earlier take, one click away.
 */
export function placeRemoteTake(project: Project, take: RemoteTake, at?: Clip): { project: Project; clip: Clip } | null {
  const t = project.tracks.find((x) => x.id === take.trackId);
  if (!t) return null;
  const clip = at ?? initialClip(take, project.sampleRate);
  if (clip.length <= 0) return null;
  return { project: recordTake(project, take.trackId, clip), clip };
}

/**
 * The call audio a guest's recording lines up with: what the guest's track recorded over
 * `from`..`to`, on the timeline or in a take lane. Only the one recording that covers most of the
 * stretch counts (an earlier pass over the same stretch would be different words).
 */
export function callClipsOf(project: Project, trackId: string, from: number, to: number): Clip[] {
  const t = project.tracks.find((x) => x.id === trackId);
  if (!t) return [];
  const seen = new Set<string>();
  const all = [...t.clips, ...(t.takes ?? []).flatMap((tk) => tk.clips)].filter((c) => {
    const key = `${c.file}:${c.start}:${c.offset}:${c.length}`;
    if (seen.has(key) || c.sound || /-remote-[\w-]+\.wav$/.test(c.file) || c.start >= to || c.start + c.length <= from) return false;
    seen.add(key);
    return true;
  });
  const cover = new Map<string, number>();
  for (const c of all) cover.set(c.file, (cover.get(c.file) ?? 0) + Math.min(to, c.start + c.length) - Math.max(from, c.start));
  const best = [...cover.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return all.filter((c) => c.file === best).sort((a, b) => a.start - b.start);
}

/** Reads remote-takes.json leniently: unknown or broken entries are left out. */
export function normalizeRemoteTakes(raw: unknown): RemoteTake[] {
  const list = (raw && typeof raw === 'object' && Array.isArray((raw as { takes?: unknown }).takes) ? (raw as { takes: unknown[] }).takes : []) as Partial<RemoteTake>[];
  const ok = (v: unknown) => typeof v === 'string' && /^[\w-]{1,64}$/.test(v);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return list
    .filter((t) => t && ok(t.guestId) && ok(t.takeId) && typeof t.trackId === 'string' && typeof t.file === 'string' && /^media\/[^/\\]+\.wav$/.test(t.file))
    .map((t) => ({
      guestId: t.guestId!,
      trackId: t.trackId!,
      takeId: t.takeId!,
      file: t.file!,
      sampleRate: num(t.sampleRate) ?? 48000,
      recordStart: Math.max(0, num(t.recordStart) ?? 0),
      preRoll: Math.max(0, num(t.preRoll) ?? 0),
      received: Array.isArray(t.received) ? [...new Set(t.received.filter((s) => Number.isInteger(s) && s >= 0))].sort((a, b) => a - b) : [],
      chunks: num(t.chunks),
      frames: num(t.frames),
      rttMs: num(t.rttMs),
      state: t.state === 'uploading' || t.state === 'complete' || t.state === 'placed' ? t.state : 'recording',
      ...(Array.isArray(t.callClipIds) ? { callClipIds: t.callClipIds.filter((x) => typeof x === 'string') } : {}),
      ...(typeof t.clipId === 'string' ? { clipId: t.clipId } : {}),
      ...(typeof t.note === 'string' ? { note: t.note } : {}),
    }));
}
