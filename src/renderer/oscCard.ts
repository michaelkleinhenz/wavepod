// Setup card for the OSC server (Stream Deck via Bitfocus Companion, TouchOSC, …).
import type { OscSettings, OscStatus } from '../shared/types';
import { OSC_ADDRESSES } from '../core/osc';
import { errorMessage, h, toast } from './dom';
import { api, store } from './store';

let status: OscStatus | null = null;
let loading = false;

function load(): void {
  if (loading) return;
  loading = true;
  api()
    .getOscStatus()
    .then((s) => {
      status = s;
      store.notify('osc');
    })
    .catch((e) => toast(`OSC: ${errorMessage(e)}`, 'error'))
    .finally(() => (loading = false));
}

async function apply(patch: Partial<OscSettings>): Promise<void> {
  if (!status) return;
  try {
    status = await api().setOscSettings({ enabled: status.enabled, port: status.port, allowNetwork: status.allowNetwork, ...patch });
  } catch (e) {
    toast(`OSC: ${errorMessage(e)}`, 'error');
  }
  store.notify('osc');
}

export function renderOscCard(): HTMLElement {
  if (!status) load();
  const on = !!status?.enabled;
  const card = h(
    'section',
    { class: 'card osc-card' },
    h(
      'div',
      { class: 'card-head' },
      h('h2', null, 'Remote control (OSC)'),
      h(
        'label',
        { class: 'row' },
        h('input', { type: 'checkbox', checked: on, disabled: !status, onchange: (e: Event) => void apply({ enabled: (e.target as HTMLInputElement).checked }) }),
        'Listen for OSC',
      ),
    ),
    h('p', { class: 'muted' }, 'For a Stream Deck through Bitfocus Companion (“Generic OSC” connection), TouchOSC or any app that sends OSC over UDP: record, markers, cough buttons and soundboard.'),
  );
  if (!status || !on) return card;
  card.append(
    h(
      'div',
      { class: 'row' },
      h(
        'label',
        { class: 'row' },
        'UDP port',
        h('input', {
          type: 'number',
          class: 'mcp-port',
          min: 1024,
          max: 65535,
          value: String(status.port),
          onchange: (e: Event) => {
            const port = Number((e.target as HTMLInputElement).value);
            if (Number.isInteger(port) && port >= 1024 && port <= 65535) void apply({ port });
            else toast('Pick a port between 1024 and 65535', 'error');
          },
        }),
      ),
      h(
        'label',
        { class: 'row' },
        h('input', { type: 'checkbox', checked: status.allowNetwork, onchange: (e: Event) => void apply({ allowNetwork: (e.target as HTMLInputElement).checked }) }),
        'Accept from other computers',
      ),
      status.running
        ? h('span', { class: 'mcp-state ok' }, `Listening${status.received ? ` · ${status.received} messages` : ''}`)
        : h('span', { class: 'warning' }, status.error ?? 'Not running'),
    ),
    h(
      'table',
      { class: 'osc-map' },
      h('tr', null, h('th', null, 'Address'), h('th', null, 'Does')),
      ...OSC_ADDRESSES.map((a) => h('tr', null, h('td', null, h('code', null, a.address)), h('td', null, a.what))),
    ),
    h('p', { class: 'hint' }, 'Buttons that send 1 on press and 0 on release work as they are. Without an argument a message counts as a press.'),
  );
  return card;
}
