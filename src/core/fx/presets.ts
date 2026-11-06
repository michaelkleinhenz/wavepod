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
    ['Full mute', 'Silence between phrases: opens just before each word, mutes completely when closed.', { threshold: -30, range: -80, attack: 10, hold: 250, release: 150, preopen: 3, hysteresis: 0 }],
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
    ['Bathroom', 'Small, hard and tiled: bright, short reflections.', { size: 30, damping: 10, mix: 28, predelay: 2, width: 60 }],
    ['Next room', 'Heard through a doorway: dull, mostly room. Put it after a Band-pass "Next room".', { size: 35, damping: 90, mix: 50, predelay: 5, width: 40 }],
    ['Cathedral', 'Stone church: a long, open tail.', { size: 100, damping: 30, mix: 40, predelay: 40, width: 100 }],
    ['Cave', 'Huge and dark, with a late, heavy tail.', { size: 92, damping: 75, mix: 45, predelay: 60, width: 100 }],
    ['Dream', 'Soft and washed out, for memories and inner voices.', { size: 85, damping: 60, mix: 45, predelay: 20, width: 100 }],
  ],
  bandpass: [
    ['Telephone', 'Classic landline band (300 Hz to 3.4 kHz).', { lowCut: 300, highCut: 3400, slope: 24, gain: 3 }],
    ['Old telephone', 'Narrower and thinner, like an old handset.', { lowCut: 450, highCut: 2800, slope: 24, gain: 5 }],
    ['Mobile phone', 'A little wider than a landline; pair with Distortion "Mobile codec".', { lowCut: 250, highCut: 4000, slope: 24, gain: 3 }],
    ['Walkie-talkie', 'Very narrow and honky.', { lowCut: 500, highCut: 2500, slope: 24, gain: 6 }],
    ['AM radio', 'Old radio or a small transistor speaker.', { lowCut: 150, highCut: 4500, slope: 12, gain: 2 }],
    ['Megaphone', 'Loud, nasal horn.', { lowCut: 600, highCut: 4000, slope: 24, gain: 4 }],
    ['Next room', 'Behind a wall or a closed door: only the lows come through.', { lowCut: 20, highCut: 700, slope: 24, gain: 0 }],
    ['Underwater', 'Heavily muffled.', { lowCut: 20, highCut: 400, slope: 24, gain: 2 }],
    ['Distant voice', 'Someone further away: less bass, less air.', { lowCut: 200, highCut: 6000, slope: 12, gain: 0 }],
  ],
  distortion: [
    ['Warm saturation', 'Subtle analogue warmth, half wet.', { drive: 8, mode: 0, mix: 50, tone: 16000 }],
    ['Phone grit', 'The light crackle of a telephone line.', { drive: 14, mode: 0, tone: 3800 }],
    ['Mobile codec', 'Digital phone call: 8 kHz sample rate, fewer bits.', { drive: 6, mode: 0, bits: 9, rate: 8000, tone: 3600 }],
    ['Old radio', 'Saturated valve radio.', { drive: 16, mode: 0, tone: 5000 }],
    ['Walkie-talkie', 'Hard clipping and a harsh top.', { drive: 24, mode: 1, tone: 3000 }],
    ['Megaphone', 'Overdriven horn speaker.', { drive: 22, mode: 1, tone: 4500 }],
    ['Broken speaker', 'Torn cone: fuzzy and rattling.', { drive: 28, mode: 2, tone: 2500 }],
    ['Lo-fi digital', 'Crunchy, cheap digital sound.', { drive: 0, mode: 0, bits: 6, rate: 11025, tone: 5000 }],
  ],
  echo: [
    ['Outdoor', 'Open field: one faint, dull reflection takes away the "studio" sound.', { time: 90, feedback: 0, mix: 10, highCut: 3000, spread: 30 }],
    ['Slapback', 'A single clear repeat, like a building across the street.', { time: 130, feedback: 0, mix: 22, highCut: 7000, spread: 0 }],
    ['Mountains', 'Calling across a valley: long, fading repeats.', { time: 480, feedback: 40, mix: 30, highCut: 2800, spread: 60 }],
    ['Stairwell', 'Fast flutter between hard walls.', { time: 45, feedback: 55, mix: 18, highCut: 5000, spread: 20 }],
    ['Stadium PA', 'Announcer bouncing off the stands.', { time: 260, feedback: 25, mix: 28, highCut: 3500, spread: 50 }],
    ['Dream', 'Long, soft ping-pong repeats for memories and inner voices.', { time: 380, feedback: 55, mix: 35, highCut: 2500, spread: 100 }],
  ],
  space: [
    ['Close to the mic', 'Intimate and close: a little proximity bass, almost no room. Narrators, inner voices.', { distance: 0.4, size: 20, damping: 60, early: 10, room: 5, predelay: 2, width: 60 }],
    ['Living room', 'A furnished room: soft and short.', { size: 35, damping: 75, early: 30, room: 14, predelay: 6, width: 80 }],
    ['Bedroom', 'Small and soft: bed, curtains, carpet.', { size: 25, damping: 85, early: 22, room: 8, predelay: 4, width: 70 }],
    ['Small kitchen', 'Tiles, cupboards and a window: small, bright and a little clattery.', { size: 28, damping: 25, early: 45, room: 18, predelay: 3, width: 70 }],
    ['Bathroom', 'Small, hard and tiled: bright, dense reflections.', { size: 30, damping: 10, early: 55, room: 28, predelay: 2, width: 60 }],
    ['Car', 'Inside a car: tiny, dead and boxy.', { size: 4, damping: 90, early: 55, room: 6, predelay: 0, width: 40 }],
    ['Office', 'A plain office or meeting room.', { size: 40, damping: 55, early: 30, room: 15, predelay: 8, width: 90 }],
    ['Classroom', 'Hard walls and a high ceiling: a little echoey.', { size: 55, damping: 40, early: 40, room: 22, predelay: 12, width: 100 }],
    ['Stairwell', 'Concrete stairs: hard, long and fluttering.', { size: 70, damping: 15, early: 55, room: 32, predelay: 10, width: 70 }],
    ['Basement', 'Low and dull, bare concrete.', { size: 45, damping: 70, early: 45, room: 22, predelay: 6, width: 60 }],
    ['Garage / warehouse', 'Big, empty and hard.', { size: 80, damping: 30, early: 35, room: 32, predelay: 25, width: 100 }],
    ['Church', 'A stone church: a long, open tail.', { size: 100, damping: 30, early: 25, room: 42, predelay: 40, width: 100 }],
    ['Concert hall', 'Large and warm.', { size: 90, damping: 50, early: 30, room: 32, predelay: 30, width: 100 }],
    ['Cave', 'Huge and dark, with a heavy tail.', { size: 95, damping: 70, early: 40, room: 46, predelay: 55, width: 100 }],
    ['Tunnel', 'Long, hard and metallic.', { size: 85, damping: 20, early: 60, room: 38, predelay: 20, width: 50 }],
    ['Forest', 'Outdoors among trees: no walls, only a soft scatter of reflections.', { size: 60, damping: 85, early: 18, room: 7, predelay: 18, width: 100 }],
    ['Open field', 'Out in the open: almost dry, a little ground reflection.', { size: 15, damping: 80, early: 8, room: 2, predelay: 4, width: 100 }],
    ['Street', 'Between houses: a few clear reflections off the facades.', { size: 70, damping: 45, early: 30, room: 6, predelay: 25, width: 100 }],
    ['Across the room', 'Living room, the speaker a few steps away.', { distance: 4, size: 35, damping: 75, early: 30, room: 14, predelay: 6, width: 80 }],
    ['Far away outdoors', 'Someone calling from a distance in the open.', { distance: 25, size: 20, damping: 80, early: 10, room: 3, predelay: 6, width: 100 }],
  ],
  pitch: [
    ['Slightly lower (−2)', 'A touch deeper and bigger, still natural.', { semitones: -2 }],
    ['Slightly higher (+2)', 'A touch younger and smaller.', { semitones: 2 }],
    ['Giant (−7)', 'A huge creature or monster.', { semitones: -7, window: 70 }],
    ['Demon (−12, doubled)', 'An octave down mixed with the real voice: possessed.', { semitones: -12, mix: 60, window: 80 }],
    ['Small creature (+5)', 'Goblins, gnomes, fairies.', { semitones: 5, window: 40 }],
    ['Child-like (+4)', 'Higher and smaller; combine with an EQ that takes out the low body.', { semitones: 4, window: 40 }],
    ['Chipmunk (+12)', 'Cartoon squeak.', { semitones: 12, window: 30 }],
    ['Alien detune (+7, doubled)', 'A fifth above, mixed with the dry voice.', { semitones: 7, mix: 45, window: 50 }],
  ],
  ringmod: [
    ['Robot', 'The classic metallic robot voice.', { freq: 40, shape: 0, mix: 100 }],
    ['Dalek-style robot', 'Harsher and buzzier.', { freq: 30, shape: 2, mix: 100 }],
    ['Subtle machine', 'Half human, half machine.', { freq: 60, shape: 0, mix: 45 }],
    ['Alien', 'Bell-like and strange.', { freq: 450, shape: 0, mix: 70 }],
    ['Broken robot', 'Wobbling tone, a failing machine.', { freq: 55, shape: 1, mix: 100, wobble: 40, wobbleRate: 3 }],
  ],
  chorus: [
    ['Chorus', 'Gently thickened, like two takes at once.', { delay: 18, depth: 35, rate: 0.6, feedback: 0, voices: 2, mix: 40 }],
    ['Thick chorus', 'A crowd of one: rich and wide.', { delay: 25, depth: 50, rate: 0.4, feedback: 0, voices: 4, mix: 55 }],
    ['Magic', 'Shimmering and otherworldly: fairies, spirits, spells.', { delay: 12, depth: 60, rate: 1.2, feedback: 30, voices: 3, mix: 55 }],
    ['Flanger', 'The classic sweeping whoosh.', { delay: 2.5, depth: 80, rate: 0.25, feedback: 60, voices: 1, mix: 50 }],
    ['Jet flanger', 'Strong, metallic sweep: teleports, time travel.', { delay: 3, depth: 90, rate: 0.12, feedback: 85, voices: 1, mix: 50 }],
    ['Dream', 'Slow, soft wavering for memories and dreams.', { delay: 8, depth: 70, rate: 0.15, feedback: 40, voices: 2, mix: 45 }],
    ['Vibrato / ghost', 'The voice itself wavers in pitch.', { delay: 5, depth: 40, rate: 5, feedback: 0, voices: 1, mix: 100, width: 30 }],
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
