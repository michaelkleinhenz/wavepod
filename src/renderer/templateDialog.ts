// Templates: start a new episode from a saved setup, or save the current setup as a template.
import type { TemplateSummary } from '../core/template';
import { templateFolderName } from '../core/template';
import { clear, errorMessage, h, keepScroll, toast } from './dom';
import { api, store } from './store';
import { askEpisodeName, newProject } from './actions';

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function describe(t: TemplateSummary): string {
  const parts = [plural(t.trackCount, 'track'), plural(t.filterCount, 'filter'), plural(t.slotCount, 'jingle')];
  if (t.inputDevice) parts.push(t.inputDevice);
  return parts.join(' · ');
}

export class TemplateDialog {
  private overlay = h('div', { class: 'overlay' });
  private templates: TemplateSummary[] = [];
  private mode: 'new' | 'save' = 'new';
  private name = '';
  private busy = false;

  constructor() {
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay && !this.busy) this.close();
    });
    this.overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.busy) this.close();
    });
  }

  /** Lists the templates to start a new episode from. */
  async openNew(): Promise<void> {
    this.mode = 'new';
    await this.open();
  }

  /** Asks for a name and saves the current setup. */
  async openSave(): Promise<void> {
    this.mode = 'save';
    this.name = store.project.metadata.podcast || '';
    await this.open();
    this.overlay.querySelector<HTMLInputElement>('input.template-name')?.focus();
  }

  close(): void {
    this.overlay.remove();
  }

  private async open(): Promise<void> {
    try {
      this.templates = await api().listTemplates();
    } catch (e) {
      this.templates = [];
      toast(errorMessage(e), 'error');
    }
    this.render();
    if (!this.overlay.isConnected) document.body.append(this.overlay);
  }

  private render(): void {
    keepScroll(this.overlay, () => this.build());
  }

  private build(): void {
    clear(this.overlay);
    this.overlay.append(this.mode === 'new' ? this.renderNew() : this.renderSave());
  }

  private renderNew(): HTMLElement {
    const list = this.templates.length
      ? h(
          'div',
          { class: 'template-list' },
          ...this.templates.map((t) =>
            h(
              'div',
              { class: 'template-item' },
              h(
                'button',
                { class: 'template-use', disabled: this.busy, title: 'New episode with this setup', onclick: () => void this.use(t) },
                h('span', { class: 'template-title' }, t.name),
                h('span', { class: 'muted' }, describe(t)),
              ),
              h('button', { class: 'small', disabled: this.busy, title: 'Delete template', onclick: () => void this.remove(t) }, 'Delete'),
            ),
          ),
        )
      : h('p', { class: 'muted' }, 'No templates yet. Set up an episode the way you like it, then use File › Save as Template….');
    return h(
      'div',
      { class: 'dialog template-dialog' },
      h('h2', null, 'New episode from template'),
      h('p', { class: 'muted' }, 'A template sets up tracks, input channels, filters (including Master FX and VST3 settings) and the soundboard. It contains no recorded audio.'),
      list,
      h(
        'div',
        { class: 'row end' },
        h('button', { onclick: () => void api().showTemplatesFolder() }, 'Show folder'),
        h('div', { class: 'spacer' }),
        h('button', { disabled: this.busy, onclick: () => this.close() }, 'Cancel'),
        h('button', { disabled: this.busy, onclick: () => void this.blank() }, 'Blank episode'),
      ),
    );
  }

  private renderSave(): HTMLElement {
    const p = store.project;
    const filters = (p.masterFx?.length ?? 0) + p.tracks.reduce((n, t) => n + (t.fx?.length ?? 0), 0);
    const existing = this.templates.find((t) => t.id === templateFolderName(this.name));
    const saveBtn = h('button', { class: 'primary', disabled: this.busy || !this.name.trim(), onclick: () => void this.save() }, existing ? 'Replace' : 'Save');
    const hint = h('p', { class: 'muted template-hint' }, existing ? `This replaces the template "${existing.name}".` : '');
    const input = h('input', {
      class: 'template-name',
      type: 'text',
      value: this.name,
      placeholder: 'e.g. Weekly show, 3 speakers',
      oninput: (e: Event) => {
        this.name = (e.target as HTMLInputElement).value;
        const ex = this.templates.find((t) => t.id === templateFolderName(this.name));
        saveBtn.textContent = ex ? 'Replace' : 'Save';
        saveBtn.disabled = this.busy || !this.name.trim();
        hint.textContent = ex ? `This replaces the template "${ex.name}".` : '';
      },
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter' && this.name.trim()) void this.save();
      },
    });
    return h(
      'div',
      { class: 'dialog template-dialog' },
      h('h2', null, 'Save as template'),
      h(
        'p',
        { class: 'muted' },
        `Saves ${plural(p.tracks.length, 'track')} with their input channels, ${plural(filters, 'filter')} and ${plural(p.soundboard.length, 'jingle')}. ` +
          'Recordings, markers and volume lines are not included.',
      ),
      h('label', { class: 'field' }, h('span', null, 'Name'), input),
      hint,
      h('div', { class: 'row end' }, h('button', { disabled: this.busy, onclick: () => this.close() }, 'Cancel'), saveBtn),
    );
  }

  private async run(fn: () => Promise<void>): Promise<void> {
    this.busy = true;
    this.render();
    try {
      await fn();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      this.busy = false;
      if (this.overlay.isConnected) this.render();
    }
  }

  private async use(t: TemplateSummary): Promise<void> {
    if (await newFromTemplate(t)) this.close();
  }

  private async blank(): Promise<void> {
    if (await newProject()) this.close();
  }

  private remove(t: TemplateSummary): Promise<void> {
    if (!window.confirm(`Delete the template "${t.name}"?`)) return Promise.resolve();
    return this.run(async () => {
      await api().deleteTemplate(t.id);
      this.templates = await api().listTemplates();
    });
  }

  private save(): Promise<void> {
    const name = this.name.trim();
    return this.run(async () => {
      const t = await api().saveTemplate(name);
      this.close();
      toast(`Saved template "${t.name}"`);
    });
  }
}

/** Asks for a name, then starts a new episode set up like the template. Returns false if cancelled or failed. */
export async function newFromTemplate(t: TemplateSummary, typedName?: string): Promise<boolean> {
  if (store.transport.state === 'recording') {
    toast('Stop recording before starting a new episode');
    return false;
  }
  const name = typedName ?? (await askEpisodeName(`New episode from “${t.name}”`));
  if (!name) return false;
  try {
    const res = await api().newProjectFromTemplate(t.id, name);
    store.setProject(res.project, res.dir);
    toast(`New episode “${name}” from “${t.name}”`);
    return true;
  } catch (e) {
    toast(errorMessage(e), 'error');
    return false;
  }
}
