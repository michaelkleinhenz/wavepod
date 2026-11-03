// The filters SoundPod offers, their parameters and defaults. Used by the UI and the processors.
import type { Fx, FxType } from '../../shared/types';
import { uid } from '../../shared/time';

export interface FxParamSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  unit?: string;
  /** Shown as a choice instead of a slider. */
  options?: Array<{ value: number; label: string }>;
  /** Logarithmic slider (frequencies). */
  log?: boolean;
}

export interface FxDefinition {
  type: FxType;
  name: string;
  description: string;
  params: FxParamSpec[];
}

const hz = (key: string, label: string, def: number, min = 20, max = 20000): FxParamSpec => ({ key, label, min, max, step: 1, default: def, unit: 'Hz', log: true });
const db = (key: string, label: string, def: number, min: number, max: number, step = 0.5): FxParamSpec => ({ key, label, min, max, step, default: def, unit: 'dB' });
const ms = (key: string, label: string, def: number, min: number, max: number, step = 1): FxParamSpec => ({ key, label, min, max, step, default: def, unit: 'ms' });

export const FX_DEFINITIONS: FxDefinition[] = [
  {
    type: 'highpass',
    name: 'High-pass',
    description: 'Removes rumble, handling noise and plosive thumps below the voice.',
    params: [
      hz('freq', 'Frequency', 80, 20, 400),
      { key: 'slope', label: 'Slope', min: 12, max: 24, step: 12, default: 12, unit: 'dB/oct', options: [{ value: 12, label: '12 dB/oct' }, { value: 24, label: '24 dB/oct' }] },
    ],
  },
  {
    type: 'eq',
    name: 'Equalizer',
    description: 'Parametric EQ: low shelf, two bell bands and a high shelf.',
    params: [
      hz('lsFreq', 'Low shelf', 120, 20, 1000),
      db('lsGain', 'Low shelf gain', 0, -18, 18),
      hz('p1Freq', 'Band 1', 300, 40, 8000),
      db('p1Gain', 'Band 1 gain', 0, -18, 18),
      { key: 'p1Q', label: 'Band 1 Q', min: 0.2, max: 8, step: 0.1, default: 1 },
      hz('p2Freq', 'Band 2', 3000, 200, 16000),
      db('p2Gain', 'Band 2 gain', 0, -18, 18),
      { key: 'p2Q', label: 'Band 2 Q', min: 0.2, max: 8, step: 0.1, default: 1 },
      hz('hsFreq', 'High shelf', 8000, 1000, 18000),
      db('hsGain', 'High shelf gain', 0, -18, 18),
    ],
  },
  {
    type: 'gate',
    name: 'Noise gate',
    description: 'Turns the track down while nobody speaks into it (room noise, other speakers bleeding in).',
    params: [
      db('threshold', 'Threshold', -50, -80, -10),
      db('range', 'Reduction', -30, -80, 0),
      ms('attack', 'Attack', 2, 0.1, 50, 0.1),
      ms('hold', 'Hold', 80, 0, 500),
      ms('release', 'Release', 200, 10, 2000),
    ],
  },
  {
    type: 'compressor',
    name: 'Compressor',
    description: 'Evens out loud and quiet passages of a voice.',
    params: [
      db('threshold', 'Threshold', -20, -60, 0),
      { key: 'ratio', label: 'Ratio', min: 1, max: 20, step: 0.1, default: 3, unit: ':1' },
      ms('attack', 'Attack', 10, 0.1, 200, 0.1),
      ms('release', 'Release', 150, 10, 2000),
      db('knee', 'Knee', 6, 0, 24),
      db('makeup', 'Make-up gain', 0, 0, 24),
    ],
  },
  {
    type: 'deesser',
    name: 'De-esser',
    description: 'Tames sharp "s" and "sh" sounds by turning down only the highs when they get loud.',
    params: [
      hz('freq', 'Frequency', 5500, 2000, 12000),
      db('threshold', 'Threshold', -30, -60, 0),
      db('maxReduction', 'Max reduction', 12, 0, 24),
      ms('release', 'Release', 60, 5, 500),
    ],
  },
  {
    type: 'limiter',
    name: 'Limiter',
    description: 'Keeps peaks below the ceiling.',
    params: [db('ceiling', 'Ceiling', -1, -12, 0, 0.1), ms('release', 'Release', 200, 10, 2000)],
  },
  {
    type: 'dynamics',
    name: 'Ultraschall Dynamics',
    description:
      'Brings a voice to an even target loudness: quiet speech is raised, loud speech is held back, and everything below the noise gate is muted. Adds 100 ms of latency, which SoundPod compensates.',
    params: [
      { key: 'target', label: 'Target', min: -25, max: -14, step: 0.1, default: -20, unit: 'LUFS' },
      db('noiseFloor', 'Noise floor', -40, -70, -20, 0.1),
      db('noiseGate', 'Noise gate', 30, 16, 88, 0.1),
    ],
  },
];

export function fxDefinition(type: FxType): FxDefinition {
  const d = FX_DEFINITIONS.find((x) => x.type === type);
  if (!d) throw new Error(`Unknown filter type ${type}`);
  return d;
}

export function defaultParams(type: FxType): Record<string, number> {
  return Object.fromEntries(fxDefinition(type).params.map((p) => [p.key, p.default]));
}

export function createFx(type: FxType, params: Record<string, number> = {}): Fx {
  return { id: uid('fx'), type, enabled: true, params: { ...defaultParams(type), ...params } };
}

/** Fills missing parameters with defaults and clamps values into range. */
export function normalizeFx(fx: Partial<Fx>): Fx | null {
  if (fx.type === 'vst3') {
    if (!fx.plugin?.path || !fx.plugin.cid) return null;
    const params: Record<string, number> = {};
    for (const [k, v] of Object.entries(fx.params ?? {})) if (Number.isFinite(Number(v))) params[k] = Math.min(1, Math.max(0, Number(v)));
    return {
      id: fx.id ?? uid('fx'),
      type: 'vst3',
      enabled: fx.enabled !== false,
      params,
      plugin: { path: fx.plugin.path, cid: fx.plugin.cid, name: fx.plugin.name ?? 'VST3', vendor: fx.plugin.vendor ?? '' },
      paramInfo: Array.isArray(fx.paramInfo) ? fx.paramInfo : [],
      ...(fx.state ? { state: fx.state } : {}),
    };
  }
  if (!fx.type || !FX_DEFINITIONS.some((d) => d.type === fx.type)) return null;
  const def = fxDefinition(fx.type);
  const params: Record<string, number> = {};
  for (const p of def.params) {
    const v = Number(fx.params?.[p.key]);
    params[p.key] = Number.isFinite(v) ? Math.min(p.max, Math.max(p.min, v)) : p.default;
  }
  return { id: fx.id ?? uid('fx'), type: fx.type, enabled: fx.enabled !== false, params };
}
