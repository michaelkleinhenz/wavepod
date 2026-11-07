// The filters WavePod offers, their parameters and defaults. Used by the UI and the processors.
import type { Fx, FxType, ImpulseRef } from '../../shared/types';
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
  /** Earlier names, still accepted when a filter is looked up by name (e.g. by MCP clients). */
  aliases?: string[];
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
    description:
      'Turns the track down while nobody speaks into it (room noise, other speakers bleeding in). Pre-open looks ahead so the gate is already open when a word starts; it adds that much latency, which WavePod compensates. Hysteresis is how far below the threshold the level has to fall before the gate closes again.',
    params: [
      db('threshold', 'Threshold', -50, -80, -10),
      db('range', 'Reduction', -30, -80, 0),
      ms('attack', 'Attack', 2, 0.1, 50, 0.1),
      ms('hold', 'Hold', 80, 0, 500),
      ms('release', 'Release', 200, 10, 2000),
      ms('preopen', 'Pre-open', 0, 0, 50, 0.1),
      db('hysteresis', 'Hysteresis', 4, 0, 12),
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
    name: 'Dynamics',
    aliases: ['Ultraschall Dynamics'],
    description:
      'Brings a voice to an even target loudness: quiet speech is raised, loud speech is held back, and everything below the noise gate is muted. Adds 100 ms of latency, which WavePod compensates.',
    params: [
      { key: 'target', label: 'Target', min: -25, max: -14, step: 0.1, default: -20, unit: 'LUFS' },
      db('noiseFloor', 'Noise floor', -40, -70, -20, 0.1),
      db('noiseGate', 'Noise gate', 30, 16, 88, 0.1),
    ],
  },
  {
    type: 'denoise',
    name: 'Noise reduction',
    aliases: ['Denoise'],
    description:
      'Turns down steady background noise (hiss, hum, fans, air conditioning) between and under the words. It learns the noise by itself from the quiet moments. Adds about 21 ms of latency, which WavePod compensates.',
    params: [
      db('reduction', 'Reduction', 12, 0, 30),
      db('threshold', 'Sensitivity', 6, 0, 15),
    ],
  },
  {
    type: 'reverb',
    name: 'Reverb',
    description: 'Adds room to a dry signal, e.g. a jingle bed or a voice that sounds too close.',
    params: [
      { key: 'size', label: 'Room size', min: 0, max: 100, step: 1, default: 50, unit: '%' },
      { key: 'decay', label: 'Decay (RT60)', min: 0.1, max: 8, step: 0.01, default: 0.8, unit: 's', log: true },
      { key: 'damping', label: 'Damping', min: 0, max: 100, step: 1, default: 50, unit: '%' },
      { key: 'mix', label: 'Mix', min: 0, max: 100, step: 1, default: 15, unit: '%' },
      ms('predelay', 'Pre-delay', 10, 0, 200),
      { key: 'width', label: 'Width', min: 0, max: 100, step: 1, default: 100, unit: '%' },
    ],
  },
  {
    type: 'bandpass',
    name: 'Band-pass',
    aliases: ['Low-pass', 'Lowpass', 'Telephone filter'],
    description:
      'Keeps only the frequencies between the low cut and the high cut. The basis of telephone, radio and walkie-talkie voices; with a low high cut it muffles a voice, as if behind a wall or under water.',
    params: [
      hz('lowCut', 'Low cut', 300, 20, 2000),
      hz('highCut', 'High cut', 3400, 200, 20000),
      { key: 'slope', label: 'Slope', min: 12, max: 24, step: 12, default: 24, unit: 'dB/oct', options: [{ value: 12, label: '12 dB/oct' }, { value: 24, label: '24 dB/oct' }] },
      db('gain', 'Output gain', 0, -12, 18),
    ],
  },
  {
    type: 'distortion',
    name: 'Distortion',
    aliases: ['Saturation', 'Bit crusher', 'Lo-fi'],
    description:
      'Adds grit: saturation, clipping or fuzz, optionally with fewer bits and a lower sample rate for a cheap digital sound. For phones, old radios, walkie-talkies, megaphones and broken speakers. The level is matched roughly to the input, so Drive changes the sound more than the loudness.',
    params: [
      db('drive', 'Drive', 12, 0, 40),
      { key: 'mode', label: 'Character', min: 0, max: 2, step: 1, default: 0, options: [{ value: 0, label: 'Soft (saturation)' }, { value: 1, label: 'Hard (clipping)' }, { value: 2, label: 'Fuzz (broken speaker)' }] },
      { key: 'bits', label: 'Bit depth', min: 2, max: 16, step: 1, default: 16, unit: 'bit' },
      hz('rate', 'Sample rate', 48000, 2000, 48000),
      hz('tone', 'Tone (high cut)', 12000, 1000, 20000),
      { key: 'mix', label: 'Mix', min: 0, max: 100, step: 1, default: 100, unit: '%' },
      db('output', 'Output gain', 0, -18, 12),
    ],
  },
  {
    type: 'echo',
    name: 'Echo',
    aliases: ['Delay'],
    description:
      'Repeats the sound after a delay, each repeat a little duller. A single short reflection makes a voice sound outdoors; long repeats give mountains, stadiums and dream sequences.',
    params: [
      ms('time', 'Delay', 300, 10, 2000),
      { key: 'feedback', label: 'Repeats', min: 0, max: 90, step: 1, default: 30, unit: '%' },
      { key: 'mix', label: 'Mix', min: 0, max: 100, step: 1, default: 25, unit: '%' },
      hz('highCut', 'Repeat tone', 5000, 500, 20000),
      { key: 'spread', label: 'Ping-pong', min: 0, max: 100, step: 1, default: 0, unit: '%' },
    ],
  },
  {
    type: 'space',
    name: 'Room & distance',
    aliases: ['Space', 'Room', 'Distance'],
    description:
      'Puts a voice into a place (kitchen, car, church, forest…) and moves it closer or further away. Distance turns the voice down, takes away highs and bass and lets the room take over, as if the speaker walked away; close up it adds the bass of speaking right into the mic. Pick a place from the presets, then set the distance.',
    params: [
      { key: 'distance', label: 'Distance', min: 0.3, max: 50, step: 0.1, default: 1, unit: 'm', log: true },
      { key: 'size', label: 'Room size', min: 0, max: 100, step: 1, default: 40, unit: '%' },
      { key: 'decay', label: 'Decay (RT60)', min: 0.05, max: 8, step: 0.01, default: 0.5, unit: 's', log: true },
      { key: 'damping', label: 'Soft surfaces', min: 0, max: 100, step: 1, default: 50, unit: '%' },
      { key: 'early', label: 'Reflections', min: 0, max: 100, step: 1, default: 20, unit: '%' },
      { key: 'room', label: 'Reverb', min: 0, max: 100, step: 1, default: 12, unit: '%' },
      ms('predelay', 'Pre-delay', 10, 0, 100),
      { key: 'width', label: 'Width', min: 0, max: 100, step: 1, default: 100, unit: '%' },
    ],
  },
  {
    type: 'convolution',
    name: 'Convolution reverb',
    aliases: ['Impulse response', 'IR reverb', 'Convolution', 'IR'],
    description:
      'Puts the sound into a real room, hall, car or church by convolving it with an impulse response (IR): a WAV recording of how that place answers a single click. Load an IR file, then set how much of the room you hear. Adds about 21 ms of latency, which WavePod compensates.',
    params: [
      db('dry', 'Dry', 0, -60, 0),
      db('wet', 'Wet (room)', -12, -60, 12),
      ms('predelay', 'Pre-delay', 0, 0, 200),
      { key: 'length', label: 'Length', min: 5, max: 100, step: 1, default: 100, unit: '%' },
      hz('lowCut', 'Room low cut', 20, 20, 2000),
      hz('highCut', 'Room high cut', 20000, 1000, 20000),
      { key: 'width', label: 'Width', min: 0, max: 100, step: 1, default: 100, unit: '%' },
    ],
  },
  {
    type: 'pitch',
    name: 'Pitch shift',
    aliases: ['Pitch shifter', 'Pitch'],
    description:
      'Makes a voice higher or lower without changing its speed: down for giants, monsters and demons, up for small creatures, goblins and chipmunks. The voice character moves with the pitch, so up sounds smaller and down bigger. Mix it with the dry voice for a doubled, unnatural sound. Adds half the grain size of latency, which WavePod compensates.',
    params: [
      { key: 'semitones', label: 'Pitch', min: -24, max: 24, step: 1, default: 0, unit: 'semitones' },
      { key: 'cents', label: 'Fine', min: -100, max: 100, step: 1, default: 0, unit: 'cents' },
      { key: 'mix', label: 'Mix', min: 0, max: 100, step: 1, default: 100, unit: '%' },
      ms('window', 'Grain size', 50, 10, 200),
    ],
  },
  {
    type: 'ringmod',
    name: 'Ring modulator',
    aliases: ['Robot', 'Ring mod'],
    description:
      'Multiplies the voice with a tone, which makes it metallic and inhuman: around 30–60 Hz the classic robot, higher an alien or bell-like voice. Wobble moves the tone up and down for a broken machine.',
    params: [
      hz('freq', 'Tone', 50, 5, 2000),
      { key: 'shape', label: 'Waveform', min: 0, max: 2, step: 1, default: 0, options: [{ value: 0, label: 'Sine (smooth)' }, { value: 1, label: 'Square (harsh)' }, { value: 2, label: 'Triangle' }] },
      { key: 'mix', label: 'Mix', min: 0, max: 100, step: 1, default: 100, unit: '%' },
      { key: 'wobble', label: 'Wobble', min: 0, max: 100, step: 1, default: 0, unit: '%' },
      { key: 'wobbleRate', label: 'Wobble speed', min: 0, max: 20, step: 0.1, default: 2, unit: 'Hz' },
    ],
  },
  {
    type: 'chorus',
    name: 'Chorus / flanger',
    aliases: ['Chorus', 'Flanger', 'Vibrato', 'Modulation'],
    description:
      'A short delay that slowly sweeps back and forth. Chorus (10–30 ms, several voices) thickens a voice into something magical or many; flanger (1–5 ms with feedback) gives the jet "whoosh" of dreams, teleports and time travel; at 100 % mix it becomes a wavering vibrato, good for ghosts.',
    params: [
      ms('delay', 'Delay', 15, 0.3, 50, 0.1),
      { key: 'depth', label: 'Depth', min: 0, max: 100, step: 1, default: 40, unit: '%' },
      { key: 'rate', label: 'Speed', min: 0.01, max: 10, step: 0.01, default: 0.5, unit: 'Hz', log: true },
      { key: 'feedback', label: 'Feedback', min: -95, max: 95, step: 1, default: 0, unit: '%' },
      { key: 'voices', label: 'Voices', min: 1, max: 4, step: 1, default: 2 },
      { key: 'mix', label: 'Mix', min: 0, max: 100, step: 1, default: 50, unit: '%' },
      { key: 'width', label: 'Width', min: 0, max: 100, step: 1, default: 100, unit: '%' },
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
      ...presetRef(fx),
    };
  }
  if (!fx.type || !FX_DEFINITIONS.some((d) => d.type === fx.type)) return null;
  const def = fxDefinition(fx.type);
  const params: Record<string, number> = {};
  for (const p of def.params) {
    const v = Number(fx.params?.[p.key]);
    params[p.key] = Number.isFinite(v) ? Math.min(p.max, Math.max(p.min, v)) : p.default;
  }
  return { id: fx.id ?? uid('fx'), type: fx.type, enabled: fx.enabled !== false, params, ...presetRef(fx), ...(fx.type === 'convolution' ? irRef(fx.ir) : {}) };
}

/** A valid impulse response reference, or nothing. */
export function irRef(ir: unknown): Pick<Fx, 'ir'> {
  const r = ir as Partial<ImpulseRef> | undefined;
  return r && typeof r.file === 'string' && r.file ? { ir: { file: r.file, name: typeof r.name === 'string' && r.name ? r.name : r.file.replace(/\.[^.]+$/, '') } } : {};
}

function presetRef(fx: Partial<Fx>): Pick<Fx, 'preset'> {
  const r = fx.preset;
  return r && typeof r.id === 'string' && typeof r.name === 'string' && typeof r.sig === 'string' ? { preset: { id: r.id, name: r.name, sig: r.sig } } : {};
}
