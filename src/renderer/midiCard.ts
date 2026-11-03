// Setup card for MIDI controller mappings: enable/disable, connected devices, learn and clear per function.
import { MIDI_ACTIONS, describeTrigger, normalizeDeviceName } from '../core/midi';
import { h } from './dom';
import { midi } from './midi';

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
      return 'MIDI input is switched off.';
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
        'Use MIDI input',
      ),
    ),
    h('p', { class: midi.state === 'denied' ? 'warning' : 'muted' }, statusText()),
  );
  if (!on) return card;

  card.append(
    h('p', { class: 'muted' }, 'Click Learn, then press the button, pad or key on your controller. Mappings are saved with the app and work in every episode.'),
    h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Last message:'), activity),
  );

  const table = h('table', { class: 'midi-map' }, h('tr', null, h('th', null, 'Function'), h('th', null, 'MIDI'), h('th', null, 'Device'), h('th', null, '')));
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
    table.append(
      h(
        'tr',
        { class: learning ? 'learning' : '' },
        h('td', null, label),
        h('td', null, learning ? h('span', { class: 'warning' }, 'Press a control on your MIDI device… (Esc cancels)') : trigger ? describeTrigger(trigger) : h('span', { class: 'muted' }, 'Not mapped')),
        h('td', null, deviceCell),
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
