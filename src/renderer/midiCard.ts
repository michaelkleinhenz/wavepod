// Settings › Controllers card for MIDI controller mappings: enable/disable, connected devices, learn and clear per function.
import type { MidiButtonMode } from '../shared/types';
import { MIDI_ACTIONS, describeTrigger, normalizeDeviceName } from '../core/midi';
import { h } from './dom';
import { midi } from './midi';
import { store } from './store';

// Kept across re-renders so the last message stays visible.
const activity = h('span', { class: 'midi-activity' }, 'No MIDI messages yet');
midi.onActivity = (text) => {
  activity.textContent = text;
  activity.classList.remove('blink');
  void activity.offsetWidth; // restart the animation
  activity.classList.add('blink');
};

function statusText(): string {
  switch (midi.state) {
    case 'off':
      return 'Switched off.';
    case 'starting':
      return 'Looking for MIDI devices…';
    case 'unsupported':
      return 'MIDI is not available in this build.';
    case 'denied':
      return `Could not open MIDI devices${midi.error ? `: ${midi.error}` : ''}.`;
    case 'ready':
      return midi.inputs.length ? `Connected: ${midi.inputs.join(', ')}` : 'No MIDI device connected. Plug in a USB MIDI controller; it shows up here.';
  }
}

// Whether the Device and Button columns are shown (most people never need them).
let showDetails = false;

export function renderMidiCard(): HTMLElement {
  const on = midi.settings.enabled;
  const card = h(
    'section',
    { class: 'card midi-card' },
    h(
      'div',
      { class: 'card-head' },
      h('h2', null, 'MIDI controller'),
      h(
        'label',
        { class: 'row' },
        h('input', { type: 'checkbox', checked: on, onchange: (e: Event) => void midi.setEnabled((e.target as HTMLInputElement).checked) }),
        'Use a MIDI controller',
      ),
    ),
    h('p', { class: midi.state === 'denied' ? 'warning' : 'muted' }, statusText()),
  );
  if (!on) return card;

  card.append(
    h('p', { class: 'muted' }, 'To assign a button: click Learn next to a function, then press and release the button, pad or key on your controller once. Assignments are saved with the app and work in every episode.'),
    h(
      'div',
      { class: 'row' },
      h('span', { class: 'muted' }, 'Last message:'),
      activity,
      h(
        'label',
        { class: 'row midi-details-toggle', title: 'Limit an assignment to one device, or fix a button that Learn took for the wrong type' },
        h('input', {
          type: 'checkbox',
          checked: showDetails,
          onchange: (e: Event) => {
            showDetails = (e.target as HTMLInputElement).checked;
            store.notify('midi');
          },
        }),
        'Show device and button type',
      ),
    ),
  );

  const table = h(
    'table',
    { class: 'midi-map' },
    h('tr', null, h('th', null, 'Function'), h('th', null, 'Assigned to'), showDetails ? h('th', null, 'Device') : null, showDetails ? h('th', null, 'Button type') : null, h('th', null, '')),
  );
  for (const { action, label } of MIDI_ACTIONS) {
    const trigger = midi.triggerFor(action);
    const learning = midi.learning === action;
    const deviceCell = trigger
      ? h(
          'select',
          {
            title: 'Respond to this message from any device, or only from the device it was learned from',
            onchange: (e: Event) => void midi.setDevice(action, (e.target as HTMLSelectElement).value),
          },
          h('option', { value: '', selected: !trigger.device }, 'Any device'),
          ...[...new Set([trigger.device, ...midi.inputs].filter(Boolean))].map((d) =>
            h('option', { value: d, selected: !!trigger.device && normalizeDeviceName(d) === normalizeDeviceName(trigger.device) }, d),
          ),
        )
      : h('span', { class: 'muted' }, '–');
    const mode = midi.modeFor(action);
    const modeCell =
      trigger && trigger.type !== 'program'
        ? h(
            'select',
            {
              title: 'Momentary buttons send on when pressed and off when released. Toggle (latching) buttons send on and off on alternate presses, so every press counts. Learn detects this; change it here if it guessed wrong.',
              onchange: (e: Event) => void midi.setMode(action, (e.target as HTMLSelectElement).value as MidiButtonMode),
            },
            h('option', { value: 'momentary', selected: mode === 'momentary' }, 'Momentary'),
            h('option', { value: 'toggle', selected: mode === 'toggle' }, 'Toggle'),
          )
        : h('span', { class: 'muted' }, '–');
    table.append(
      h(
        'tr',
        { class: learning ? 'learning' : '' },
        h('td', null, label),
        h('td', null, learning ? h('span', { class: 'warning' }, 'Press a control on your MIDI device… (Esc cancels)') : trigger ? describeTrigger(trigger) : h('span', { class: 'muted' }, 'Not assigned')),
        showDetails ? h('td', null, deviceCell) : null,
        showDetails ? h('td', null, modeCell) : null,
        h(
          'td',
          { class: 'midi-buttons' },
          h('button', { class: `small${learning ? ' primary' : ''}`, disabled: midi.state !== 'ready', onclick: () => midi.learn(action) }, learning ? 'Cancel' : 'Learn'),
          h('button', { class: 'small', disabled: !trigger, onclick: () => void midi.clear(action) }, 'Clear'),
        ),
      ),
    );
  }
  card.append(table);
  return card;
}
