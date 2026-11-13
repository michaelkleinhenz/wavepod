// Where remote guests' uploads land: each take becomes one raw WAV (24-bit mono) in the episode's
// media folder, written chunk by chunk at its place in the file, so chunks may arrive late, twice
// or out of order (a reconnect, a reloaded page). The state lives in remote-takes.json next to
// project.json, so a crash of the host loses nothing: the guest still holds every chunk until the
// host says the take is complete, and sends what is missing when it comes back.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BYTES_PER_SAMPLE, type ChunkHeader } from '../../shared/remoteProtocol';
import { addReceived, chunkFrames, chunkOffset, contiguousUpTo, isComplete, missingChunks, normalizeRemoteTakes, type RemoteTake } from '../../core/remoteTakes';
import { readJsonSafely, writeJsonSafely } from '../../core/safeJson';

const STATE_FILE = 'remote-takes.json';
/** Data written but not yet synced to disk is flushed this often (ms). */
const SYNC_MS = 2000;

export class RemoteInbox {
  private takes: RemoteTake[] = [];
  private handles = new Map<string, Promise<fs.promises.FileHandle>>();
  /** Writes per take run one after another. */
  private queues = new Map<string, Promise<void>>();
  private dirty = new Set<string>();
  private syncTimer: NodeJS.Timeout | null = null;

  constructor(private readonly dir: string) {
    try {
      this.takes = normalizeRemoteTakes(readJsonSafely(path.join(dir, STATE_FILE)).data);
    } catch {
      this.takes = [];
    }
  }

  list(): RemoteTake[] {
    return this.takes.map((t) => ({ ...t, received: [...t.received] }));
  }

  get(guestId: string, takeId: string): RemoteTake | undefined {
    return this.takes.find((t) => t.guestId === guestId && t.takeId === takeId);
  }

  /** Takes of a guest that still need audio. */
  pending(guestId: string): RemoteTake[] {
    return this.takes.filter((t) => t.guestId === guestId && (t.state === 'recording' || t.state === 'uploading'));
  }

  private key = (t: Pick<RemoteTake, 'guestId' | 'takeId'>) => `${t.guestId}/${t.takeId}`;

  /** A guest started recording a take: makes its file. Returns the take (existing or new). */
  begin(init: Omit<RemoteTake, 'received' | 'chunks' | 'frames' | 'state' | 'file'> & { trackName: string }): RemoteTake {
    const had = this.get(init.guestId, init.takeId);
    if (had) return had;
    const base = `${init.trackName.replace(/[^\w.-]+/g, '_').slice(0, 40) || 'guest'}-remote-${init.takeId}`;
    let file = `media/${base}.wav`;
    for (let i = 2; fs.existsSync(path.join(this.dir, file)); i++) file = `media/${base}-${i}.wav`;
    const { trackName: _, ...rest } = init;
    const take: RemoteTake = { ...rest, file, received: [], chunks: null, frames: null, state: 'recording' };
    fs.mkdirSync(path.join(this.dir, 'media'), { recursive: true });
    fs.writeFileSync(path.join(this.dir, file), wavHeader(0, take.sampleRate));
    this.takes.push(take);
    this.save();
    return take;
  }

  /**
   * Writes one chunk where it belongs. Resolves with the take as it is now, or null when the chunk
   * doesn't belong to a known take (or doesn't fit it).
   */
  chunk(guestId: string, h: ChunkHeader, pcm: Uint8Array): Promise<RemoteTake | null> {
    const take = this.get(guestId, h.takeId);
    if (!take || take.state === 'complete' || take.state === 'placed') return Promise.resolve(take ?? null);
    if (h.sampleRate !== take.sampleRate || pcm.length !== h.frames * BYTES_PER_SAMPLE || h.frames > chunkFrames(take.sampleRate) || (take.chunks !== null && h.seq >= take.chunks)) return Promise.resolve(null);
    const k = this.key(take);
    const job = (this.queues.get(k) ?? Promise.resolve()).then(async () => {
      const fh = await this.handle(take);
      await fh.write(pcm, 0, pcm.length, chunkOffset(h.seq, take.sampleRate));
      take.received = addReceived(take.received, h.seq);
      if (take.state === 'recording' && take.chunks !== null) take.state = 'uploading';
      this.dirty.add(k);
      this.scheduleSync();
    });
    this.queues.set(
      k,
      job.catch(() => {}),
    );
    return job.then(() => take);
  }

