// VST3 plug-ins in a filter stack. The actual hosting happens in a separate process
// (native/vsthost); this module only defines what the mixer needs from it.
import { VST_PARAM_BYPASS, VST_PARAM_HIDDEN, VST_PARAM_PROGRAM_CHANGE, VST_PARAM_READONLY, type Fx, type VstParamInfo, type VstPluginRef } from '../../shared/types';
import { uid } from '../../shared/time';
import type { FxProcessor } from './processors';

export interface VstInstance {
  readonly latency: number;
  readonly params: Array<VstParamInfo & { value: number }>;
  setParams(changes: Array<[number, number]>): void;
  process(L: Float32Array, R: Float32Array, n: number): void;
  reset(): void;
  setState(state: Uint8Array): Array<{ id: number; value: number }>;
  getState(): Uint8Array;
  /** The controller's current parameter values (hosts without this op answer null). */
  values?(): Array<{ id: number; value: number }> | null;
  format(paramId: number, value: number): string;
  /** The normalized value for the plug-in's own text, or null if it can't read it. */
  parse?(paramId: number, text: string): number | null;
  destroy(): void;
  /** False once the host process died or the plug-in stopped answering. */
  readonly alive: boolean;
}

export interface VstHost {
  /** Loads a plug-in. Throws with a readable message if it can't. */
  create(fx: Pick<Fx, 'plugin'>, sampleRate: number, maxBlock: number): VstInstance;
}

const VST_SKIP_FLAGS = VST_PARAM_HIDDEN | VST_PARAM_READONLY | VST_PARAM_BYPASS | VST_PARAM_PROGRAM_CHANGE;

/** Parameters WavePod shows as sliders (and lets agents change). Plug-in editors are never opened. */
export function visibleVstParams<T extends VstParamInfo>(params: T[]): T[] {
  return params.filter((p) => (p.flags & VST_SKIP_FLAGS) === 0);
}

/** The plug-in's program selector (a list parameter flagged as program change), if it has one. */
export function vstProgramParam<T extends VstParamInfo>(params: T[]): T | null {
  return params.find((p) => (p.flags & VST_PARAM_PROGRAM_CHANGE) !== 0 && p.steps > 0) ?? null;
}

/** A new VST3 filter from a plug-in's description (parameters with their current values, and its state). */
export function createVstFx(plugin: VstPluginRef, desc: { params: Array<VstParamInfo & { value: number }>; state: string }): Fx {
  const ref = { path: plugin.path, cid: plugin.cid, name: plugin.name, vendor: plugin.vendor };
  const shown = visibleVstParams(desc.params);
  // the program selector is kept in paramInfo (for the preset menu) but gets no slider and no stored value
  const program = vstProgramParam(desc.params);
  const info = program ? [...shown, program] : shown;
  return {
    id: uid('fx'),
    type: 'vst3',
    enabled: true,
    plugin: ref,
    paramInfo: info.map(({ id, title, units, steps, default: d, flags }) => ({ id, title, units, steps, default: d, flags })),
    params: Object.fromEntries(shown.map((p) => [String(p.id), p.value])),
    state: desc.state,
  };
}

/**
 * Selects one of a plug-in's programs on a scratch instance (starting from the filter's state) and
 * reads back the resulting state and parameter values, for storing in the filter.
 */
export function loadVstProgram(h: VstHost, fx: Fx, sampleRate: number, paramId: number, value: number): { state: string; values: Array<{ id: number; value: number }> } {
  if (!fx.plugin) throw new Error('No plug-in');
  const inst = h.create(fx, sampleRate, MAX_BLOCK);
  try {
    const state = decodeState(fx.state);
    if (state?.length) inst.setState(state);
    inst.setParams([[paramId, value]]);
    // the processor picks the change up while processing
    const n = 64;
    for (let i = 0; i < 2; i++) inst.process(new Float32Array(n), new Float32Array(n), n);
    const values = inst.values?.() ?? null;
    const bytes = inst.getState();
    // a host without VALUES: load the state back to have the controller report its values
    return { state: encodeState(bytes), values: values ?? inst.setState(bytes) };
  } finally {
    inst.destroy();
  }
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

const MAX_BLOCK = 4096;

export function encodeState(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function decodeState(b64: string | undefined): Uint8Array | null {
  if (!b64) return null;
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}


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
