// Runs in a worker thread: owns the soundpod-vsthost child process and moves requests and
// replies between it and the thread that waits synchronously on a SharedArrayBuffer.
//
// Shared layout: Int32 ctrl[0] = state (0 idle, 1 request ready, 2 reply ready, 3 host dead),
// ctrl[1] = byte length of the request or reply in `data`, ctrl[2] = host process id,
// ctrl[3] = request sequence number (bumped by the waiting thread for every request).
import { spawn } from 'node:child_process';
import { workerData } from 'node:worker_threads';

interface Init {
  exe: string;
  ctrl: SharedArrayBuffer;
  data: SharedArrayBuffer;
}

const { exe, ctrl: ctrlBuf, data: dataBuf } = workerData as Init;
const ctrl = new Int32Array(ctrlBuf);
const data = new Uint8Array(dataBuf);

const child = spawn(exe, ['--serve'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
// lets the waiting thread kill the host if a plug-in hangs
Atomics.store(ctrl, 2, child.pid ?? 0);
let pending: Buffer[] = [];
let pendingBytes = 0;
let dead = false;

function die(reason: string): void {
  if (dead) return;
  dead = true;
  process.stderr.write(`[vsthost] ${reason}\n`);
  Atomics.store(ctrl, 0, 3);
  Atomics.notify(ctrl, 0);
}

child.on('error', (e) => die(`could not start: ${e.message}`));
child.on('exit', (code, signal) => die(`exited (${signal ?? code})`));
child.stdin.on('error', () => die('pipe closed'));
child.stderr.on('data', (d: Buffer) => process.stderr.write(`[vsthost] ${d}`));

child.stdout.on('data', (chunk: Buffer) => {
  pending.push(chunk);
  pendingBytes += chunk.length;
  if (pendingBytes < 4) return;
  const all = pending.length === 1 ? pending[0] : Buffer.concat(pending);
  const len = all.readUInt32LE(0);
  if (all.length < 4 + len) {
    pending = [all];
    return;
  }
  if (len > data.length) return die('reply too large');
  data.set(all.subarray(4, 4 + len), 0);
  const rest = all.subarray(4 + len);
  pending = rest.length ? [rest] : [];
  pendingBytes = rest.length;
  Atomics.store(ctrl, 1, len);
  Atomics.store(ctrl, 0, 2);
  Atomics.notify(ctrl, 0);
});

// Waits on the sequence number rather than the state: the waiting thread may consume a reply
// and post the next request before this thread wakes up, so the state alone can look unchanged.
async function loop(): Promise<void> {
  let seen = 0;
  while (!dead) {
    const seq = Atomics.load(ctrl, 3);
    if (seq !== seen && Atomics.load(ctrl, 0) === 1) {
      seen = seq;
      const len = Atomics.load(ctrl, 1);
      const head = Buffer.alloc(4);
      head.writeUInt32LE(len, 0);
      // copy out of shared memory before the next request can overwrite it
      child.stdin.write(Buffer.concat([head, Buffer.from(data.subarray(0, len))]));
      continue;
    }
    const r = (Atomics as unknown as { waitAsync(a: Int32Array, i: number, v: number, t: number): { async: boolean; value: Promise<unknown> } }).waitAsync(ctrl, 3, seq, 1000);
    if (r.async) await r.value;
  }
}

void loop();
