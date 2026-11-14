// Settings › Cameras: the CamPod camera recorder (address, API key, start with the recording)
// and its cameras, with what WavePod can import from each.
import type { CamPodInfo, CamPodStatus } from '../shared/types';
import { errorMessage, h, toast } from './dom';
import { api } from './store';

let info: CamPodInfo | null = null;

/** True while CamPod is set up to follow the recording (for the Settings tab's indicator). */
export function isCamPodOn(): boolean {
  return !!info?.url && info.followRecording;
}

export function renderCamPodCard(): HTMLElement {
  const card = h('div', { class: 'card campod-settings' }, h('p', { class: 'muted' }, 'Loading…'));
  void api()
    .getCamPodSettings()
    .then((i) => {
      info = i;
      card.replaceWith(build(i));
    })
    .catch((e) => card.replaceWith(h('div', { class: 'card' }, h('p', { class: 'remote-error' }, errorMessage(e)))));
  return card;
}

function cameraList(status: CamPodStatus, refresh: (s: CamPodStatus) => void): HTMLElement {
  if (!status.cameras.length) return h('p', { class: 'warning' }, 'CamPod sees no cameras. Plug them in on the CamPod computer.');
  return h(
    'table',
    { class: 'campod-cameras' },
    h('tr', null, h('th', null, 'Camera'), h('th', null, 'Records'), h('th', null, '')),
    ...status.cameras.map((c) =>
      h(
        'tr',
        null,
        h('td', null, c.name, !c.present ? h('span', { class: 'muted' }, ' (unplugged)') : !c.enabled ? h('span', { class: 'muted' }, ' (switched off in CamPod)') : null),
        h('td', null, c.format || '–', c.error ? h('div', { class: 'warning' }, c.error) : null, c.problem ? h('div', { class: 'warning' }, c.problem) : null),
        h(
          'td',
          null,
          !c.present || !c.enabled
            ? null
            : c.canSwitchToH264
            ? h(
                'button',
                {
                  disabled: !!status.recording,
                  title: status.recording ? 'CamPod is recording: change it afterwards' : 'CamPod encodes this camera to H.264 from the next recording on (smaller files, a little more CPU on the CamPod computer)',
                  onclick: async () => {
                    try {
                      refresh(await api().camPodSetH264(c.id));
                    } catch (e) {
                      toast(errorMessage(e), 'error');
                    }
                  },
                },
                'Record H.264',
              )
            : c.problem
              ? null
              : h('span', { class: 'mcp-state ok' }, 'OK'),
        ),
      ),
    ),
  );
}

function build(i: CamPodInfo): HTMLElement {
  const url = h('input', { type: 'text', value: i.url, placeholder: 'campod.local or 192.168.1.20', spellcheck: false });
  const token = h('input', { type: 'password', value: '', placeholder: i.hasToken ? 'Saved (type to replace)' : 'Only if CamPod asks for one' });
  const follow = h('input', { type: 'checkbox', checked: i.followRecording });
  const status = h('span', { class: 'muted remote-test' });
  const cams = h('div', { class: 'campod-status' });
  const save = async (): Promise<boolean> => {
    try {
      info = await api().setCamPodSettings({ url: url.value, followRecording: follow.checked, ...(token.value ? { token: token.value } : {}) });
      url.value = info.url;
      token.value = '';
      token.placeholder = info.hasToken ? 'Saved (type to replace)' : 'Only if CamPod asks for one';
      return true;
    } catch (e) {
      toast(errorMessage(e), 'error');
      return false;
    }
  };
  const show = (s: CamPodStatus) => {
    const problems = s.cameras.filter((c) => c.present && c.enabled && c.problem).length;
    status.textContent = `Connected to CamPod${s.version ? ` ${s.version}` : ''}. ${s.recording ? `Recording “${s.recording.title || s.recording.name}”. ` : ''}${
      s.remainingSeconds ? `Room for about ${Math.floor(s.remainingSeconds / 3600)} h ${Math.floor((s.remainingSeconds % 3600) / 60)} min. ` : ''
    }${problems ? `${problems} camera${problems === 1 ? '' : 's'} can’t be imported as set up.` : ''}`;
    cams.replaceChildren(cameraList(s, show), s.diskWarning ? h('p', { class: 'warning' }, s.diskWarning) : '');
  };
  const test = async () => {
    status.textContent = 'Checking…';
    cams.replaceChildren();
    if (!(await save())) return void (status.textContent = '');
    if (!info?.url) return void (status.textContent = 'Type the CamPod computer’s address first.');
    try {
      show(await api().camPodStatus());
    } catch (e) {
      status.textContent = errorMessage(e);
    }
  };
  for (const el of [url, token]) el.addEventListener('change', () => void save());
  follow.addEventListener('change', () => void save());
  const field = (label: string, input: HTMLElement, hint?: string) => h('label', { class: 'field' }, h('span', null, label), input, hint ? h('small', { class: 'muted' }, hint) : null);
  const card = h(
    'div',
    { class: 'card campod-settings' },
    h('h3', null, 'CamPod camera recorder'),
    h(
      'p',
      { class: 'muted' },
      'CamPod records several USB cameras on a Linux computer. WavePod starts and stops its cameras together with the sound, and File › Import from CamPod… brings the camera files into the episode, synced to the microphones.',
    ),
    field('Address', url, 'The CamPod computer’s name or IP address; port 8080 unless you changed it.'),
    field('API key', token, 'Once CamPod has API keys, it needs one: create it on the CamPod computer with campod apikey create wavepod. Stored encrypted by the system keychain where available.'),
    h('label', { class: 'check' }, follow, ' Start and stop the cameras with the recording (not with punch-ins or loop recording)'),
    h('div', { class: 'row' }, h('button', { onclick: () => void test() }, 'Test Connection'), status),
    cams,
  );
  if (i.url) void test();
  return card;
}
