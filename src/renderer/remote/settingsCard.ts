// Edit › Settings › Remote guests: the LiveKit server (LiveKit Cloud or self-hosted), its API key
// and secret, the guest page and whether video is allowed.
import type { RemoteInfo } from '../../shared/types';
import { errorMessage, h, toast } from '../dom';
import { api } from '../store';

export function renderRemoteCard(): HTMLElement {
  const card = h('div', { class: 'card remote-settings' }, h('p', { class: 'muted' }, 'Loading…'));
  void api()
    .getRemoteSettings()
    .then((info) => card.replaceWith(build(info)))
    .catch((e) => card.replaceWith(h('div', { class: 'card' }, h('p', { class: 'remote-error' }, errorMessage(e)))));
  return card;
}

function build(info: RemoteInfo): HTMLElement {
  const url = h('input', { type: 'text', value: info.url, placeholder: 'wss://your-project.livekit.cloud', spellcheck: false });
  const key = h('input', { type: 'text', value: info.apiKey, placeholder: 'API key', spellcheck: false });
  const secret = h('input', { type: 'password', value: '', placeholder: info.hasSecret ? 'Saved (type to replace)' : 'API secret' });
  const page = h('input', { type: 'text', value: info.guestPageUrl, spellcheck: false });
  const video = h('input', { type: 'checkbox', checked: info.video });
  const status = h('span', { class: 'muted remote-test' });
  const save = async (): Promise<boolean> => {
    try {
      await api().setRemoteSettings({
        url: url.value,
        apiKey: key.value,
        ...(secret.value ? { apiSecret: secret.value } : {}),
        guestPageUrl: page.value,
        video: video.checked,
      });
      secret.value = '';
      secret.placeholder = 'Saved (type to replace)';
      return true;
    } catch (e) {
      toast(errorMessage(e), 'error');
      return false;
    }
  };
  for (const el of [url, key, secret, page]) el.addEventListener('change', () => void save());
  video.addEventListener('change', () => void save());
  const test = async () => {
    status.textContent = 'Checking…';
    if (!(await save())) return void (status.textContent = '');
    try {
      const rooms = await api().testRemote();
      status.textContent = `Connected. ${rooms} room${rooms === 1 ? '' : 's'} open.`;
    } catch (e) {
      status.textContent = errorMessage(e);
    }
  };
  const field = (label: string, input: HTMLElement, hint?: string) => h('label', { class: 'field' }, h('span', null, label), input, hint ? h('small', { class: 'muted' }, hint) : null);
  return h(
    'div',
    { class: 'card remote-settings' },
    h('h3', null, 'LiveKit server'),
    h(
      'p',
      { class: 'muted' },
      'The live call with remote guests runs through LiveKit: create a free project at cloud.livekit.io (Settings › API keys) or run your own livekit-server. Each guest records their own microphone in the browser and sends it to this computer, so the episode gets their full quality, not the call’s.',
    ),
    info.fromEnvironment ? h('p', { class: 'muted' }, 'Using LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET from the environment. Fill in the fields to use other ones.') : null,
    field('Server URL', url),
    field('API key', key),
    field('API secret', secret, 'Stored encrypted by the system keychain where available. It never leaves this computer.'),
    field('Guest page', page, 'Where invite links point. The project’s own page works; change it only if you host the page yourself.'),
    h('label', { class: 'check' }, video, ' Allow video, so everyone can see each other (video is never recorded)'),
    h('div', { class: 'row' }, h('button', { onclick: () => void test() }, 'Test Connection'), status),
  );
}
