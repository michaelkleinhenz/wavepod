import { describe, expect, it } from 'vitest';
import {
  MidiPressDetector,
  actionsFor,
  bindTrigger,
  defaultMidiSettings,
  describeTrigger,
  normalizeMidiSettings,
  parseMidiMessage,
  unbindAction,
  type MidiTrigger,
} from '../src/core/midi';

const note = (n: number, ch = 0, device = 'nanoPAD2'): MidiTrigger => ({ type: 'note', channel: ch, number: n, device });

describe('parseMidiMessage', () => {
  it('decodes note on/off, controllers and program changes', () => {
    expect(parseMidiMessage([0x91, 60, 100])).toEqual({ type: 'note', channel: 1, number: 60, value: 100, pressed: true });
    expect(parseMidiMessage([0x91, 60, 0])?.pressed).toBe(false); // note-on with velocity 0 is a release
    expect(parseMidiMessage([0x80, 60, 64])?.pressed).toBe(false);
    expect(parseMidiMessage([0xb0, 20, 127])).toEqual({ type: 'cc', channel: 0, number: 20, value: 127, pressed: true });
    expect(parseMidiMessage([0xb0, 20, 10])?.pressed).toBe(false);
    expect(parseMidiMessage([0xcf, 4])).toEqual({ type: 'program', channel: 15, number: 4, value: 0, pressed: true });
  });

  it('ignores system and unsupported messages', () => {
    expect(parseMidiMessage([0xf8])).toBeNull(); // clock
    expect(parseMidiMessage([0xf0, 0x7f, 0x7f, 0x06, 0x02, 0xf7])).toBeNull(); // sysex
    expect(parseMidiMessage([0xe0, 0, 64])).toBeNull(); // pitch bend
    expect(parseMidiMessage([0x90, 60])).toBeNull(); // truncated
    expect(parseMidiMessage([])).toBeNull();
  });
});

describe('MidiPressDetector', () => {
  it('fires notes on note-on only', () => {
    const d = new MidiPressDetector();
    expect(d.press(parseMidiMessage([0x90, 36, 90])!, 'pad')).not.toBeNull();
    expect(d.press(parseMidiMessage([0x80, 36, 0])!, 'pad')).toBeNull();
  });

  it('fires a controller once when it crosses the middle, not on every value of a fader', () => {
    const d = new MidiPressDetector();
    const fire = (v: number) => d.press(parseMidiMessage([0xb0, 7, v])!, 'ctl') !== null;
    expect([10, 40, 70, 90, 127, 100, 30, 0, 127].map(fire)).toEqual([false, false, true, false, false, false, false, false, true]);
  });

  it('keeps controller state per device', () => {
    const d = new MidiPressDetector();
    const cc = parseMidiMessage([0xb0, 7, 127])!;
    expect(d.press(cc, 'a')).not.toBeNull();
    expect(d.press(cc, 'b')).not.toBeNull();
    expect(d.press(cc, 'a')).toBeNull();
  });
});