  /** The guest says the take ended with `chunks` chunks and `frames` samples. */
  finished(guestId: string, takeId: string, chunks: number, frames: number): RemoteTake | null {
    const take = this.get(guestId, takeId);
    if (!take) return null;
    if (take.chunks === null) {
      take.chunks = Math.max(0, Math.floor(chunks));
      take.frames = Math.max(0, Math.floor(frames));
      take.received = take.received.filter((n) => n < take.chunks!);
      if (take.state === 'recording') take.state = 'uploading';
      this.save();
    }
    return take;
  }

  /** Contiguous chunks on disk (for the guest's ack). */
  ackOf(take: RemoteTake): number {
    return contiguousUpTo(take.received);
  }

  missing(take: RemoteTake): number[] {
    return missingChunks(take);
  }

  /**
   * Completes a take once every chunk is on disk: fixes the WAV header and syncs. True when the
   * take is (now) complete.
   */
  async complete(take: RemoteTake): Promise<boolean> {
    if (take.state === 'complete' || take.state === 'placed') return true;
    if (!isComplete(take)) return false;
    const k = this.key(take);
    await (this.queues.get(k) ?? Promise.resolve());
    const fh = await this.handle(take);
    const frames = take.frames ?? take.received.length * chunkFrames(take.sampleRate);
    await fh.write(wavHeader(frames, take.sampleRate), 0, 44, 0);
    await fh.truncate(44 + frames * BYTES_PER_SAMPLE);
    await fh.sync();
    await fh.close();
    this.handles.delete(k);
    take.state = 'complete';
    this.save();
    return true;
  }

  update(take: RemoteTake, patch: Partial<RemoteTake>): void {
    Object.assign(take, patch);
    this.save();
  }

  private handle(take: RemoteTake): Promise<fs.promises.FileHandle> {
    const k = this.key(take);
    let h = this.handles.get(k);
    if (!h) {
      h = fs.promises.open(path.join(this.dir, take.file), 'r+');
      this.handles.set(k, h);
      h.catch(() => this.handles.delete(k));
    }
    return h;
  }

  private scheduleSync(): void {
    if (this.syncTimer) return;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      void this.sync();
    }, SYNC_MS);
    this.syncTimer.unref?.();
  }

  /** Syncs written chunks and patches the headers so a crash leaves playable files. */
  async sync(): Promise<void> {
    const keys = [...this.dirty];
    this.dirty.clear();
    for (const k of keys) {
      const take = this.takes.find((t) => this.key(t) === k);
      const h = this.handles.get(k);
      if (!take || !h) continue;
      try {
        await (this.queues.get(k) ?? Promise.resolve());
        const fh = await h;
        const frames = (contiguousUpTo(take.received) + 1) * chunkFrames(take.sampleRate);
        await fh.write(wavHeader(frames, take.sampleRate), 0, 44, 0);
        await fh.datasync();
      } catch {
        /* the next chunk tries again */
      }
    }
    this.save();
  }

  private save(): void {
    try {
      writeJsonSafely(path.join(this.dir, STATE_FILE), { version: 1, takes: this.takes });
    } catch (e) {
      console.error(`[remote] could not save ${STATE_FILE}: ${(e as Error).message}`);
    }
  }

  async close(): Promise<void> {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = null;
    await this.sync();
    for (const h of this.handles.values()) {
      try {
        await (await h).close();
      } catch {
        /* already closed */
      }
    }
    this.handles.clear();
  }
}

/** A 44-byte header of a 24-bit mono PCM WAV with `frames` samples. */
export function wavHeader(frames: number, sampleRate: number): Uint8Array {
  const b = Buffer.alloc(44);
  const data = frames * BYTES_PER_SAMPLE;
  b.write('RIFF', 0);
  b.writeUInt32LE(Math.min(0xffffffff, 36 + data), 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * BYTES_PER_SAMPLE, 28);
  b.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  b.writeUInt16LE(24, 34);
  b.write('data', 36);
  b.writeUInt32LE(Math.min(0xffffffff, data), 40);
  return new Uint8Array(b);
}
