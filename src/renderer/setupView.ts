// Setup: audio host API, devices, sample rate, routing, channel meters and track creation.
import type { BitDepth, DeviceConfig, DeviceProfile } from '../shared/types';
import { addTrack } from '../core/project';
import { suggestTracks } from '../core/deviceProfiles';
import { toDb } from '../core/dsp';
import { append, clear, errorMessage, h, toast } from './dom';
import { api, store } from './store';

const SAMPLE_RATES = [44100, 48000, 96000];
const BUFFER_SIZES = [128, 256, 512, 1024, 2048];

export class SetupView {
  readonly el = h('div', { class: 'view setup-view' });
  private meterEls: Array<{ bar: HTMLElement; db: HTMLElement }> = [];
  /** Opens the template dialogs (set by the app shell). */
  onTemplates?: { start: () => void; save: () => void };

  async refreshDevices(): Promise<void> {
    try {
      store.devices = await api().listDevices();
      const id = store.status?.config.inputDeviceId;
      store.profile = id !== null && id !== undefined ? await api().getProfile(id) : null;
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
    store.notify('devices');
  }

  private async apply(patch: Partial<DeviceConfig>): Promise<void> {
    try {
      store.status = await api().applyConfig(patch);
      if (store.status.error) toast(store.status.error, 'error');
      // An empty project follows the device rate.
      const s = store.status;
      if (s && !store.project.tracks.some((t) => t.clips.length) && store.project.sampleRate !== s.config.sampleRate) {
        store.patch((p) => ({ ...p, sampleRate: s.config.sampleRate }));
      }
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
    await this.refreshDevices();
  }

  render(): void {
    clear(this.el);
    const s = store.status;
    if (!s) {
      this.el.append(h('p', null, 'Starting audio engine…'));
      return;
    }
    const cfg = s.config;
    const inputs = store.devices.filter((d) => d.inputChannels > 0);
    const outputs = store.devices.filter((d) => d.outputChannels > 0);
    const outDev = outputs.find((d) => d.id === cfg.outputDeviceId);
    const inDev = inputs.find((d) => d.id === cfg.inputDeviceId);

    const select = <T extends string | number>(
      label: string,
      value: T | null,
      options: Array<{ value: T; label: string }>,
      onChange: (v: string) => void,
      emptyLabel?: string,
    ) =>
      h(
        'label',
        { class: 'field' },
        h('span', null, label),
        h(
          'select',
          { onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value) },
          emptyLabel ? h('option', { value: '', selected: value === null }, emptyLabel) : null,
          ...options.map((o) => h('option', { value: String(o.value), selected: o.value === value }, o.label)),
        ),
      );

    const pairs = outDev
      ? Array.from({ length: Math.max(1, Math.floor(outDev.outputChannels / 2)) }, (_, i) => ({
          value: i * 2,
          label: outDev.outputChannels === 1 ? 'Output 1' : `Outputs ${i * 2 + 1}/${i * 2 + 2}`,
        }))
      : [];

    const deviceCard = h(
      'section',
      { class: 'card' },
      h('h2', null, 'Audio interface'),
      s.backendError ? h('p', { class: 'warning' }, `${s.backendError}. Using virtual devices.`) : null,
      s.error ? h('p', { class: 'error-text' }, s.error) : null,
      !store.devices.length
        ? h('p', { class: 'warning' }, 'No audio devices found for this audio system. Try another one, or choose "Virtual devices" to try SoundPod without hardware.')
        : null,
      h(
        'div',
        { class: 'grid' },
        select('Audio system', cfg.api, s.apis.map((a) => ({ value: a.id, label: a.label })), (v) => this.apply({ api: v, inputDeviceId: null, outputDeviceId: null })),
        select(
          'Input device',
          cfg.inputDeviceId,
          inputs.map((d) => ({ value: d.id, label: `${d.name} (${d.inputChannels} in)` })),
          (v) => this.apply({ inputDeviceId: v === '' ? null : Number(v) }),
          inputs.length ? undefined : 'No input devices',
        ),
        select(
          'Output device',
          cfg.outputDeviceId,
          outputs.map((d) => ({ value: d.id, label: `${d.name} (${d.outputChannels} out)` })),
          (v) => this.apply({ outputDeviceId: v === '' ? null : Number(v) }),
          outputs.length ? undefined : 'No output devices',
        ),
        select('Playback channels', cfg.outputFirstChannel, pairs, (v) => this.apply({ outputFirstChannel: Number(v) })),
        select(
          'Sample rate',
          cfg.sampleRate,
          SAMPLE_RATES.filter((r) => !inDev || !inDev.sampleRates.length || inDev.sampleRates.includes(r)).map((r) => ({ value: r, label: `${r / 1000} kHz` })),
          (v) => this.apply({ sampleRate: Number(v) }),
        ),
        select(
          'Buffer size',
          cfg.bufferSize,
          BUFFER_SIZES.map((b) => ({ value: b, label: `${b} samples (${((b / cfg.sampleRate) * 1000).toFixed(1)} ms)` })),
          (v) => this.apply({ bufferSize: Number(v) }),
        ),
        select(
          'Recording format',
          store.project.bitDepth,
          [
            { value: 16, label: '16-bit WAV' },
            { value: 24, label: '24-bit WAV' },
            { value: 32, label: '32-bit float WAV' },
          ],
          (v) => store.patch((p) => ({ ...p, bitDepth: Number(v) as BitDepth })),
        ),
      ),
      h(
        'div',
        { class: 'row' },
        h('button', { onclick: () => this.apply({}) }, 'Rescan devices'),
        h(
          'span',
          { class: 'muted' },
          `Engine: ${s.backend} · input ${s.inputOpen ? `open, ${s.inputChannelCount} ch` : 'closed'} · output ${s.outputOpen ? `open, ${s.outputChannelCount} ch` : 'closed'} · project ${store.project.sampleRate / 1000} kHz`,
        ),
      ),
    );

    this.el.append(deviceCard, this.renderChannels(store.profile, s.inputChannelCount), this.renderTemplates());
  }

  private renderChannels(profile: DeviceProfile | null, channelCount: number): HTMLElement {
    this.meterEls = [];
    const card = h('section', { class: 'card' }, h('h2', null, 'Inputs'));
    if (!channelCount) {
      card.append(h('p', { class: 'muted' }, 'No input stream is open. Pick an input device above.'));
      return card;
    }
    const labels = profile?.inputs ?? Array.from({ length: channelCount }, (_, i) => ({ index: i, label: `Input ${i + 1}` }));
    append(card, [
      h('p', { class: 'muted' }, profile ? `Detected: ${profile.name}` : 'Generic interface'),
      profile?.note ? h('p', { class: 'hint' }, profile.note) : null,
    ]);
    const used = new Set(store.project.tracks.flatMap((t) => t.inputChannels));
    const suggestions = profile ? suggestTracks(profile) : [];
    const missing = suggestions.filter((sug) => !sug.inputChannels.every((c) => used.has(c)));
    card.append(
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            class: 'primary',
            disabled: missing.length === 0,
            onclick: () => {
              store.edit((p) => missing.reduce((q, sug) => addTrack(q, { name: sug.name, inputChannels: sug.inputChannels, armed: true }), p));
              toast(`Created ${missing.length} tracks`);
              store.setView('edit');
            },
          },
          missing.length ? `Create ${missing.length} speaker tracks` : 'All sources have tracks',
        ),
        h('span', { class: 'muted' }, 'One track per microphone / remote source, armed and ready to record.'),
      ),
    );
    const list = h('div', { class: 'channel-list' });
    for (const ch of labels) {
      if (ch.index >= channelCount) continue;
      const bar = h('div', { class: 'meter-fill' });
      const db = h('span', { class: 'meter-db' }, '–∞');
      this.meterEls[ch.index] = { bar, db };
      const stereoLeft = 'stereoLeft' in ch && ch.stereoLeft;
      const isRight = labels.some((x) => 'stereoLeft' in x && x.stereoLeft && x.index === ch.index - 1);
      list.append(
        h(
          'div',
          { class: `channel-row${used.has(ch.index) ? ' used' : ''}` },
          h('span', { class: 'ch-num' }, String(ch.index + 1)),
          h('span', { class: 'ch-label' }, ch.label),
          h('div', { class: 'meter' }, bar),
          db,
          isRight
            ? h('span', { class: 'ch-action' })
            : h(
                'button',
                {
                  class: 'small ch-action',
                  title: stereoLeft ? 'Add a stereo track for this pair' : 'Add a mono track for this input',
                  onclick: () => {
                    const name = ch.label.replace(/ L$/, '');
                    store.edit((p) => addTrack(p, { name, inputChannels: stereoLeft ? [ch.index, ch.index + 1] : [ch.index], armed: true }));
                    toast(`Track "${name}" added`);
                  },
                },
                stereoLeft ? '+ stereo track' : '+ track',
              ),
        ),
      );
    }
    card.append(list);
    return card;
  }

  private renderTemplates(): HTMLElement {
    return h(
      'section',
      { class: 'card' },
      h('h2', null, 'Templates'),
      h(
        'div',
        { class: 'row' },
        h('button', { onclick: () => this.onTemplates?.start() }, 'New episode from template…'),
        h('button', { disabled: !store.project.tracks.length, onclick: () => this.onTemplates?.save() }, 'Save setup as template…'),
        h('span', { class: 'muted' }, 'Tracks, input channels, filters and soundboard, without recordings.'),
      ),
    );
  }

  updateMeters(): void {
    const peaks = store.meterHold;
    this.meterEls.forEach((m, i) => {
      if (!m) return;
      const v = peaks[i] ?? 0;
      const db = toDb(v, -60);
      m.bar.style.width = `${((db + 60) / 60) * 100}%`;
      m.bar.classList.toggle('hot', db > -6);
      m.bar.classList.toggle('clip', db > -0.5);
      m.db.textContent = v > 0.00001 ? db.toFixed(0) : '–∞';
    });
  }
}
