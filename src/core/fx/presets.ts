// Filter presets: named settings for one kind of filter (a built-in type, or one VST3 plug-in),
// stored per user so they work in every episode. Pure helpers; the files live in main/presetStore.
import type { Fx, FxPresetRef, FxType, VstParamInfo } from '../../shared/types';
import { FX_DEFINITIONS, defaultParams, normalizeFx } from './definitions';
import { visibleVstParams } from './vst';

/** What a preset file holds. */
export interface FxPreset {
  name: string;
  type: FxType;
  /** VST3 only: the plug-in the preset belongs to (matched by class id). */
  plugin?: { cid: string; name: string; vendor: string };
  /** Built-in: values by key. VST3: normalized values by parameter id. */
  params: Record<string, number>;
  /** VST3 only: the plug-in's own state (base64), restored before the parameters. */
  state?: string;
}

export type FxPresetSource = 'factory' | 'program' | 'user';

/** A preset as listed for a filter (without the VST3 state, which can be large). */
export interface FxPresetEntry {
  id: string;
  name: string;
  source: FxPresetSource;
}

/** Presets apply to filters with the same key: the built-in type, or "vst3:<class id>". */
export function presetKey(fx: Pick<Fx, 'type' | 'plugin'>): string {
  return fx.type === 'vst3' ? `vst3:${(fx.plugin?.cid ?? '').toUpperCase()}` : fx.type;
}

export function presetKeyOf(preset: Pick<FxPreset, 'type' | 'plugin'>): string {
  return preset.type === 'vst3' ? `vst3:${(preset.plugin?.cid ?? '').toUpperCase()}` : preset.type;
}

