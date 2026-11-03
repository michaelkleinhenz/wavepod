// MIDI controller input: listens to every connected MIDI device (Web MIDI), runs learned mappings and
// handles "learn" mode in Setup. Mappings live in the app settings via the main process.
import type { MidiAction, MidiButtonMode, MidiSettings, MidiTrigger } from '../shared/types';
import {
  MIDI_ACTIONS,
  MidiPressDetector,
  actionsFor,
  bindTrigger,
  defaultMidiSettings,
  describeTrigger,
  modeOf,
  parseMidiMessage,
  sameTrigger,
  unbindAction,
  type MidiEvent,
} from '../core/midi';
import { dropMarker, prepareForEditing, stop, togglePlay, toggleRecord } from './actions';
import { errorMessage, toast } from './dom';
import { api, store } from './store';

export type MidiAccessState = 'off' | 'starting' | 'ready' | 'unsupported' | 'denied';

/** How long Learn waits for a button's release before deciding it is a toggle (latching) button. */
const LEARN_RELEASE_MS = 1000;

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
  private queue: Promise<void> = Promise.resolve();
  /** A control just learned, waiting to see whether it sends a release (momentary) or not (toggle). */
  private probe: { action: MidiAction; trigger: MidiTrigger; replaced: MidiAction | null; timer: ReturnType<typeof setTimeout> } | null = null;

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
    this.endProbe(action);
    await this.save(unbindAction(this.settings, action));
    this.changed();
  }

  /** Limits a mapping to one device by name, or to any device (''). */
  async setDevice(action: MidiAction, device: string): Promise<void> {
    const b = this.settings.bindings.find((x) => x.action === action);
    if (!b) return;
    await this.save(bindTrigger(this.settings, action, { ...b.trigger, device }, modeOf(b)).settings);
    this.changed();
  }

  /** Sets whether a mapping's button is momentary or a toggle (latching) button. */
  async setMode(action: MidiAction, mode: MidiButtonMode): Promise<void> {
    const b = this.settings.bindings.find((x) => x.action === action);
    if (!b) return;
    this.endProbe(action);
    await this.save(bindTrigger(this.settings, action, b.trigger, mode).settings);
    this.changed();
  }

  modeFor(action: MidiAction): MidiButtonMode {
    const b = this.settings.bindings.find((x) => x.action === action);
    return b ? modeOf(b) : 'momentary';
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
    const press = this.presses.press(ev, device);
    const trigger: MidiTrigger = { type: ev.type, channel: ev.channel, number: ev.number, device };

    if (this.probe && sameTrigger(this.probe.trigger, trigger)) {
      // The button just learned: a release means momentary, another "on" without a release means toggle.
      const { action, replaced, trigger: probeTrigger } = this.probe;
      this.endProbe(action);
      this.learned(action, probeTrigger, ev.pressed ? 'toggle' : 'momentary', replaced);
      return;
    }

    if (this.learning) {
      const action = this.learning;
      this.learning = null;
      if (ev.type === 'program' || !ev.pressed) {
        // Program changes have no release; an "off" first is a toggle button that was on.
        this.learned(action, trigger, ev.type === 'program' ? 'momentary' : 'toggle');
        return;
      }
      // Bind right away, then watch for the release to tell momentary from toggle buttons.
      const replaced = this.bind(action, trigger, 'momentary');
      this.probe = { action, trigger, replaced, timer: setTimeout(() => this.probeTimedOut(), LEARN_RELEASE_MS) };
      return;
    }
    for (const action of actionsFor(this.settings, ev, device, press)) this.run(action);
  }

  private probeTimedOut(): void {
    if (!this.probe) return;
    const { action, trigger, replaced } = this.probe;
    this.probe = null;
    this.learned(action, trigger, 'toggle', replaced);
  }

  private endProbe(action: MidiAction): void {
    if (this.probe?.action !== action) return;
    clearTimeout(this.probe.timer);
    this.probe = null;
  }

  private bind(action: MidiAction, trigger: MidiTrigger, mode: MidiButtonMode): MidiAction | null {
    const { settings, replaced } = bindTrigger(this.settings, action, trigger, mode);
    void this.save(settings).then(() => this.changed());
    this.changed();
    return replaced;
  }

  private learned(action: MidiAction, trigger: MidiTrigger, mode: MidiButtonMode, earlier: MidiAction | null = null): void {
    const replaced = this.bind(action, trigger, mode) ?? earlier;
    const kind = trigger.type === 'program' ? '' : mode === 'toggle' ? ' (toggle button)' : ' (momentary button)';
    toast(`${actionLabel(action)}: ${describeTrigger(trigger)}${kind}${replaced ? ` (removed from ${actionLabel(replaced)})` : ''}`);
  }

  /** Runs a mapped function, the same way the keyboard shortcut does. */
  run(action: MidiAction): void {
    switch (action) {
      case 'chapter-marker':
        return dropMarker('chapter');
      case 'edit-marker':
        return dropMarker('edit');
      case 'prepare-for-editing':
        return prepareForEditing();
    }
    this.queue = this.queue.then(() => {
      const state = store.transport.state;
      switch (action) {
        case 'record-start':
          return state === 'recording' ? undefined : toggleRecord();
        case 'record-stop':
          return state === 'recording' ? stop() : undefined;
        case 'record-toggle':
          return toggleRecord();
        case 'play-toggle':
          return togglePlay();
        case 'stop':
          return state === 'stopped' ? undefined : stop();
      }
    });
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
