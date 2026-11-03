// File › Send to Auphonic…: API key, preset, and the upload of stems, chapters, metadata and cover.
import type { AuphonicInfo, ExportProgress } from '../shared/types';
import { clear, errorMessage, h, keepScroll, toast } from './dom';
import { api, store } from './store';

export class AuphonicDialog {
  private overlay = h('div', { class: 'overlay' });
  private info: AuphonicInfo | null = null;
  private presets: Array<{ uuid: string; name: string }> | null = null;
  private presetError = '';
  private busy = false;
  private status = '';
  private result: { url: string; started: boolean } | null = null;
  private keyDraft = '';

  constructor() {
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay && !this.busy) this.close();
    });
    this.overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.busy) this.close();
    });
    api().onExportProgress((p) => this.progress(p));
  }

  async open(): Promise<void> {
    if (!store.project.tracks.some((t) => t.clips.length)) return toast('There is no audio to send yet');
    this.result = null;
    this.status = '';
    this.keyDraft = '';
    document.body.append(this.overlay);
    this.render();
    try {
      this.info = await api().getAuphonicSettings();
      this.render();
      if (this.info.hasKey) await this.loadPresets();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  }

  close(): void {
    this.overlay.remove();
  }

  private async loadPresets(): Promise<void> {
    this.presetError = '';
    try {
      this.presets = await api().auphonicPresets();
    } catch (e) {
      this.presets = null;
      this.presetError = errorMessage(e);
    }
    this.render();
  }

  private async saveKey(): Promise<void> {
    try {
      this.info = await api().setAuphonicSettings({ apiKey: this.keyDraft });
      this.keyDraft = '';
      this.render();
      if (this.info.hasKey) await this.loadPresets();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  }

  private progress(p: ExportProgress): void {
    if (!this.busy) return;
    this.status = p.phase === 'Done' ? '' : `${p.phase}${p.fraction > 0 && p.fraction < 1 ? ` ${Math.round(p.fraction * 100)}%` : ''}`;
    const el = this.overlay.querySelector('.auphonic-status');
    if (el) el.textContent = this.status;
  }

  private async send(): Promise<void> {
    this.busy = true;
    this.status = 'Rendering tracks…';
    this.render();
    try {
      const r = await api().sendToAuphonic();
      this.result = r;
      this.status = '';
      toast(r.started ? 'Sent to Auphonic, production started' : 'Sent to Auphonic');
    } catch (e) {
      this.status = '';
      toast(errorMessage(e), 'error');
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private render(): void {
    keepScroll(this.overlay, () => this.build());
  }

  private build(): void {
    clear(this.overlay);
    const info = this.info;
    const tracks = store.project.tracks.filter((t) => t.clips.length);
    const keyRow = h(
      'div',
      { class: 'row' },
      h('input', {
        type: 'password',
        class: 'auphonic-key',
        placeholder: info?.hasKey ? 'API key saved (type a new one to replace it)' : 'API key from auphonic.com → Account Settings',
        value: this.keyDraft,
        oninput: (e: Event) => (this.keyDraft = (e.target as HTMLInputElement).value),
      }),
      h('button', { class: 'small', disabled: this.busy, onclick: () => void this.saveKey() }, this.keyDraft || !info?.hasKey ? 'Save key' : 'Remove key'),
    );
    const presetSel = h(
      'select',
      {
        disabled: !info?.hasKey || this.busy,
        onchange: async (e: Event) => {
          this.info = await api().setAuphonicSettings({ preset: (e.target as HTMLSelectElement).value });
        },
      },
      h('option', { value: '' }, 'No preset (Auphonic defaults)'),
      ...(this.presets ?? []).map((p) => h('option', { value: p.uuid, selected: p.uuid === info?.preset }, p.name)),
    );
    const dialog = h(
      'div',
      { class: 'dialog narrow auphonic-dialog' },
      h('h2', null, 'Send to Auphonic'),
      h(
        'p',
        { class: 'muted' },
        `Creates a multitrack production on auphonic.com with ${tracks.length} track${tracks.length === 1 ? '' : 's'} (${tracks.map((t) => t.name).join(', ')}) as FLAC, the chapters, the episode details and the cover. Track filters and volume are rendered in; the master filters are left to Auphonic.`,
      ),
      h('h3', null, 'API key'),
      keyRow,
      h('h3', null, 'Preset'),
      h('label', { class: 'field' }, presetSel),
      this.presetError ? h('p', { class: 'warning' }, this.presetError) : null,
      h(
        'label',
        { class: 'check' },
        h('input', {
          type: 'checkbox',
          checked: !!info?.start,
          disabled: !info?.hasKey || this.busy,
          onchange: async (e: Event) => {
            this.info = await api().setAuphonicSettings({ start: (e.target as HTMLInputElement).checked });
          },
        }),
        'Start the production right away (otherwise review it on auphonic.com first)',
      ),
      this.result
        ? h(
            'p',
            null,
            this.result.started ? 'Sent and started. ' : 'Sent. ',
            h('a', { href: '#', onclick: (e: Event) => (e.preventDefault(), void api().openAuphonic(this.result!.url)) }, 'Open the production on auphonic.com'),
          )
        : null,
      h('div', { class: 'row' }, h('span', { class: 'auphonic-status muted' }, this.status)),
      h(
        'div',
        { class: 'row end' },
        h('button', { disabled: this.busy, onclick: () => this.close() }, 'Close'),
        h('button', { class: 'primary', disabled: this.busy || !info?.hasKey, onclick: () => void this.send() }, this.busy ? 'Sending…' : 'Send'),
      ),
    );
    this.overlay.append(dialog);
  }
}
