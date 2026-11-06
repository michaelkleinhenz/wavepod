// Edit › Settings…: app-wide settings that don't belong to an episode, in tabs: General (sound library
// folder and transcription), Controllers (MIDI, Stream Deck/OSC) and AI agents (MCP).
import type { TranscriptionInfo } from '../shared/types';
import type { SoundLibraryInfo } from '../core/soundLibrary';
import { append, clear, errorMessage, h, toast } from './dom';
import { isMcpOn, renderMcpCard } from './mcpCard';
import { midi } from './midi';
import { renderMidiCard } from './midiCard';
import { isOscOn, renderOscCard } from './oscCard';
import { api, store } from './store';

export type SettingsTab = 'general' | 'controllers' | 'agents';
const TABS: Array<{ id: SettingsTab; label: string; blurb: string }> = [
  { id: 'general', label: 'General', blurb: 'The sound effects folder and how transcripts are made.' },
  { id: 'controllers', label: 'Controllers', blurb: 'Start recording, drop markers and fire jingles from a MIDI controller or Stream Deck.' },
  { id: 'agents', label: 'AI agents', blurb: 'Let AI apps on this computer help with filters and loudness.' },
];
const TAB_KEY = 'wavepod.settingsTab';

function savedTab(): SettingsTab {
  try {
    const t = localStorage.getItem(TAB_KEY);
    if (TABS.some((x) => x.id === t)) return t as SettingsTab;
  } catch {
    /* storage unavailable */
  }
  return 'general';
}

export class SettingsDialog {
  private overlay = h('div', { class: 'overlay' });
  private info: TranscriptionInfo | null = null;
  private library: SoundLibraryInfo | null = null;
  private keyDraft = '';
  private keytermsDraft: string | null = null;
  private tab: SettingsTab = savedTab();
  private dialog: HTMLElement | null = null;
  private tabBar: HTMLElement | null = null;

  constructor() {
    // MIDI learn, MCP and OSC status changes redraw their cards. The General tab only updates its tab dots,
    // so a redraw never takes the cursor out of the API key or terms field.
    store.subscribe((kinds) => {
      if (!this.overlay.isConnected || !(kinds.has('midi') || kinds.has('mcp') || kinds.has('osc'))) return;
      if (this.tab === 'general') this.tabBar?.replaceWith((this.tabBar = this.renderTabs()));
      else this.render();
    });
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay) this.close();
    });
    this.overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
  }

  /** Opens the dialog, on the given tab or on the one used last. */
  async open(tab?: SettingsTab): Promise<void> {
    if (tab) this.setTab(tab, false);
    this.keyDraft = '';
    this.keytermsDraft = null;
    document.body.append(this.overlay);
    this.render();
    void api()
      .getSoundLibrary()
      .then((l) => {
        this.library = l;
        this.render();
      })
      .catch(() => undefined);
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

  private async chooseLibrary(): Promise<void> {
    try {
      const l = await api().chooseSoundLibraryFolder();
      if (!l) return;
      this.library = l;
      window.dispatchEvent(new Event('wavepod:library-changed'));
      this.render();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  }

  private async clearLibrary(): Promise<void> {
    this.library = await api().clearSoundLibraryFolder();
    window.dispatchEvent(new Event('wavepod:library-changed'));
    this.render();
  }

  private setTab(tab: SettingsTab, redraw = true): void {
    if (tab === this.tab) return;
    if (this.keytermsDraft !== null) {
      const v = this.keytermsDraft;
      this.keytermsDraft = null;
      void this.save({ keyterms: v });
    }
    this.tab = tab;
    try {
      localStorage.setItem(TAB_KEY, tab);
    } catch {
      /* storage unavailable: the tab just isn't remembered */
    }
    if (!redraw) return;
    this.build();
    // a new tab starts at its top
    if (this.dialog) this.dialog.scrollTop = 0;
  }

  private render(): void {
    // the dialog is what scrolls; rebuilding it must not jump back to the top (e.g. on Learn)
    const top = this.dialog?.scrollTop ?? 0;
    this.build();
    if (this.dialog) this.dialog.scrollTop = top;
  }

  private renderTabs(): HTMLElement {
    const on: Record<SettingsTab, boolean> = {
      general: false,
      controllers: midi.settings.enabled || isOscOn(),
      agents: isMcpOn(),
    };
    return h(
      'div',
      { class: 'setup-tabs settings-tabs', role: 'tablist' },
      ...TABS.map((t) =>
        h(
          'button',
          {
            class: `setup-tab${t.id === this.tab ? ' active' : ''}`,
            role: 'tab',
            'aria-selected': String(t.id === this.tab),
            title: t.blurb,
            onclick: () => this.setTab(t.id),
          },
          t.label,
          on[t.id] ? h('span', { class: 'tab-dot on', title: 'Switched on' }) : null,
        ),
      ),
    );
  }

  private build(): void {
    clear(this.overlay);
    this.tabBar = this.renderTabs();
    const page = h('div', { class: 'settings-page', role: 'tabpanel' }, h('p', { class: 'setup-blurb muted' }, TABS.find((t) => t.id === this.tab)!.blurb));
    if (this.tab === 'general') append(page, this.renderGeneral());
    else if (this.tab === 'controllers') append(page, [renderMidiCard(), renderOscCard()]);
    else page.append(renderMcpCard());
    this.dialog = h(
      'div',
      { class: 'dialog settings-dialog' },
      h('div', { class: 'settings-head' }, h('h2', null, 'Settings'), this.tabBar),
      page,
      h('div', { class: 'row end settings-foot' }, h('button', { class: 'primary', onclick: () => this.close() }, 'Done')),
    );
    this.overlay.append(this.dialog);
  }

  private renderGeneral(): Array<HTMLElement | null> {
    const info = this.info;
    const s = info?.settings;
    const saveKey = () => {
      const key = this.keyDraft.trim();
      this.keyDraft = '';
      void this.save({ apiKey: key }, key ? 'ElevenLabs API key saved' : 'ElevenLabs API key removed');
    };
    return [
      h('h3', null, 'Sound library'),
      h('p', { class: 'muted' }, 'A folder of sound effects and atmospheres (subfolders included). Search it in View › Sound Library (Shift+Ctrl+B), listen, and insert sounds into the episode.'),
      h(
        'div',
        { class: 'row settings-library' },
        h('span', { class: `settings-library-path${this.library?.folder ? '' : ' muted'}`, title: this.library?.folder ?? '' }, this.library?.folder || 'No folder chosen'),
        h('button', { class: 'small', onclick: () => void this.chooseLibrary() }, this.library?.folder ? 'Change…' : 'Choose folder…'),
        this.library?.folder ? h('button', { class: 'small', onclick: () => void this.clearLibrary() }, 'Remove') : null,
      ),
      this.library?.folder
        ? h('p', { class: this.library.error ? 'error-text' : 'ok-text' }, this.library.error ?? `✓ ${this.library.files.length.toLocaleString()} sound${this.library.files.length === 1 ? '' : 's'} found`)
        : null,
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
    ];
  }
}
