// VST3 plug-ins in a filter stack. The actual hosting happens in a separate process
// (native/vsthost); this module only defines what the mixer needs from it.
import type { Fx, VstParamInfo } from '../../shared/types';
import type { FxProcessor } from './processors';

export interface VstInstance {
  readonly latency: number;
  readonly params: Array<VstParamInfo & { value: number }>;
  setParams(changes: Array<[number, number]>): void;
  process(L: Float32Array, R: Float32Array, n: number): void;
  reset(): void;
  setState(state: Uint8Array): Array<{ id: number; value: number }>;
  getState(): Uint8Array;
  format(paramId: number, value: number): string;
  destroy(): void;
  /** False once the host process died or the plug-in stopped answering. */
  readonly alive: boolean;
}

export interface VstHost {
  /** Loads a plug-in. Throws with a readable message if it can't. */
  create(fx: Pick<Fx, 'plugin'>, sampleRate: number, maxBlock: number): VstInstance;
}

let host: VstHost | null = null;
const failures = new Map<string, string>();
let onFailure: (fxId: string, message: string) => void = () => {};

/** Installs the host used for VST3 filters (main process and export worker). */
export function setVstHost(h: VstHost | null, failureHandler?: (fxId: string, message: string) => void): void {
  host = h;
  if (failureHandler) onFailure = failureHandler;
}

/** Plug-ins that failed to load or crashed, by filter id. They are bypassed. */
export function vstFailures(): ReadonlyMap<string, string> {
  return failures;
}

export function decodeState(b64: string | undefined): Uint8Array | null {
  if (!b64) return null;
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

const MAX_BLOCK = 4096;

/** A VST3 filter. Passes audio through unchanged when no host is available or the plug-in failed. */
export class VstProcessor implements FxProcessor {
  latency = 0;
  private inst: VstInstance | null = null;
  private sent = new Map<number, number>();

  constructor(private fx: Fx, sampleRate: number) {
    if (!host || !fx.plugin) return;
    try {
      this.inst = host.create(fx, sampleRate, MAX_BLOCK);
      const state = decodeState(fx.state);
      if (state?.length) this.inst.setState(state);
      this.latency = this.inst.latency;
      failures.delete(fx.id);
    } catch (e) {
      this.fail((e as Error).message);
    }
  }

  private fail(message: string): void {
    this.inst = null;
    failures.set(this.fx.id, message);
    onFailure(this.fx.id, `${this.fx.plugin?.name ?? 'VST3 plug-in'}: ${message}`);
  }

  setParams(params: Record<string, number>): void {
    if (!this.inst) return;
    const changes: Array<[number, number]> = [];
    for (const [k, v] of Object.entries(params)) {
      const id = Number(k);
      if (!Number.isFinite(id) || this.sent.get(id) === v) continue;
      this.sent.set(id, v);
      changes.push([id, v]);
    }
    if (!changes.length) return;
    try {
      this.inst.setParams(changes);
    } catch (e) {
      this.fail((e as Error).message);
    }
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    if (!this.inst) return;
    try {
      for (let i = 0; i < n; i += MAX_BLOCK) {
        const m = Math.min(MAX_BLOCK, n - i);
        this.inst.process(L.subarray(i, i + m), R.subarray(i, i + m), m);
      }
    } catch (e) {
      this.fail((e as Error).message);
    }
  }

  reset(): void {
    if (!this.inst) return;
    try {
      this.inst.reset();
    } catch (e) {
      this.fail((e as Error).message);
    }
  }

  dispose(): void {
    try {
      this.inst?.destroy();
    } catch {
      /* host already gone */
    }
    this.inst = null;
  }
}
