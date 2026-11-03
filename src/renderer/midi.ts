// MIDI controller input: listens to every connected MIDI device (Web MIDI), runs learned mappings and
// handles "learn" mode in Setup. Mappings live in the app settings via the main process.
import type { MidiAction, MidiSettings, MidiTrigger } from '../shared/types';
import {
  MIDI_ACTIONS,
  MidiPressDetector,
  actionsFor,
  bindTrigger,
  defaultMidiSettings,
  describeTrigger,
  isHoldAction,
  parseMidiMessage,
  unbindAction,
  type MidiEvent,
} from '../core/midi';
import { runRemote } from './remote';
import { errorMessage, toast } from './dom';
import { api, store } from './store';

export type MidiAccessState = 'off' | 'starting' | 'ready' | 'unsupported' | 'denied';

export const actionLabel = (a: MidiAction): string => MIDI_ACTIONS.find((x) => x.action === a)?.label ?? a;

class MidiController {
  settings: MidiSettings = defaultMidiSettings();
  state: MidiAccessState = 'off';
  error = '';
  /** Names of the connected input devices. */
  inputs: string[] = [];
  /** The action waiting for a button press in learn mode. */
  learning: MidiAction | null = null;
  /** Called with a short description of every incoming message (for the activity display). */
  onActivity: ((text: string) => void) | null = null;

  private access: MIDIAccess | null = null;
  private presses = new MidiPressDetector();
  /** Transport actions run one after the other so quick presses can't overlap. */

  async init(): Promise<void> {
    try {
      this.settings = await api().getMidiSettings();
    } catch (e) {
      toast(`Could not load MIDI settings: ${errorMessage(e)}`, 'error');
    }
    if (this.settings.enabled) await this.open();
    this.changed();
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.save({ ...this.settings, enabled });
    if (enabled) await this.open();
    else this.close();
    this.changed();
  }

  learn(action: MidiAction | null): void {
    this.learning = this.learning === action ? null : action;
    this.changed();
  }

  async clear(action: MidiAction): Promise<void> {
    if (this.learning === action) this.learning = null;
    await this.save(unbindAction(this.settings, action));
    this.changed();
  }

  /** Limits a mapping to one device by name, or to any device (''). */
  async setDevice(action: MidiAction, device: string): Promise<void> {
    const b = this.settings.bindings.find((x) => x.action === action);
    if (!b) return;
    await this.save(bindTrigger(this.settings, action, { ...b.trigger, device }).settings);
    this.changed();
  }

  triggerFor(action: MidiAction): MidiTrigger | undefined {
    return this.settings.bindings.find((b) => b.action === action)?.trigger;
  }

  private async save(next: MidiSettings): Promise<void> {
    this.settings = next;
    try {
      this.settings = await api().setMidiSettings(next);
    } catch (e) {
      toast(`Could not save MIDI settings: ${errorMessage(e)}`, 'error');
    }
  }

  private async open(): Promise<void> {
    if (this.access) return;
    if (typeof navigator.requestMIDIAccess !== 'function') {
      this.state = 'unsupported';
      return;
    }
    this.state = 'starting';
    this.changed();
    try {
      const access = await navigator.requestMIDIAccess({ sysex: false });
      if (!this.settings.enabled) return; // switched off while starting
      this.access = access;
      access.onstatechange = () => this.attachInputs();
      this.attachInputs();
      this.state = 'ready';
      this.error = '';
    } catch (e) {
      this.state = 'denied';
      this.error = errorMessage(e);
    }
  }

  private close(): void {
    if (this.access) {
      this.access.onstatechange = null;
      this.access.inputs.forEach((input) => (input.onmidimessage = null));
    }
    this.access = null;
    this.inputs = [];
    this.learning = null;
    this.state = 'off';
  }

  private attachInputs(): void {
    if (!this.access) return;
    const names: string[] = [];
    this.access.inputs.forEach((input) => {
      if (input.state !== 'connected') return;
      const name = input.name || input.manufacturer || input.id;
      names.push(name);
      input.onmidimessage = (e) => {
        if (e.data) this.handle(e.data, name);
      };
    });
    const before = this.inputs.join('\n');
    this.inputs = names;
    if (names.join('\n') !== before) this.changed();
  }

  private handle(data: Uint8Array, device: string): void {
    const ev = parseMidiMessage(data);
    if (!ev) return;
    this.onActivity?.(`${device}: ${describeEvent(ev)}`);
    const edge = this.presses.edge(ev, device);
    if (!edge) return;
    if (edge === 'release') {
      // only held buttons (cough) act on release
      if (!this.learning) for (const action of actionsFor(this.settings, ev, device)) if (isHoldAction(action)) this.run(action, false);
      return;
    }
    const press = ev;

    if (this.learning) {
      const action = this.learning;
      this.learning = null;
      const trigger: MidiTrigger = { type: press.type, channel: press.channel, number: press.number, device };
      const { settings, replaced } = bindTrigger(this.settings, action, trigger);
      void this.save(settings).then(() => this.changed());
      toast(`${actionLabel(action)}: ${describeTrigger(trigger)}${replaced ? ` (removed from ${actionLabel(replaced)})` : ''}`);
      return;
    }
    for (const action of actionsFor(this.settings, press, device)) this.run(action);
  }

  /** Runs a mapped function, the same way the keyboard shortcut does. */
  run(action: MidiAction, pressed = true): void {
    runRemote({ action, pressed });
  }

  private changed(): void {
    store.notify('midi');
  }
}

function describeEvent(ev: MidiEvent): string {
  const trigger = describeTrigger({ type: ev.type, channel: ev.channel, number: ev.number, device: '' });
  if (ev.type === 'note') return `${trigger} ${ev.pressed ? `on (${ev.value})` : 'off'}`;
  if (ev.type === 'cc') return `${trigger} = ${ev.value}`;
  return trigger;
}

export const midi = new MidiController();
