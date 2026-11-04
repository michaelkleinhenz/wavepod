// Where the audio of a take goes: a worker thread that writes the files (so a slow or full disk
// never holds up the audio callbacks), or, as a fallback, the engine's own thread.
import { Worker } from 'node:worker_threads';
import { TakeFiles, type TakeFileSpec, type TakeFilesOptions, type TakeFilesStatus } from '../../core/takeFiles';

export interface TakeSink {
  /** Takes one device buffer; the caller may reuse `interleaved` afterwards. */
  write(interleaved: Float32Array, frames: number): void;
  status(): TakeFilesStatus;
  /** Finishes the files and waits until they are on disk. */
  finish(): { error: string | null; framesOnDisk: number[] | null };
}

export type TakeSinkFactory = (specs: TakeFileSpec[], opts: TakeFilesOptions) => TakeSink;

/** Writes on the calling thread. */
export const inProcessSink: TakeSinkFactory = (specs, opts) => {
  const files = new TakeFiles(specs, opts);
  const timer = setInterval(() => files.tick(), 200);
  timer.unref?.();
  return {
    write: (buf, frames) => files.write(buf, frames),
    status: () => files.status(),
    finish: () => {
      clearInterval(timer);
      return files.close();
    },
  };
};

// Shared memory layout between the engine and the recording worker.
export const CTRL = { ack: 0, result: 1, replyLen: 2, statusLen: 3 } as const;
export const STAT = { queuedBytes: 0, framesOnDisk: 1, droppedFrames: 2, lastSync: 3 } as const;
export const TEXT_BYTES = 2048;

export interface RecordWorkerData {
  ctrl: SharedArrayBuffer;
  stats: SharedArrayBuffer;
  /** Answer to the last control message: an error text, or JSON. */
  reply: SharedArrayBuffer;
  /** The current write error, empty while writing works. */
  status: SharedArrayBuffer;
}

const START_TIMEOUT_MS = 10_000;
const FINISH_TIMEOUT_MS = 30_000;

const decode = (buf: Uint8Array, len: number) => Buffer.from(buf.subarray(0, Math.max(0, Math.min(len, buf.length)))).toString('utf8');

/**
 * A long-lived recording worker. It is started ahead of time, so pressing Record
 * only has to wait for the files to be created.
 */
export class RecordWorker {
  private worker: Worker | null = null;
  private ctrl = new Int32Array(new SharedArrayBuffer(16));
  private stats = new Float64Array(new SharedArrayBuffer(8 * 4));
  private reply = new Uint8Array(new SharedArrayBuffer(TEXT_BYTES));
  private statusText = new Uint8Array(new SharedArrayBuffer(TEXT_BYTES));
  private alive = false;
  private busy = false;
  /** Called when the worker dies in the middle of a take. */
  onDied: ((error: string) => void) | null = null;

  constructor(private script: string) {}

  /** Starts the worker if it isn't running. */
  warm(): void {
    if (this.alive && this.worker) return;
    Atomics.store(this.ctrl, CTRL.ack, 0);
    const data: RecordWorkerData = { ctrl: this.ctrl.buffer as SharedArrayBuffer, stats: this.stats.buffer as SharedArrayBuffer, reply: this.reply.buffer as SharedArrayBuffer, status: this.statusText.buffer as SharedArrayBuffer };
    const w = new Worker(this.script, { workerData: data });
    w.unref();
    this.alive = true;
    const died = (why: string) => {
      if (this.worker !== w) return;
      this.alive = false;
      this.worker = null;
      if (this.busy) {
        this.busy = false;
        this.onDied?.(why);
      }
    };
    w.on('error', (e) => died(`The recording writer failed: ${e.message}`));
    w.on('exit', (code) => died(`The recording writer stopped (exit code ${code})`));
    this.worker = w;
  }

  /** Sends a control message and waits for the worker to acknowledge it. */
  private call(msg: object, timeoutMs: number): { ok: boolean; reply: string } {
    if (!this.worker || !this.alive) return { ok: false, reply: 'The recording writer is not running' };
    const before = Atomics.load(this.ctrl, CTRL.ack);
    this.worker.postMessage(msg);
    const deadline = performance.now() + timeoutMs;
    while (Atomics.load(this.ctrl, CTRL.ack) === before) {
      const left = deadline - performance.now();
      if (left <= 0) return { ok: false, reply: 'The recording writer did not answer in time' };
      Atomics.wait(this.ctrl, CTRL.ack, before, Math.min(left, 100));
    }
    return { ok: Atomics.load(this.ctrl, CTRL.result) === 0, reply: decode(this.reply, Atomics.load(this.ctrl, CTRL.replyLen)) };
  }

  sink: TakeSinkFactory = (specs, opts) => {
    this.warm();
    const { writeSync: _w, now: _n, ...plain } = opts;
    const started = this.call({ type: 'start', specs, opts: plain }, START_TIMEOUT_MS);
    if (!started.ok) {
      // a worker that doesn't answer is no use for the next take either
      if (started.reply.includes('in time')) this.dispose();
      throw new Error(started.reply || 'Could not start recording');
    }
    this.busy = true;
    const worker = this.worker!;
    const mine = () => this.alive && this.worker === worker;
    return {
      write: (buf, frames) => {
        if (!mine()) return;
        const copy = buf.slice(0, frames * opts.deviceChannels);
        worker.postMessage({ type: 'data', frames, data: copy }, [copy.buffer]);
      },
      status: () => {
        const len = Atomics.load(this.ctrl, CTRL.statusLen);
        return {
          queuedBytes: this.stats[STAT.queuedBytes],
          framesOnDisk: this.stats[STAT.framesOnDisk],
          droppedFrames: this.stats[STAT.droppedFrames],
          lastSync: this.stats[STAT.lastSync],
          error: len > 0 ? decode(this.statusText, len) : null,
        };
      },
      finish: () => {
        if (!mine()) return { error: 'The recording writer stopped', framesOnDisk: null };
        const r = this.call({ type: 'stop' }, FINISH_TIMEOUT_MS);
        this.busy = false;
        if (!r.ok) return { error: r.reply, framesOnDisk: null };
        try {
          const res = JSON.parse(r.reply) as { error: string | null; framesOnDisk: number[] };
          return { error: res.error, framesOnDisk: res.framesOnDisk };
        } catch {
          return { error: null, framesOnDisk: null };
        }
      },
    };
  };

  dispose(): void {
    this.alive = false;
    this.busy = false;
    const w = this.worker;
    this.worker = null;
    void w?.terminate();
  }
}