describe('bindings', () => {
  it('matches type, channel, number and device', () => {
    const s = bindTrigger(defaultMidiSettings(), 'chapter-marker', note(36)).settings;
    const ev = parseMidiMessage([0x90, 36, 100])!;
    expect(actionsFor(s, ev, 'nanoPAD2')).toEqual(['chapter-marker']);
    expect(actionsFor(s, ev, '2- nanoPAD2')).toEqual(['chapter-marker']); // Windows duplicate prefix
    expect(actionsFor(s, ev, 'Launchpad')).toEqual([]);
    expect(actionsFor(s, parseMidiMessage([0x91, 36, 100])!, 'nanoPAD2')).toEqual([]);
    expect(actionsFor(s, parseMidiMessage([0xb0, 36, 127])!, 'nanoPAD2')).toEqual([]);
    expect(actionsFor({ ...s, enabled: false }, ev, 'nanoPAD2')).toEqual([]);
  });

  it('an empty device name matches every device', () => {
    const s = bindTrigger(defaultMidiSettings(), 'edit-marker', note(40, 0, '')).settings;
    expect(actionsFor(s, parseMidiMessage([0x90, 40, 1])!, 'anything')).toEqual(['edit-marker']);
  });

  it('gives each action one trigger and each trigger one action', () => {
    let s = bindTrigger(defaultMidiSettings(), 'record-start', note(36)).settings;
    s = bindTrigger(s, 'record-start', note(37)).settings;
    expect(s.bindings).toEqual([{ action: 'record-start', trigger: note(37) }]);

    const res = bindTrigger(s, 'record-stop', note(37));
    expect(res.replaced).toBe('record-start');
    expect(res.settings.bindings).toEqual([{ action: 'record-stop', trigger: note(37) }]);
  });

  it('keeps bindings in the order of the function list', () => {
    let s = bindTrigger(defaultMidiSettings(), 'edit-marker', note(40)).settings;
    s = bindTrigger(s, 'record-start', note(36)).settings;
    s = bindTrigger(s, 'chapter-marker', note(38)).settings;
    expect(s.bindings.map((b) => b.action)).toEqual(['record-start', 'chapter-marker', 'edit-marker']);
    expect(unbindAction(s, 'chapter-marker').bindings.map((b) => b.action)).toEqual(['record-start', 'edit-marker']);
  });
});

describe('normalizeMidiSettings', () => {
  it('defaults to enabled without bindings', () => {
    expect(normalizeMidiSettings(undefined)).toEqual({ enabled: true, bindings: [] });
    expect(normalizeMidiSettings('junk')).toEqual({ enabled: true, bindings: [] });
  });

  it('keeps valid bindings and drops broken ones', () => {
    const raw = {
      enabled: false,
      bindings: [
        { action: 'record-start', trigger: { type: 'note', channel: 0, number: 36, device: 'pad' } },
        { action: 'record-stop', trigger: { type: 'cc', channel: 16, number: 1 } }, // bad channel
        { action: 'explode', trigger: { type: 'note', channel: 0, number: 1 } }, // unknown action
        { action: 'edit-marker', trigger: { type: 'program', channel: 2, number: 5 } }, // no device -> any
        { action: 'chapter-marker', trigger: { type: 'note', channel: 0, number: 36, device: 'pad' } }, // duplicate trigger wins
      ],
    };
    const s = normalizeMidiSettings(JSON.parse(JSON.stringify(raw)));
    expect(s.enabled).toBe(false);
    expect(s.bindings).toEqual([
      { action: 'chapter-marker', trigger: { type: 'note', channel: 0, number: 36, device: 'pad' } },
      { action: 'edit-marker', trigger: { type: 'program', channel: 2, number: 5, device: '' } },
    ]);
  });
});

describe('describeTrigger', () => {
  it('uses note names with middle C as C3 and 1-based channels', () => {
    expect(describeTrigger(note(60, 9))).toBe('Note C3 (60) · ch 10');
    expect(describeTrigger({ type: 'cc', channel: 0, number: 64, device: '' })).toBe('CC 64 · ch 1');
    expect(describeTrigger({ type: 'program', channel: 0, number: 0, device: '' })).toBe('Program 1 · ch 1');
  });
});

describe('held MIDI buttons', () => {
  it('reports presses and releases for notes and controllers', async () => {
    const { MidiPressDetector, isHoldAction, MIDI_ACTIONS } = await import('../src/core/midi');
    const d = new MidiPressDetector();
    const ev = (type: 'note' | 'cc', pressed: boolean) => ({ type, channel: 0, number: 10, value: pressed ? 127 : 0, pressed });
    expect(d.edge(ev('note', true), 'X')).toBe('press');
    expect(d.edge(ev('note', false), 'X')).toBe('release');
    expect(d.edge(ev('cc', true), 'X')).toBe('press');
    expect(d.edge(ev('cc', true), 'X')).toBeNull();
    expect(d.edge(ev('cc', false), 'X')).toBe('release');
    expect(isHoldAction('cough-2')).toBe(true);
    expect(isHoldAction('sound-2')).toBe(false);
    expect(MIDI_ACTIONS.map((a) => a.action)).toEqual(expect.arrayContaining(['cough-1', 'cough-6', 'sound-9', 'sounds-stop']));
  });
});
