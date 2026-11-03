// Setup card for the local MCP server: lets AI agents (Claude Desktop, Claude Code, …) read the
// episode and edit filter stacks. Off by default; only programs on this computer can connect.
import type { McpSettings, McpStatus } from '../shared/types';
import { errorMessage, h, toast } from './dom';
import { api, store } from './store';

let status: McpStatus | null = null;
let loading = false;

function load(): void {
  if (loading) return;
  loading = true;
  api()
    .getMcpStatus()
    .then((s) => {
      status = s;
      store.notify('mcp');
    })
    .catch(() => {})
    .finally(() => (loading = false));
}

async function apply(patch: Partial<McpSettings>): Promise<void> {
  if (!status) return;
  try {
    status = await api().setMcpSettings({ enabled: status.enabled, port: status.port, ...patch });
    if (status.error) toast(status.error, 'error');
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
  store.notify('mcp');
}

function copyRow(label: string, text: string): HTMLElement {
  return h(
    'div',
    { class: 'mcp-copy' },
    h('span', { class: 'muted' }, label),
    h('code', null, text),
    h(
      'button',
      {
        class: 'small',
        onclick: () =>
          void navigator.clipboard.writeText(text).then(
            () => toast('Copied'),
            () => toast('Could not copy', 'error'),
          ),
      },
      'Copy',
    ),
  );
}

export function renderMcpCard(): HTMLElement {
  if (!status) load();
  const on = !!status?.enabled;
  const card = h(
    'section',
    { class: 'card mcp-card' },
    h(
      'div',
      { class: 'card-head' },
      h('h2', null, 'AI agents (MCP)'),
      h(
        'label',
        { class: 'row' },
        h('input', { type: 'checkbox', checked: on, disabled: !status, onchange: (e: Event) => void apply({ enabled: (e.target as HTMLInputElement).checked }) }),
        'Allow AI agents to control WavePod',
      ),
    ),
    h(
      'p',
      { class: 'muted' },
      'Lets AI apps on this computer, such as Claude Desktop or Claude Code, read the episode and build and tweak filter stacks over the Model Context Protocol. Only programs on this computer can connect. Their changes show up at once and can be undone with Ctrl+Z.',
    ),
  );
  if (!status || !on) return card;

  card.append(
    h(
      'div',
      { class: 'row' },
      h(
        'label',
        { class: 'row' },
        'Port',
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
      status.running ? h('span', { class: 'mcp-state ok' }, `Running · ${status.tools.length} tools`) : h('span', { class: 'warning' }, status.error ?? 'Not running'),
    ),
  );
  if (status.running) {
    card.append(
      copyRow('Server URL', status.url),
      copyRow('Claude Code', `claude mcp add --transport http wavepod ${status.url}`),
      h('p', { class: 'hint' }, 'Claude Desktop and other apps that only start local commands connect through mcp-remote; see the README.'),
    );
  }
  return card;
}
