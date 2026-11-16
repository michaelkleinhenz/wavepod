// Voice cleanup: AI separation of a voice from background noise and room reverb, with a level for
// each of the three parts. The work happens in WebAssembly (native/voiceclean): DeepFilterNet 3
// (MIT/Apache-2.0) splits voice from everything else, and a late-reverberation model splits the
// room off both halves. One .wasm runs on every platform; it is loaded from disk once per thread
// (the model is about 8 MB) and each channel gets its own instance. Adds about 40 ms of latency,
// which the mixer compensates.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FxProcessor } from './processors';
import { GainMeter } from './meter';

const WASM_NAME = 'voiceclean.wasm';
/** Largest block the module takes at once. */
const IO_LEN = 8192;
/** Levels at or below this are off. */
export const VOICE_CLEAN_OFF_DB = -60;

interface VoiceCleanExports {
  memory: WebAssembly.Memory;
  vc_init(): void;
  vc_new(sampleRate: number): number;
  vc_free(p: number): void;
  vc_io(p: number): number;
  vc_set(p: number, voice: number, ambience: number, reverb: number): void;
  vc_process(p: number, n: number): void;
  vc_latency(p: number): number;
  vc_reset(p: number): void;
  vc_rt60(p: number): number;
  vc_lsnr(p: number): number;
}

let wasmPath = '';
let exportsCache: VoiceCleanExports | null = null;

/** Where voiceclean.wasm is (the app's resources folder); without it the usual places are searched. */
export function setVoiceCleanWasm(file: string): void {
  wasmPath = file;
}

function findWasm(): string {
  const candidates = [
    wasmPath,
    // packaged app: resources/voiceclean.wasm
    typeof process.resourcesPath === 'string' ? path.join(process.resourcesPath, WASM_NAME) : '',
    // dist/main next to the bundle (development builds copy it there)
    path.join(__dirname, WASM_NAME),
    // sources (tests)
    path.join(__dirname, '../../../native/voiceclean', WASM_NAME),
    path.join(process.cwd(), 'native/voiceclean', WASM_NAME),
  ];
  const hit = candidates.find((c) => c && fs.existsSync(c));
  if (!hit) throw new Error(`Voice cleanup: ${WASM_NAME} not found`);
  return hit;
}

/** The module of this thread, loaded and with its model ready (takes most of a second the first time). */
export function voiceCleanModule(): VoiceCleanExports {
  if (exportsCache) return exportsCache;
  const module = new WebAssembly.Module(fs.readFileSync(findWasm()));
  const ex = new WebAssembly.Instance(module, {}).exports as unknown as VoiceCleanExports;
  ex.vc_init();
  exportsCache = ex;
  return ex;
}

/** Whether the module can be loaded here (false e.g. when the file is missing from a build). */
export function voiceCleanAvailable(): boolean {
  try {
    voiceCleanModule();
    return true;
  } catch {
    return false;
  }
}

const level = (db: number) => (db <= VOICE_CLEAN_OFF_DB ? 0 : Math.pow(10, db / 20));

/** One channel of the module. */
class Channel {
  readonly p: number;
  constructor(private ex: VoiceCleanExports, sr: number) {
    this.p = ex.vc_new(sr);
  }
  run(buf: Float32Array, n: number, g: [number, number, number]): void {
    const { ex, p } = this;
    ex.vc_set(p, g[0], g[1], g[2]);
    for (let o = 0; o < n; o += IO_LEN) {
      const m = Math.min(IO_LEN, n - o);
      // the memory may grow (and move) inside a call, so the view is taken fresh each time
      new Float32Array(ex.memory.buffer, ex.vc_io(p), m).set(buf.subarray(o, o + m));
      ex.vc_process(p, m);
      buf.set(new Float32Array(ex.memory.buffer, ex.vc_io(p), m), o);
    }
  }
}

export class VoiceClean implements FxProcessor {
  readonly latency: number;
  private ex: VoiceCleanExports | null = null;
  private left: Channel | null = null;
  /** Created the first time the two channels differ; from then on both run. */
  private right: Channel | null = null;
  private gains: [number, number, number] = [1, 0, level(-15)];
  private meter = new GainMeter();

  constructor(private sr: number) {
    try {
      this.ex = voiceCleanModule();
      this.left = new Channel(this.ex, sr);
      this.latency = this.ex.vc_latency(this.left.p);
    } catch (e) {
      // without the module the filter passes the sound through (and says so in the log once)
      if (!warned) console.warn(String(e));
      warned = true;
      this.latency = 0;
    }
  }

  setParams(p: Record<string, number>): void {
    this.gains = [level(p.voice ?? 0), level(p.ambience ?? VOICE_CLEAN_OFF_DB), level(p.reverb ?? -15)];
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    if (!this.left || !this.ex) return;
    let inE = 0;
    for (let i = 0; i < n; i++) inE += L[i] * L[i] + R[i] * R[i];
    if (!this.right) {
      let same = true;
      for (let i = 0; i < n; i++) {
        if (L[i] !== R[i]) {
          same = false;
          break;
        }
      }
      if (!same) {
        this.right = new Channel(this.ex, this.sr);
      } else {
        this.left.run(L, n, this.gains);
        R.set(L.subarray(0, n));
        this.note(inE, L, R, n);
        return;
      }
    }
    this.left.run(L, n, this.gains);
    this.right.run(R, n, this.gains);
    this.note(inE, L, R, n);
  }

  private note(inE: number, L: Float32Array, R: Float32Array, n: number): void {
    let outE = 0;
    for (let i = 0; i < n; i++) outE += L[i] * L[i] + R[i] * R[i];
    // what the filter takes away, as a level change (only while there is something to take)
    if (inE > 1e-7 * n) this.meter.note(Math.min(0, 10 * Math.log10((outE + 1e-12) / inE)));
  }

  takeGain(): number {
    return this.meter.take();
  }

  /** The room's reverberation time the filter has estimated, in seconds (for tests and meters). */
  roomTime(): number {
    return this.ex && this.left ? this.ex.vc_rt60(this.left.p) : 0;
  }

  reset(): void {
    if (!this.ex) return;
    if (this.left) this.ex.vc_reset(this.left.p);
    if (this.right) this.ex.vc_reset(this.right.p);
  }

  dispose(): void {
    if (!this.ex) return;
    if (this.left) this.ex.vc_free(this.left.p);
    if (this.right) this.ex.vc_free(this.right.p);
    this.left = this.right = null;
  }
}

let warned = false;
