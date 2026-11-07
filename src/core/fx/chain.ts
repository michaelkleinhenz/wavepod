// A running filter stack: keeps processor instances (and their state) in sync with a Fx[] list.
import type { Fx, FxMeter } from '../../shared/types';
import { createProcessor, type FxProcessor } from './processors';

/** What a processor instance is built from besides its parameters: a new key means a new instance. */
function pluginKey(fx: Fx): string {
  if (fx.type === 'convolution') return `ir:${fx.ir?.file ?? ''}`;
  return fx.plugin ? `${fx.plugin.path}|${fx.plugin.cid}|${fx.state ?? ''}` : '';
}

interface Slot {
  key: string;
  id: string;
  type: Fx['type'];
  enabled: boolean;
  proc: FxProcessor;
  /** Peaks in and out since the last meter read. */
  inPeak: number;
  outPeak: number;
  metered: boolean;
}

function peak(L: Float32Array, R: Float32Array, n: number): number {
  let p = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(L[i]);
    const b = Math.abs(R[i]);
    if (a > p) p = a;
    if (b > p) p = b;
  }
  return p;
}

export class FxChain {
  private slots: Slot[] = [];
  private active: Slot[] = [];
  private list: Fx[] | undefined;
  latency = 0;

  constructor(private sampleRate: number) {}

  /** Updates the stack. Processors are reused by filter id, so parameter edits and reordering keep their state. */
  sync(list: Fx[] | undefined): void {
    if (list === this.list) return;
    this.list = list;
    const next = (list ?? []).map((fx) => {
      const old = this.slots.find((s) => s.id === fx.id && s.type === fx.type && s.key === pluginKey(fx));
      const proc = old?.proc ?? createProcessor(fx.type, this.sampleRate, fx);
      proc.setParams(fx.params);
      // a bypassed filter starts from a clean state when it is switched back on
      if (!fx.enabled && old?.enabled) proc.reset();
      return { id: fx.id, type: fx.type, key: pluginKey(fx), enabled: fx.enabled, proc, inPeak: old?.inPeak ?? 0, outPeak: old?.outPeak ?? 0, metered: old?.metered ?? false };
    });
    for (const s of this.slots) if (!next.some((x) => x.proc === s.proc)) s.proc.dispose?.();
    this.slots = next;
    this.active = this.slots.filter((s) => s.enabled);
    this.latency = this.active.reduce((sum, s) => sum + s.proc.latency, 0);
  }

  get empty(): boolean {
    return this.active.length === 0;
  }

  /** Runs the stack. With `meter`, also measures each filter's input and output peaks. */
  process(L: Float32Array, R: Float32Array, n: number, meter = false): void {
    if (!meter) {
      for (const s of this.active) s.proc.process(L, R, n);
      return;
    }
    let level = peak(L, R, n);
    for (const s of this.active) {
      s.proc.process(L, R, n);
      const out = peak(L, R, n);
      if (level > s.inPeak) s.inPeak = level;
      if (out > s.outPeak) s.outPeak = out;
      s.metered = true;
      level = out;
    }
  }

  /** Adds the meters of filters that ran with metering since the last call to `into`, then starts over. */
  takeMeters(into: Record<string, FxMeter>): void {
    for (const s of this.active) {
      if (!s.metered) continue;
      const m: FxMeter = { in: s.inPeak, out: s.outPeak };
      const gain = s.proc.takeGain?.();
      if (gain !== undefined) m.gain = gain;
      const level = s.proc.detectorLevel?.();
      if (level !== undefined) m.level = level;
      // the same filter can run in several chains (a track's filters also run on its clips with filters)
      const prev = into[s.id];
      if (prev) {
        m.in = Math.max(m.in, prev.in);
        m.out = Math.max(m.out, prev.out);
        if (prev.gain !== undefined) m.gain = m.gain === undefined || Math.abs(prev.gain) > Math.abs(m.gain) ? prev.gain : m.gain;
        if (prev.level !== undefined) m.level = m.level === undefined ? prev.level : Math.max(m.level, prev.level);
      }
      into[s.id] = m;
      s.inPeak = s.outPeak = 0;
      s.metered = false;
    }
  }

  reset(): void {
    for (const s of this.slots) s.proc.reset();
  }

  dispose(): void {
    for (const s of this.slots) s.proc.dispose?.();
    this.slots = [];
    this.active = [];
    this.list = undefined;
  }
}
