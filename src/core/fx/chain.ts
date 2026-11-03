// A running filter stack: keeps processor instances (and their state) in sync with a Fx[] list.
import type { Fx } from '../../shared/types';
import { createProcessor, type FxProcessor } from './processors';

interface Slot {
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
    this.slots = (list ?? []).map((fx) => {
      const old = this.slots.find((s) => s.id === fx.id && s.type === fx.type);
      const proc = old?.proc ?? createProcessor(fx.type, this.sampleRate);
      proc.setParams(fx.params);
      // a bypassed filter starts from a clean state when it is switched back on
      if (!fx.enabled && old?.enabled) proc.reset();
      return { id: fx.id, type: fx.type, enabled: fx.enabled, proc };
    });
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
}
