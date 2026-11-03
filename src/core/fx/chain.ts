// A running filter stack: keeps processor instances (and their state) in sync with a Fx[] list.
import type { Fx } from '../../shared/types';
import { createProcessor, type FxProcessor } from './processors';

function pluginKey(fx: Fx): string {
  return fx.plugin ? `${fx.plugin.path}|${fx.plugin.cid}|${fx.state ?? ''}` : '';
}

interface Slot {
  key: string;
  id: string;
  type: Fx['type'];
  enabled: boolean;
  proc: FxProcessor;
}

export class FxChain {
  private slots: Slot[] = [];
  private active: FxProcessor[] = [];
  private list: Fx[] | undefined;
  latency = 0;

  constructor(private sampleRate: number) {}

  /** Updates the stack. Processors are reused by filter id, so parameter edits and reordering keep their state. */
  sync(list: Fx[] | undefined): void {
    if (list === this.list) return;
    this.list = list;
    const next = (list ?? []).map((fx) => {
      const old = this.slots.find((s) => s.id === fx.id && s.type === fx.type && (fx.type !== 'vst3' || s.key === pluginKey(fx)));
      const proc = old?.proc ?? createProcessor(fx.type, this.sampleRate, fx);
      proc.setParams(fx.params);
      // a bypassed filter starts from a clean state when it is switched back on
      if (!fx.enabled && old?.enabled) proc.reset();
      return { id: fx.id, type: fx.type, key: pluginKey(fx), enabled: fx.enabled, proc };
    });
    for (const s of this.slots) if (!next.some((x) => x.proc === s.proc)) s.proc.dispose?.();
    this.slots = next;
    this.active = this.slots.filter((s) => s.enabled).map((s) => s.proc);
    this.latency = this.active.reduce((sum, p) => sum + p.latency, 0);
  }

  get empty(): boolean {
    return this.active.length === 0;
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    for (const p of this.active) p.process(L, R, n);
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