/** A short, order-independent fingerprint of parameter values, to notice edits after loading a preset. */
export function paramSignature(params: Record<string, number>): string {
  let h = 0x811c9dc5;
  for (const k of Object.keys(params).sort()) {
    const s = `${k}=${Math.round(params[k] * 1e5)};`;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** True when the filter's values no longer match the preset it was set from. */
export function presetEdited(fx: Fx): boolean {
  return !!fx.preset && fx.preset.sig !== paramSignature(fx.params);
}

/** A preset holding the filter's current settings. */
export function presetFromFx(fx: Fx, name: string): FxPreset {
  const clean = name.trim();
  if (!clean) throw new Error('Please give the preset a name.');
  if (fx.type !== 'vst3') return { name: clean, type: fx.type, params: { ...fx.params } };
  if (!fx.plugin) throw new Error('This filter has no plug-in.');
  return {
    name: clean,
    type: 'vst3',
    plugin: { cid: fx.plugin.cid, name: fx.plugin.name, vendor: fx.plugin.vendor },
    params: { ...fx.params },
    ...(fx.state ? { state: fx.state } : {}),
  };
}

/** Validates a preset read from disk (or sent by an agent). Null if it is not a usable preset. */
export function normalizePreset(raw: unknown, fallbackName = 'Preset'): FxPreset | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<FxPreset>;
  const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : fallbackName;
  const params: Record<string, number> = {};
  for (const [k, v] of Object.entries(r.params ?? {})) if (Number.isFinite(Number(v))) params[k] = Number(v);
  if (r.type === 'vst3') {
    if (!r.plugin || typeof r.plugin.cid !== 'string' || !r.plugin.cid) return null;
    for (const k of Object.keys(params)) params[k] = Math.min(1, Math.max(0, params[k]));
    return {
      name,
      type: 'vst3',
      plugin: { cid: r.plugin.cid, name: String(r.plugin.name ?? 'VST3'), vendor: String(r.plugin.vendor ?? '') },
      params,
      ...(typeof r.state === 'string' && r.state ? { state: r.state } : {}),
    };
  }
  if (!r.type || !FX_DEFINITIONS.some((d) => d.type === r.type)) return null;
  // clamp into range and fill missing values with defaults
  const fx = normalizeFx({ type: r.type, params });
  return fx ? { name, type: r.type, params: fx.params } : null;
}

/** The filter set to a preset (same id, on/off state and plug-in). */
export function applyPreset(fx: Fx, preset: FxPreset, ref: Omit<FxPresetRef, 'sig'>): Fx {
  if (presetKeyOf(preset) !== presetKey(fx)) throw new Error(`"${preset.name}" is a preset for a different filter.`);
  let params: Record<string, number>;
  if (fx.type === 'vst3') {
    // Only the values that get sliders; the state restores everything else.
    params = {};
    for (const info of visibleVstParams(fx.paramInfo ?? [])) {
      const key = String(info.id);
      const v = preset.params[key] ?? fx.params[key];
      if (v !== undefined) params[key] = v;
    }
  } else {
    params = { ...defaultParams(fx.type), ...preset.params };
  }
  const next: Fx = { ...fx, params, preset: { ...ref, sig: paramSignature(params) } };
  if (fx.type === 'vst3') {
    if (preset.state) next.state = preset.state;
    else delete next.state;
  }
  return normalizeFx(next) ?? next;
}

/** A filter set to one of a plug-in's own programs, from the values and state the host read back. */
export function applyProgram(fx: Fx, loaded: { state: string; values: Array<{ id: number; value: number }> }, ref: Omit<FxPresetRef, 'sig'>): Fx {
  const values = new Map(loaded.values.map((v) => [String(v.id), v.value]));
  const params: Record<string, number> = {};
  for (const info of visibleVstParams(fx.paramInfo ?? [])) {
    const key = String(info.id);
    const v = values.get(key) ?? fx.params[key];
    if (v !== undefined) params[key] = v;
  }
  return { ...fx, params, state: loaded.state, preset: { ...ref, sig: paramSignature(params) } };
}

// ---------------------------------------------------------------- factory presets

/** Presets that come with WavePod, per built-in filter type ("Default" is added for every type). */
const FACTORY: Partial<Record<FxType, Array<[string, Record<string, number>]>>> = {
  highpass: [
    ['Deep voice (60 Hz)', { freq: 60, slope: 12 }],
    ['Speech (80 Hz)', { freq: 80, slope: 12 }],
    ['Bright voice (100 Hz)', { freq: 100, slope: 24 }],
    ['Rumble cut (150 Hz)', { freq: 150, slope: 24 }],
  ],
  eq: [
    ['Warmth', { lsFreq: 150, lsGain: 3, p1Freq: 400, p1Gain: -2, p1Q: 1 }],
    ['Presence', { p2Freq: 3500, p2Gain: 3, p2Q: 0.8, hsFreq: 10000, hsGain: 2 }],
    ['Less boxy', { p1Freq: 350, p1Gain: -4, p1Q: 1.4 }],
    ['Less nasal', { p2Freq: 1000, p2Gain: -3, p2Q: 1.6 }],
  ],
  gate: [
    ['Gentle', { threshold: -55, range: -15, attack: 2, hold: 120, release: 300 }],
    ['Tight', { threshold: -45, range: -40, attack: 1, hold: 50, release: 120 }],
  ],
  compressor: [
    ['Gentle voice', { threshold: -18, ratio: 2, attack: 15, release: 150, knee: 6, makeup: 2 }],
    ['Broadcast', { threshold: -24, ratio: 4, attack: 5, release: 120, knee: 6, makeup: 6 }],
    ['Leveler', { threshold: -30, ratio: 3, attack: 30, release: 400, knee: 12, makeup: 8 }],
  ],
  deesser: [
    ['Lower voice', { freq: 5000, threshold: -30, maxReduction: 10, release: 60 }],
    ['Higher voice', { freq: 7000, threshold: -30, maxReduction: 10, release: 60 }],
    ['Strong', { freq: 6000, threshold: -38, maxReduction: 16, release: 80 }],
  ],
  limiter: [
    ['Podcast (−1 dB)', { ceiling: -1, release: 200 }],
    ['Streaming (−2 dB)', { ceiling: -2, release: 200 }],
  ],
  dynamics: [
    ['Louder (−16 LUFS)', { target: -16 }],
    ['Quieter (−23 LUFS)', { target: -23 }],
  ],
};

const FACTORY_PREFIX = 'factory:';

/** WavePod's own presets for a built-in filter type. */
export function factoryPresets(type: FxType): Array<{ id: string; preset: FxPreset }> {
  if (type === 'vst3') return [];
  const list: Array<[string, Record<string, number>]> = [['Default', {}], ...(FACTORY[type] ?? [])];
  return list.map(([n, params]) => ({ id: `${FACTORY_PREFIX}${type}/${n}`, preset: normalizePreset({ name: n, type, params })! }));
}

export function factoryPreset(id: string): FxPreset | null {
  if (!id.startsWith(FACTORY_PREFIX)) return null;
  const type = id.slice(FACTORY_PREFIX.length).split('/')[0] as FxType;
  if (!FX_DEFINITIONS.some((d) => d.type === type)) return null;
  return factoryPresets(type).find((p) => p.id === id)?.preset ?? null;
}

const PROGRAM_PREFIX = 'program:';
/** More programs than this are cut off (some plug-ins have thousands). */
export const MAX_PROGRAMS = 512;

export function programId(index: number): string {
  return `${PROGRAM_PREFIX}${index}`;
}

/** The program index of a "program:<n>" id, or null. */
export function programIndex(id: string): number | null {
  if (!id.startsWith(PROGRAM_PREFIX)) return null;
  const n = Number(id.slice(PROGRAM_PREFIX.length));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Normalized value of program `index` on the plug-in's program selector. */
export function programValue(param: Pick<VstParamInfo, 'steps'>, index: number): number {
  return param.steps > 0 ? Math.min(1, index / param.steps) : 0;
}

/** Finds a preset in a list by id or (case-insensitive) name, preferring the user's own. */
export function findPresetEntry(list: FxPresetEntry[], ref: string): FxPresetEntry | null {
  const byId = list.find((p) => p.id === ref);
  if (byId) return byId;
  const r = ref.trim().toLowerCase();
  const byName = list.filter((p) => p.name.toLowerCase() === r);
  return byName.find((p) => p.source === 'user') ?? byName[0] ?? null;
}
