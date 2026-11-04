// Voice effects for audio dramas: ready-made filter stacks built from factory presets, e.g.
// "Telephone" = Band-pass + Distortion + Compressor. Each filter keeps its preset name, so the
// FX panel shows where it came from and every value stays editable.
import type { Fx, FxType, Project } from '../../shared/types';
import { createFx, fxDefinition } from './definitions';
import { applyPreset, factoryPresets } from './presets';
import { insertFx, type FxTarget } from './stack';

export interface VoiceEffect {
  id: string;
  name: string;
  description: string;
  /** Filters top to bottom, each as [type, factory preset name]. */
  chain: Array<[FxType, string]>;
}

export const VOICE_EFFECTS: VoiceEffect[] = [
  {
    id: 'telephone',
    name: 'Telephone',
    description: 'A caller on a landline: narrow band, a little line grit, squeezed dynamics.',
    chain: [['bandpass', 'Telephone'], ['distortion', 'Phone grit'], ['compressor', 'Broadcast']],
  },
  {
    id: 'mobile-phone',
    name: 'Mobile phone',
    description: 'A digital phone call: band-limited and slightly crunchy.',
    chain: [['bandpass', 'Mobile phone'], ['distortion', 'Mobile codec'], ['compressor', 'Broadcast']],
  },
  {
    id: 'old-radio',
    name: 'Old radio',
    description: 'A voice from an old valve radio or a small transistor speaker.',
    chain: [['bandpass', 'AM radio'], ['distortion', 'Old radio'], ['compressor', 'Broadcast']],
  },
  {
    id: 'walkie-talkie',
    name: 'Walkie-talkie',
    description: 'Police, military or kids\' radio: very narrow and hard-clipped.',
    chain: [['bandpass', 'Walkie-talkie'], ['distortion', 'Walkie-talkie'], ['compressor', 'Broadcast']],
  },
  {
    id: 'megaphone',
    name: 'Megaphone',
    description: 'An overdriven horn speaker, outdoors.',
    chain: [['bandpass', 'Megaphone'], ['distortion', 'Megaphone'], ['echo', 'Slapback']],
  },
  {
    id: 'next-room',
    name: 'Next room',
    description: 'Someone talking behind a wall or a closed door.',
    chain: [['bandpass', 'Next room'], ['reverb', 'Next room']],
  },
  {
    id: 'outdoor',
    name: 'Outdoor',
    description: 'Out in the open: a little less bass and one faint reflection instead of a room. Add an ambience track (wind, birds, traffic) under it.',
    chain: [['highpass', 'Higher voice (100 Hz)'], ['echo', 'Outdoor']],
  },
  {
    id: 'distant',
    name: 'Far away',
    description: 'A voice calling from a distance outdoors.',
    chain: [['bandpass', 'Distant voice'], ['echo', 'Mountains']],
  },
  {
    id: 'bathroom',
    name: 'Bathroom',
    description: 'A small tiled room.',
    chain: [['reverb', 'Bathroom']],
  },
  {
    id: 'cathedral',
    name: 'Church',
    description: 'A large stone church or hall.',
    chain: [['reverb', 'Cathedral']],
  },
  {
    id: 'cave',
    name: 'Cave',
    description: 'A huge, dark cave or tunnel.',
    chain: [['highpass', 'Deep voice (60 Hz)'], ['reverb', 'Cave']],
  },
  {
    id: 'underwater',
    name: 'Underwater',
    description: 'Heavily muffled and boomy.',
    chain: [['bandpass', 'Underwater'], ['reverb', 'Small room']],
  },
  {
    id: 'flashback',
    name: 'Flashback / dream',
    description: 'Memories and inner voices: soft repeats and a washed-out room.',
    chain: [['bandpass', 'Distant voice'], ['echo', 'Dream'], ['reverb', 'Dream']],
  },
];

export function findVoiceEffect(ref: string): VoiceEffect | null {
  const r = ref.trim().toLowerCase();
  return VOICE_EFFECTS.find((e) => e.id === r || e.name.toLowerCase() === r) ?? null;
}

/** The filters of a voice effect, each set from its factory preset. */
export function voiceEffectFilters(effect: VoiceEffect): Fx[] {
  return effect.chain.map(([type, presetName]) => {
    const entry = factoryPresets(type).find((p) => p.preset.name === presetName);
    if (!entry) throw new Error(`Voice effect "${effect.name}": ${fxDefinition(type).name} has no preset "${presetName}".`);
    return applyPreset(createFx(type), entry.preset, { id: entry.id, name: presetName });
  });
}

/** Appends a voice effect's filters to a stack. */
export function addVoiceEffect(project: Project, target: FxTarget, effect: VoiceEffect): { project: Project; filters: Fx[] } {
  const filters = voiceEffectFilters(effect);
  return { project: filters.reduce((p, fx) => insertFx(p, target, fx), project), filters };
}
