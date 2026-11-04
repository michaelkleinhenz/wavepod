// Writes the WAV files of one recording from the device's interleaved input.
// Used by the recording worker thread (and in-process when there is no worker).
//
// Safety rules: every buffer goes to the operating system right away (so it
// survives the app crashing), headers are patched about once a second (so a
// file stays playable), and everything is forced to the disk every couple of
// seconds (so it survives a power cut). Audio that can't be written because the
// disk is full is held in memory and written as soon as there is room again.
import * as path from 'node:path';
import type { BitDepth } from '../shared/types';
import { WavWriter, syncDir, type WavWriterOptions } from './wav';

export interface TakeFileSpec {
  /** Absolute path of the WAV file to create. */
  path: string;
  /** Device input channels that go into the file, in order. */
  channels: number[];
}

export interface TakeFilesOptions {
  sampleRate: number;
  bitDepth: BitDepth;
  /** Channels per frame of the device buffers passed to write(). */
  deviceChannels: number;
  /** How often everything is forced to the disk. */
  syncIntervalMs?: number;
  /** While the disk refuses writes: how long to wait between tries. */
  retryMs?: number;
  /** Audio held in memory while the disk refuses writes, before giving up on newer audio. */
  maxQueuedBytes?: number;
  /** Continue existing files (after the recording worker died) instead of creating them. */
  append?: boolean;
  /** For tests. */
  writeSync?: WavWriterOptions['writeSync'];
  now?: () => number;
}

export interface TakeFilesStatus {
  /** Bytes accepted but not yet on disk. */
  queuedBytes: number;
  /** Frames of the shortest file that reached the disk. */
  framesOnDisk: number;
  /** Frames dropped because memory for queued audio ran out. */
  droppedFrames: number;
  /** Last write error, cleared when writing works again. */
  error: string | null;
  /** When everything was last forced to disk (ms, from `now`). */
  lastSync: number;
}

export const DEFAULT_SYNC_MS = 2000;
const DEFAULT_RETRY_MS = 1000;
const DEFAULT_MAX_QUEUED = 1 << 30;

export function describeWriteError(e: unknown): string {
  const err = e as NodeJS.ErrnoException;
  if (err?.code === 'ENOSPC') return 'The disk is full';
  if (err?.code === 'EDQUOT') return 'The disk quota is used up';
  if (err?.code === 'EIO') return 'The disk reported an input/output error';
  if (err?.code === 'EROFS') return 'The disk is read-only';
  return err?.message ?? String(e);
}

export class TakeFiles {
  private writers: WavWriter[];
  private scratch: Float32Array[][];
  private opts: Required<Omit<TakeFilesOptions, 'writeSync' | 'append'>> & Pick<TakeFilesOptions, 'writeSync' | 'append'>;
  private error: string | null = null;
  private nextTry = 0;
  private lastSync: number;
  private dropped = 0;
  private closed = false;

  constructor(readonly specs: TakeFileSpec[], opts: TakeFilesOptions) {
    this.opts = {
      syncIntervalMs: DEFAULT_SYNC_MS,
      retryMs: DEFAULT_RETRY_MS,
      maxQueuedBytes: DEFAULT_MAX_QUEUED,
      now: () => Date.now(),
      ...opts,
    };
    const created: WavWriter[] = [];
    try {
      for (const s of specs) {
        created.push(
          new WavWriter(s.path, s.channels.length, opts.sampleRate, opts.bitDepth, Infinity, 0, {
            rf64: true,
            append: opts.append,
            writeSync: opts.writeSync,
          }),
        );
      }
    } catch (e) {
      for (const w of created) w.abandon();
      throw e;
    }
    this.writers = created;
    this.scratch = specs.map((s) => s.channels.map(() => new Float32Array(0)));
    // the new files' directory entries must survive a power cut too
    for (const dir of new Set(specs.map((s) => path.dirname(s.path)))) syncDir(dir);
    for (const w of this.writers) w.sync();
    this.lastSync = this.opts.now();
  }

  private get queued(): number {
    return this.writers.reduce((n, w) => n + w.queuedBytes, 0);
  }

  /** Adds one device buffer (interleaved, `deviceChannels` per frame) to every file. */
  write(interleaved: Float32Array, frames = Math.floor(interleaved.length / this.opts.deviceChannels)): void {
    if (this.closed || frames <= 0) return;
    if (this.error && this.queued >= this.opts.maxQueuedBytes) {
      // Memory for held audio is used up: keep what is held, lose what comes now.
      this.dropped += frames;
      return;
    }
    const nch = this.opts.deviceChannels;
    for (let f = 0; f < this.writers.length; f++) {
      const chans = this.specs[f].channels;
      let bufs = this.scratch[f];
      if (bufs[0].length !== frames) bufs = this.scratch[f] = chans.map(() => new Float32Array(frames));
      for (let k = 0; k < chans.length; k++) {
        const src = chans[k];
        const dst = bufs[k];
        for (let i = 0; i < frames; i++) dst[i] = interleaved[i * nch + src];
      }
      this.writers[f].write(bufs, frames);
    }
    this.flush();
  }

  /** Writes queued audio unless the disk failed a moment ago. */
  private flush(force = false): void {
    const now = this.opts.now();
    if (this.error && !force && now < this.nextTry) return;
    try {
      for (const w of this.writers) w.flush();
      this.error = null;
    } catch (e) {
      this.error = describeWriteError(e);
      this.nextTry = now + this.opts.retryMs;
    }
  }

  /** Call regularly: retries held audio and forces everything to disk on schedule. */
  tick(): void {
    if (this.closed) return;
    this.flush();
    const now = this.opts.now();
    if (!this.error && now - this.lastSync >= this.opts.syncIntervalMs) this.sync();
  }

  sync(): void {
    try {
      for (const w of this.writers) w.sync();
      this.lastSync = this.opts.now();
    } catch (e) {
      this.error = describeWriteError(e);
      this.nextTry = this.opts.now() + this.opts.retryMs;
    }
  }

  status(): TakeFilesStatus {
    return {
      queuedBytes: this.queued,
      framesOnDisk: this.writers.length ? Math.min(...this.writers.map((w) => w.framesOnDisk)) : 0,
      droppedFrames: this.dropped,
      error: this.error,
      lastSync: this.lastSync,
    };
  }

  /**
   * Finishes all files. If queued audio still can't be written, the files are
   * closed with what reached the disk and the error is returned.
   */
  close(): { error: string | null; framesOnDisk: number[] } {
    if (this.closed) return { error: this.error, framesOnDisk: this.writers.map((w) => w.framesOnDisk) };
    this.closed = true;
    let error: string | null = null;
    for (const w of this.writers) {
      try {
        w.close();
      } catch (e) {
        error = describeWriteError(e);
        w.abandon();
      }
    }
    this.error = error;
    return { error, framesOnDisk: this.writers.map((w) => w.framesOnDisk) };
  }
}
