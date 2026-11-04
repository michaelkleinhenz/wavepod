// Edit › Settings…: app-wide settings that don't belong to an episode. For now: transcription.
import type { TranscriptionInfo } from '../shared/types';
import { clear, errorMessage, h, keepScroll, toast } from './dom';
import { api } from './store';

export class SettingsDialog {
  private overlay = h('div', { class: 'overlay' });
  private info: TranscriptionInfo | null = null;
  private keyDraft = '';
  private keytermsDraft: string | null = null;

  constructor() {
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay) this.close();
    });
    this.overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
  }

  async open(): Promise<void> {
    this.keyDraft = '';
    this.keytermsDraft = null;
    document.body.append(this.overlay);
    this.render();
    try {
      this.info = await api().getTranscriptionInfo();
      this.render();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  }

  close(): void {
    if (this.keytermsDraft !== null) void this.save({ keyterms: this.keytermsDraft });
    this.overlay.remove();
  }

  private async save(input: Parameters<ReturnType<typeof api>['setTranscriptionSettings']>[0], message?: string): Promise<void> {
    try {
      this.info = await api().setTranscriptionSettings(input);
      if (message) toast(message);
      this.render();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  }

  private render(): void {
    keepScroll(this.overlay, () => this.build());
  }

  private build(): void {
    clear(this.overlay);
    const info = this.info;
    const s = info?.settings;
    const saveKey = () => {
      const key = this.keyDraft.trim();
      this.keyDraft = '';
      void this.save({ apiKey: key }, key ? 'ElevenLabs API key saved' : 'ElevenLabs API key removed');
    };
    const dialog = h(
      'div',
      { class: 'dialog narrow settings-dialog' },
      h('h2', null, 'Settings'),
      h('h3', null, 'Transcription'),
      h(
        'p',
        { class: 'muted' },
        'Transcripts are made by ElevenLabs speech-to-text (Scribe): each track is uploaded as a small 16 kHz mono file and comes back with every word and its time. ',
        'Uploading costs speech-to-text credits on your ElevenLabs account. The transcripts are kept in the episode folder.',
      ),
      h(
        'label',
        { class: 'field' },
        h('span', null, 'ElevenLabs API key'),
        h(
          'div',
          { class: 'row' },
          h('input', {
            type: 'password',
            class: 'settings-key',
            autocomplete: 'off',
            placeholder: info?.hasKey ? 'Saved (type a new one to replace it)' : 'From elevenlabs.io → Developers → API Keys',
            value: this.keyDraft,
            oninput: (e: Event) => {
              this.keyDraft = (e.target as HTMLInputElement).value;
              const btn = this.overlay.querySelector<HTMLButtonElement>('.settings-key-save');
              if (!btn) return;
              btn.textContent = this.keyDraft || !info?.hasKey ? 'Save key' : 'Remove key';
              btn.disabled = !info || (!this.keyDraft && !info.hasKey);
            },
            onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && saveKey(),
          }),
          h('button', { class: 'small settings-key-save', disabled: !info || (!this.keyDraft && !info.hasKey), onclick: saveKey }, this.keyDraft || !info?.hasKey ? 'Save key' : 'Remove key'),
        ),
      ),
      info?.hasKey ? h('p', { class: 'ok-text' }, '✓ API key saved (kept encrypted with your system keychain where available)') : null,
      h(
        'div',
        { class: 'settings-grid' },
        h(
          'label',
          { class: 'field' },
          h('span', null, 'Model'),
          h(
            'select',
            { disabled: !info, onchange: (e: Event) => void this.save({ model: (e.target as HTMLSelectElement).value }) },
            ...(info?.models ?? []).map((m) => h('option', { value: m.id, selected: m.id === s?.model, title: m.description }, m.name)),
          ),
        ),
        h(
          'label',
          { class: 'field' },
          h('span', null, 'Language'),
          h(
            'select',
            { disabled: !info, onchange: (e: Event) => void this.save({ language: (e.target as HTMLSelectElement).value }) },
            ...(info?.languages ?? []).map((l) => h('option', { value: l.code, selected: l.code === s?.language }, l.name)),
          ),
        ),
      ),
      h(
        'label',
        { class: 'field' },
        h('span', null, 'Names and terms to get right'),
        h('textarea', {
          rows: 2,
          placeholder: 'Guest names, products, places… separated by commas',
          value: this.keytermsDraft ?? s?.keyterms ?? '',
          oninput: (e: Event) => (this.keytermsDraft = (e.target as HTMLTextAreaElement).value),
          onblur: () => {
            if (this.keytermsDraft === null) return;
            const v = this.keytermsDraft;
            this.keytermsDraft = null;
            void this.save({ keyterms: v });
          },
        }),
      ),
      h('div', { class: 'row end' }, h('button', { class: 'primary', onclick: () => this.close() }, 'Done')),
    );
    this.overlay.append(dialog);
  }
}
