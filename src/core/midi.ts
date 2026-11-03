// MIDI controller mapping: parsing incoming messages and matching them against learned bindings.
// Pure logic, shared by the renderer (Web MIDI input) and the main process (settings validation).
import type { MidiAction, MidiBinding, MidiMessageType, MidiSettings, MidiTrigger } from '../shared/types';

export type { MidiAction, MidiBinding, MidiMessageType, MidiSettings, MidiTrigger };

export const MIDI_ACTIONS: Array<{ action: MidiAction; label: string }> = [
  { action: 'record-start', label: 'Start recording' },
  { action: 'record-stop', label: 'Stop recording' },
  { action: 'chapter-marker', label: 'Chapter marker' },
  { action: 'edit-marker', label: 'Edit marker' },
  { action: 'record-toggle', label: 'Record on / off' },
  { action: 'play-toggle', label: 'Play / Pause' },
  { action: 'stop', label: 'Stop' },
  { action: 'prepare-for-editing', label: 'Prepare for editing' },
  ...([1, 2, 3, 4, 5, 6] as const).map((n) => ({ action: `cough-${n}` as MidiAction, label: `Cough button, speaker ${n} (hold)` })),
  ...([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((n) => ({ action: `sound-${n}` as MidiAction, label: `Soundboard ${n}` })),
  { action: 'sounds-stop', label: 'Stop all sounds' },
  { action: 'preshow-toggle', label: 'Pre-show on / off (only the soundboard is heard)' },
];

/** Actions that act on release too (held buttons). */
export function isHoldAction(action: MidiAction): boolean {
  return action.startsWith('cough-');
}

export function defaultMidiSettings(): MidiSettings {
  return { enabled: true, bindings: [] };
}

/** A decoded channel message. `value` is velocity (note), controller value (cc) or 0 (program). */
export interface MidiEvent {
  type: MidiMessageType;
  channel: number;
  number: number;
  value: number;
  /** True for note-on, a controller going to ≥ 64 or a program change; false for note-off / controller release. */
  pressed: boolean;
}

/** Decodes the channel messages WavePod can map. Everything else (clock, sysex, pitch bend…) returns null. */
export function parseMidiMessage(data: ArrayLike<number>): MidiEvent | null {
  if (!data || data.length < 2) return null;
  const status = data[0];
  if (status < 0x80 || status >= 0xf0) return null;
  const kind = status & 0xf0;
  const channel = status & 0x0f;
  const number = data[1] & 0x7f;
  const value = (data[2] ?? 0) & 0x7f;
  switch (kind) {
    case 0x90:
      if (data.length < 3) return null;
      return { type: 'note', channel, number, value, pressed: value > 0 };
    case 0x80:
      if (data.length < 3) return null;
      return { type: 'note', channel, number, value, pressed: false };
    case 0xb0:
      if (data.length < 3) return null;
      return { type: 'cc', channel, number, value, pressed: value >= 64 };
    case 0xc0:
      return { type: 'program', channel, number, value: 0, pressed: true };
    default:
      return null;
  }
}

/** Windows prefixes duplicate device names with "2- ", "3- "…; ignore that so a binding survives replugging. */
export function normalizeDeviceName(name: string): string {
  return name.replace(/^\d+-\s*/, '').trim();
}

export function sameTrigger(a: MidiTrigger, b: MidiTrigger): boolean {
  return (
    a.type === b.type &&
    a.channel === b.channel &&
    a.number === b.number &&
    (!a.device || !b.device || normalizeDeviceName(a.device) === normalizeDeviceName(b.device))
  );
}

export function triggerMatches(trigger: MidiTrigger, ev: MidiEvent, device: string): boolean {
  return sameTrigger(trigger, { type: ev.type, channel: ev.channel, number: ev.number, device });
}

/**
 * Turns raw messages into presses. Controllers fire once when they cross from below 64 to 64 or above,
 * so buttons that send 127/0 fire once per press and a knob or fader turned up fires only once.
 */
export class MidiPressDetector {
  private ccState = new Map<string, boolean>();

  /** The event if it is a new press, otherwise null. */
  press(ev: MidiEvent, device: string): MidiEvent | null {
    return this.edge(ev, device) === 'press' ? ev : null;
  }

  /** 'press' or 'release' when a button goes down or up; null for repeats and program changes' "release". */
  edge(ev: MidiEvent, device: string): 'press' | 'release' | null {
    if (ev.type === 'cc') {
      const key = `${normalizeDeviceName(device)}|${ev.channel}|${ev.number}`;
      const was = this.ccState.get(key) ?? false;
      this.ccState.set(key, ev.pressed);
      return ev.pressed === was ? null : ev.pressed ? 'press' : 'release';
    }
    return ev.pressed ? 'press' : ev.type === 'note' ? 'release' : null;
  }
}

/** The actions bound to a press, in binding order. */
export function actionsFor(settings: MidiSettings, ev: MidiEvent, device: string): MidiAction[] {
  if (!settings.enabled) return [];
  return settings.bindings.filter((b) => triggerMatches(b.trigger, ev, device)).map((b) => b.action);
}

/**
 * Binds a trigger to an action. An action has one trigger; a trigger drives one action, so a button
 * learned for a new action is taken away from the old one. Returns the new settings and the action
 * that lost the trigger, if any.
 */
export function bindTrigger(settings: MidiSettings, action: MidiAction, trigger: MidiTrigger): { settings: MidiSettings; replaced: MidiAction | null } {
  const replaced = settings.bindings.find((b) => b.action !== action && sameTrigger(b.trigger, trigger))?.action ?? null;
  const bindings = settings.bindings.filter((b) => b.action !== action && !sameTrigger(b.trigger, trigger));
  bindings.push({ action, trigger: { ...trigger } });
  return { settings: { ...settings, bindings: sortBindings(bindings) }, replaced };
}

export function unbindAction(settings: MidiSettings, action: MidiAction): MidiSettings {
  return { ...settings, bindings: settings.bindings.filter((b) => b.action !== action) };
}

function sortBindings(bindings: MidiBinding[]): MidiBinding[] {
  const order = new Map(MIDI_ACTIONS.map((a, i) => [a.action, i]));
  return bindings.sort((a, b) => (order.get(a.action) ?? 99) - (order.get(b.action) ?? 99));
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Note name with middle C (60) as C3, the convention most controllers print. */
export function noteName(n: number): string {
  return `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 2}`;
}

export function describeTrigger(t: MidiTrigger): string {
  const what = t.type === 'note' ? `Note ${noteName(t.number)} (${t.number})` : t.type === 'cc' ? `CC ${t.number}` : `Program ${t.number + 1}`;
  return `${what} · ch ${t.channel + 1}`;
}

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** Validates settings read from disk; drops anything malformed. */
export function normalizeMidiSettings(raw: unknown): MidiSettings {
  const base = defaultMidiSettings();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Partial<MidiSettings>;
  const actions = new Set(MIDI_ACTIONS.map((a) => a.action));
  let settings: MidiSettings = { enabled: r.enabled !== false, bindings: [] };
  for (const b of Array.isArray(r.bindings) ? r.bindings : []) {
    const t = b?.trigger as Partial<MidiTrigger> | undefined;
    if (!b || !actions.has(b.action) || !t) continue;
    if (t.type !== 'note' && t.type !== 'cc' && t.type !== 'program') continue;
    if (!isInt(t.channel, 0, 15) || !isInt(t.number, 0, 127)) continue;
    const trigger: MidiTrigger = { type: t.type, channel: t.channel, number: t.number, device: typeof t.device === 'string' ? t.device : '' };
    settings = bindTrigger(settings, b.action, trigger).settings;
  }
  return settings;
}
