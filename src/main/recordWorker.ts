// The recording worker thread: writes the files of the take that is being recorded.
// It answers control messages through shared memory, so the engine can wait for it
// synchronously when a take starts and stops.
import { parentPort, workerData } from 'node:worker_threads';
import { TakeFiles, type TakeFileSpec, type TakeFilesOptions } from '../core/takeFiles';
import { CTRL, STAT, type RecordWorkerData } from './audio/takeSink';

const shared = workerData as RecordWorkerData;
const ctrl = new Int32Array(shared.ctrl);
const stats = new Float64Array(shared.stats);
const reply = new Uint8Array(shared.reply);
const statusText = new Uint8Array(shared.status);
const enc = new TextEncoder();

let files: TakeFiles | null = null;

function putText(target: Uint8Array, lenSlot: number, text: string): void {
  const r = enc.encodeInto(text, target);
  Atomics.store(ctrl, lenSlot, r.written ?? 0);
}

function answer(ok: boolean, text: string): void {
  putText(reply, CTRL.replyLen, text);
  Atomics.store(ctrl, CTRL.result, ok ? 0 : 1);
  Atomics.add(ctrl, CTRL.ack, 1);
  Atomics.notify(ctrl, CTRL.ack);
}

let lastError: string | null = null;
function publish(): void {
  const s = files?.status();
  stats[STAT.queuedBytes] = s?.queuedBytes ?? 0;
  stats[STAT.framesOnDisk] = s?.framesOnDisk ?? 0;
  stats[STAT.droppedFrames] = s?.droppedFrames ?? 0;
  stats[STAT.lastSync] = s?.lastSync ?? 0;
  const err = s?.error ?? null;
  if (err !== lastError) {
    lastError = err;
    putText(statusText, CTRL.statusLen, err ?? '');
  }
}

type Msg =
  | { type: 'start'; specs: TakeFileSpec[]; opts: TakeFilesOptions }
  | { type: 'data'; frames: number; data: Float32Array }
  | { type: 'stop' };

parentPort!.on('message', (m: Msg) => {
  try {
    if (m.type === 'data') {
      files?.write(m.data, m.frames);
    } else if (m.type === 'start') {
      files?.close();
      files = null;
      files = new TakeFiles(m.specs, m.opts);
      publish();
      answer(true, '');
    } else if (m.type === 'stop') {
      const r = files ? files.close() : { error: null, framesOnDisk: [] };
      files = null;
      publish();
      answer(true, JSON.stringify(r));
    }
  } catch (e) {
    if (m.type !== 'data') answer(false, (e as Error).message ?? String(e));
  }
});

setInterval(() => {
  files?.tick();
  publish();
}, 200);
