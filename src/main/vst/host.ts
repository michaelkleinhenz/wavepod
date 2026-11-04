// Synchronous client for wavepod-vsthost, used from the audio engine and the export worker.
// A bridge worker owns the child process; this thread waits on shared memory with a timeout,
// so a hung or crashed plug-in bypasses itself instead of stalling playback or recording.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { Fx, VstParamInfo } from '../../shared/types';
import type { VstHost, VstInstance } from '../../core/fx/vst';

const OP = { create: 1, destroy: 2, params: 3, process: 4, reset: 5, getState: 6, setState: 7, format: 8, parse: 9, values: 10 } as const;
const DATA_BYTES = 4 << 20;
const TIMEOUT = { create: 15000, process: 250, other: 3000 };

export function vstHostExecutable(appRoot: string, resourcesPath?: string): string | null {
  const name = process.platform === 'win32' ? 'wavepod-vsthost.exe' : 'wavepod-vsthost';
  const candidates = [
    process.env.WAVEPOD_VSTHOST,
    resourcesPath && path.join(resourcesPath, 'vsthost', name),
    path.join(appRoot, 'native', 'vsthost', 'bin', name),
  ].filter((p): p is string => !!p);
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

class Writer {
  private buf: Buffer;
  private at = 0;
  constructor(size = 256) {
    this.buf = Buffer.alloc(size);
  }
  private room(n: number): void {
    if (this.at + n <= this.buf.length) return;
    const next = Buffer.alloc(Math.max(this.buf.length * 2, this.at + n));
    this.buf.copy(next, 0, 0, this.at);
    this.buf = next;
  }
  u8(v: number): this {
    this.room(1);
    this.buf.writeUInt8(v, this.at);
    this.at += 1;
    return this;
  }
  u32(v: number): this {
    this.room(4);
    this.buf.writeUInt32LE(v >>> 0, this.at);
    this.at += 4;
    return this;
  }
  f64(v: number): this {
    this.room(8);
    this.buf.writeDoubleLE(v, this.at);
    this.at += 8;
    return this;
  }
  str(s: string): this {
    const b = Buffer.from(s, 'utf8');
    this.u32(b.length);
    return this.bytes(b);
  }
  bytes(b: Uint8Array): this {
    this.room(b.length);
    this.buf.set(b, this.at);
    this.at += b.length;
    return this;
  }
  f32(a: Float32Array, n: number): this {
    this.room(n * 4);
    // the payload is unaligned (op + ids precede it), so copy bytes rather than through a float view
    const src = a.subarray(0, n);
    this.buf.set(new Uint8Array(src.buffer, src.byteOffset, n * 4), this.at);
    this.at += n * 4;
    return this;
  }
  done(): Uint8Array {
    return this.buf.subarray(0, this.at);
  }
}

export class VstHostProcess implements VstHost {
  private ctrl: Int32Array;
  private data: Uint8Array;
  private worker: Worker | null = null;
  private nextId = 1;
  private dead = false;
  /** Instances of the current host process; a restarted host starts empty. */
  private generation = 0;

  constructor(
    private exe: string,
    private workerScript: string,
  ) {
    this.ctrl = new Int32Array(new SharedArrayBuffer(16));
    this.data = new Uint8Array(new SharedArrayBuffer(DATA_BYTES));
    this.start();
  }

  private start(): void {
    this.dead = false;
    this.generation++;
    Atomics.store(this.ctrl, 0, 0);
    this.worker = new Worker(this.workerScript, { workerData: { exe: this.exe, ctrl: this.ctrl.buffer, data: this.data.buffer } });
    this.worker.unref();
    this.worker.on('error', () => (this.dead = true));
  }

  /** Kills the host; the next create() starts a fresh one. */
  private kill(): void {
    this.dead = true;
    const pid = Atomics.load(this.ctrl, 2);
    if (pid > 0) {
      try {
        process.kill(pid);
      } catch {
        /* already gone */
      }
      Atomics.store(this.ctrl, 2, 0);
    }
    void this.worker?.terminate();
    this.worker = null;
  }

  dispose(): void {
    this.kill();
  }

  request(payload: Uint8Array, timeoutMs: number): Buffer {
    if (this.dead || !this.worker) throw new Error('The plug-in host is not running');
    if (payload.length > this.data.length) throw new Error('Request too large');
    this.data.set(payload, 0);
    Atomics.store(this.ctrl, 1, payload.length);
    Atomics.store(this.ctrl, 0, 1);
    Atomics.add(this.ctrl, 3, 1);
    Atomics.notify(this.ctrl, 3);
    const deadline = performance.now() + timeoutMs;
    while (Atomics.load(this.ctrl, 0) === 1) {
      const left = deadline - performance.now();
      if (left <= 0 || Atomics.wait(this.ctrl, 0, 1, left) === 'timed-out') {
        if (Atomics.load(this.ctrl, 0) === 1) {
          this.kill();
          throw new Error('The plug-in stopped responding and was bypassed');
        }
      }
    }
    const state = Atomics.load(this.ctrl, 0);
    if (state === 3) {
      this.kill();
      throw new Error('The plug-in host crashed; plug-ins were bypassed');
    }
    const len = Atomics.load(this.ctrl, 1);
    const reply = Buffer.from(this.data.subarray(0, len));
    Atomics.store(this.ctrl, 0, 0);
    Atomics.notify(this.ctrl, 0);
    if (reply[0] !== 0) throw new Error(reply.subarray(1).toString('utf8') || 'Plug-in error');
    return reply.subarray(1);
  }

  create(fx: Pick<Fx, 'plugin'>, sampleRate: number, maxBlock: number): VstInstance {
    if (!fx.plugin) throw new Error('No plug-in');
    if (this.dead) this.start();
    const id = this.nextId++;
    const reply = this.request(new Writer().u8(OP.create).u32(id).f64(sampleRate).u32(maxBlock).str(fx.plugin.path).str(fx.plugin.cid).done(), TIMEOUT.create);
    const info = JSON.parse(reply.toString('utf8')) as { latency: number; params: Array<VstParamInfo & { value: number }> };
    return new HostedInstance(this, id, this.generation, info.latency, info.params);
  }

  isCurrent(generation: number): boolean {
    return !this.dead && generation === this.generation;
  }

  static TIMEOUT = TIMEOUT;
  static OP = OP;
  static Writer = Writer;
}

class HostedInstance implements VstInstance {
  constructor(
    private host: VstHostProcess,
    private id: number,
    private generation: number,
    readonly latency: number,
    readonly params: Array<VstParamInfo & { value: number }>,
  ) {}

  get alive(): boolean {
    return this.host.isCurrent(this.generation);
  }

  private call(w: Writer, timeout = TIMEOUT.other): Buffer {
    if (!this.alive) throw new Error('The plug-in host was restarted');
    return this.host.request(w.done(), timeout);
  }

  setParams(changes: Array<[number, number]>): void {
    const w = new Writer(16 + changes.length * 12).u8(OP.params).u32(this.id).u32(changes.length);
    for (const [pid, v] of changes) w.u32(pid).f64(v);
    this.call(w);
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    const w = new Writer(16 + n * 8).u8(OP.process).u32(this.id).u32(n).f32(L, n).f32(R, n);
    const r = this.call(w, TIMEOUT.process);
    // reply: f32 L[n], f32 R[n] (copy, since the buffer may be unaligned)
    for (let i = 0; i < n; i++) {
      L[i] = r.readFloatLE(i * 4);
      R[i] = r.readFloatLE((n + i) * 4);
    }
  }

  reset(): void {
    this.call(new Writer().u8(OP.reset).u32(this.id));
  }

  setState(state: Uint8Array): Array<{ id: number; value: number }> {
    const r = this.call(new Writer(16 + state.length).u8(OP.setState).u32(this.id).bytes(state));
    return JSON.parse(r.toString('utf8') || '[]');
  }

  getState(): Uint8Array {
    return Uint8Array.from(this.call(new Writer().u8(OP.getState).u32(this.id)));
  }

  format(paramId: number, value: number): string {
    return this.call(new Writer().u8(OP.format).u32(this.id).u32(paramId).f64(value)).toString('utf8');
  }

  parse(paramId: number, text: string): number | null {
    try {
      const r = this.call(new Writer().u8(OP.parse).u32(this.id).u32(paramId).str(text));
      return r.length >= 8 ? r.readDoubleLE(0) : null;
    } catch (e) {
      // hosts built before PARSE existed answer "unknown op"
      if (/unknown op/.test(String(e))) return null;
      throw e;
    }
  }

  values(): Array<{ id: number; value: number }> | null {
    try {
      return JSON.parse(this.call(new Writer().u8(OP.values).u32(this.id)).toString('utf8') || '[]');
    } catch (e) {
      if (/unknown op/.test(String(e))) return null;
      throw e;
    }
  }

  destroy(): void {
    if (!this.alive) return;
    this.call(new Writer().u8(OP.destroy).u32(this.id));
  }
}
