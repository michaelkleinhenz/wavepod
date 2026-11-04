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
  /** Factory presets: what the preset is for. */
  description?: string;
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

type Factory = [name: string, description: string, params: Record<string, number>];

/**
 * Presets that come with WavePod, per built-in filter type, tuned for speech. Values left out keep
 * the filter's default. "Default" (all defaults) is added in front of every list.
 */
const FACTORY: Partial<Record<FxType, Factory[]>> = {
  highpass: [
    ['Deep voice (60 Hz)', 'For low male voices: removes only rumble below the voice.', { freq: 60, slope: 12 }],
    ['Steep speech cut (80 Hz)', 'Like Default, but steeper: cleaner low end for most voices.', { freq: 80, slope: 24 }],
    ['Higher voice (100 Hz)', 'For higher voices; a steeper cut keeps the low end clean.', { freq: 100, slope: 24 }],
    ['Handling noise (120 Hz)', 'Handheld or lapel mics, desk bumps and plosive thumps.', { freq: 120, slope: 24 }],
    ['Remote guest (150 Hz)', 'Phone, laptop or headset audio, which has no useful lows anyway.', { freq: 150, slope: 24 }],
    ['Music & jingles (30 Hz)', 'Only removes subsonic rumble, keeps the bass of music.', { freq: 30, slope: 12 }],
  ],
  eq: [
    ['Warmth', 'A little more body for thin voices.', { lsFreq: 150, lsGain: 3, p1Freq: 400, p1Gain: -1.5, p1Q: 1 }],
    ['Presence', 'Brings a voice forward in the mix.', { p2Freq: 4000, p2Gain: 3, p2Q: 0.8, hsFreq: 10000, hsGain: 2 }],
    ['Clarity for dynamic mics', 'Opens up dull dynamic mics (SM7B, RE20 and similar).', { p1Freq: 250, p1Gain: -2, p1Q: 1, p2Freq: 4500, p2Gain: 4, p2Q: 0.7, hsFreq: 12000, hsGain: 3 }],
    ['Proximity effect', 'Tames the boom of speaking very close to the mic.', { lsFreq: 120, lsGain: -4, p1Freq: 200, p1Gain: -2, p1Q: 1 }],
    ['Less boxy', 'Cuts the cardboard sound of small, untreated rooms.', { p1Freq: 350, p1Gain: -4, p1Q: 1.4 }],
    ['Less nasal', 'Cuts the honk around 1 kHz.', { p2Freq: 1000, p2Gain: -3, p2Q: 1.6 }],
    ['Remote guest', 'Laptop or headset audio: less mud and hiss, more intelligibility.', { lsFreq: 150, lsGain: -3, p1Freq: 500, p1Gain: -2, p1Q: 1, p2Freq: 3000, p2Gain: 3, p2Q: 1, hsFreq: 8000, hsGain: -2 }],
    ['Air', 'A gentle high shelf for sparkle.', { hsFreq: 12000, hsGain: 4 }],
  ],
  gate: [
    ['Gentle', 'Quiet room: lowers breathing and room tone a little, never chops words.', { threshold: -55, range: -12, attack: 2, hold: 150, release: 300 }],
    ['Medium', 'A clear drop between phrases.', { threshold: -48, range: -25, attack: 2, hold: 100, release: 200 }],
    ['Tight', 'Noisy room: closes fast and far.', { threshold: -40, range: -40, attack: 1, hold: 60, release: 120 }],
    ['Several mics in one room', 'Holds back the other speakers bleeding into this mic.', { threshold: -42, range: -20, attack: 1, hold: 200, release: 350 }],
  ],
  compressor: [
    ['Gentle voice', 'Light levelling that keeps the voice natural.', { threshold: -18, ratio: 2, attack: 15, release: 150, knee: 6, makeup: 2 }],
    ['Spoken word', 'Even, present speech for most podcasts.', { threshold: -22, ratio: 3, attack: 10, release: 150, knee: 6, makeup: 4 }],
    ['Broadcast', 'Dense and upfront, radio style.', { threshold: -24, ratio: 4, attack: 5, release: 120, knee: 6, makeup: 6 }],
    ['Leveler', 'Slow: rides the volume of speakers who drift closer and further away.', { threshold: -30, ratio: 3, attack: 30, release: 400, knee: 12, makeup: 8 }],
    ['Peak control', 'Only catches laughs and shouts.', { threshold: -10, ratio: 8, attack: 1, release: 80, knee: 2, makeup: 0 }],
    ['Music bed', 'Smooths jingles and music beds without pumping.', { threshold: -20, ratio: 2, attack: 30, release: 300, knee: 10, makeup: 2 }],
  ],
  deesser: [
    ['Gentle', 'Takes the edge off without lisping.', { freq: 6000, threshold: -26, maxReduction: 6, release: 60 }],
    ['Lower voice', 'Sibilance of lower voices sits around 5 kHz.', { freq: 5000, threshold: -30, maxReduction: 10, release: 60 }],
    ['Higher voice', 'Sibilance of higher voices sits around 7 kHz.', { freq: 7000, threshold: -30, maxReduction: 10, release: 60 }],
    ['Strong', 'For very sharp "s" sounds or bright mics.', { freq: 6500, threshold: -38, maxReduction: 16, release: 80 }],
  ],
  limiter: [
    ['Transparent (−1 dB)', 'Podcast ceiling with a slow release: no audible pumping on speech.', { ceiling: -1, release: 500 }],
    ['Loud master (−1 dB)', 'Fast release for a denser, louder master.', { ceiling: -1, release: 50 }],
    ['Lossy safe (−2 dB)', 'Extra headroom for low bitrates and loud masters.', { ceiling: -2, release: 200 }],
    ['Brickwall (−0.3 dB)', 'For WAV or broadcast deliveries.', { ceiling: -0.3, release: 100 }],
    ['Track peaks (−6 dB)', 'On a single track: catches peaks and leaves room for the mix.', { ceiling: -6, release: 150 }],
  ],
  denoise: [
    ['Light hiss', 'Quiet preamp or mic hiss: barely touches the voice.', { reduction: 6, threshold: 4 }],
    ['Computer fan', 'Steady fan or air-conditioning noise.', { reduction: 15, threshold: 7 }],
    ['Noisy room', 'Strong, steady background noise; may colour the voice slightly.', { reduction: 22, threshold: 9 }],
    ['Remote guest', 'Laptop or headset recordings with a noise floor.', { reduction: 18, threshold: 8 }],
  ],
  reverb: [
    ['Small room', 'A touch of space for a voice that sounds too close and dry.', { size: 25, damping: 60, mix: 8, predelay: 5, width: 70 }],
    ['Studio', 'A natural, unobtrusive room.', { size: 40, damping: 55, mix: 12, predelay: 10, width: 100 }],
    ['Hall', 'Large and open, for jingles and intros.', { size: 80, damping: 40, mix: 25, predelay: 25, width: 100 }],
    ['Phone / flashback', 'Narrow and boxy, for a sound effect on a voice.', { size: 15, damping: 80, mix: 30, predelay: 0, width: 20 }],
    ['Music bed', 'Softens and widens a dry music bed.', { size: 60, damping: 50, mix: 20, predelay: 15, width: 100 }],
  ],
  dynamics: [
    ['Podcast (−16 LUFS)', 'Loudness most podcast apps expect.', { target: -16 }],
    ['Spoken word (−19 LUFS)', 'A bit quieter, more dynamic.', { target: -19 }],
    ['EBU R128 (−23 LUFS)', 'Broadcast loudness.', { target: -23 }],
    ['Quiet studio', 'Treated room and a good mic: lets soft speech through.', { noiseFloor: -50, noiseGate: 30 }],
    ['Noisy room', 'Untreated room or background noise: mutes more of it.', { noiseFloor: -32, noiseGate: 20 }],
    ['Keep breaths', 'Gates less, for a more natural, intimate sound.', { noiseFloor: -45, noiseGate: 50 }],
  ],
};

const FACTORY_PREFIX = 'factory:';

/** WavePod's own presets for a built-in filter type. */
export function factoryPresets(type: FxType): Array<{ id: string; preset: FxPreset; description: string }> {
  if (type === 'vst3') return [];
  const list: Factory[] = [['Default', 'The filter\'s default settings.', {}], ...(FACTORY[type] ?? [])];
  return list.map(([n, description, params]) => ({ id: `${FACTORY_PREFIX}${type}/${n}`, description, preset: normalizePreset({ name: n, type, params })! }));
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
