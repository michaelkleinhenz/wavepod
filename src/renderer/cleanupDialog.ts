// Edit › Clean Up Pauses and Hesitations…: finds long pauses (from the audio) and hesitations
// (from the transcript), lists them to listen to and untick, and takes them out in one undo step.
import type { CleanupItem, CleanupOptions, Project } from '../shared/types';
import { CLEANUP_DEFAULTS, applyCleanup, cleanupSaving } from '../core/cleanup';
import { addMarker } from '../core/project';
import { formatTimestamp } from '../shared/time';
import { clear, errorMessage, h, keepScroll, toast } from './dom';
import { api, store } from './store';
import { transcripts } from './transcripts';

const PREVIEW_PAD_SECONDS = 1.5;
const OPTIONS_KEY = 'wavepod.cleanup';

function loadOptions(): CleanupOptions {
  try {
    return { ...CLEANUP_DEFAULTS, ...(JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? '{}') as Partial<CleanupOptions>) };
  } catch {
    return { ...CLEANUP_DEFAULTS };
  }
}

export class CleanupDialog {
  private overlay = h('div', { class: 'overlay' });
  private opts = loadOptions();
  private items: CleanupItem[] | null = null;
  private chosen = new Set<string>();
  /** The project the items were found in; any edit since makes their positions stale. */
  private foundIn: Project | null = null;
  private busy = false;

  constructor() {
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay && !this.busy) this.close();
    });
    this.overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.busy) this.close();
    });
  }

  open(): void {
    if (!store.project.tracks.some((t) => t.clips.length)) return toast('There is no audio to clean up yet');
    this.items = null;
    this.foundIn = null;
    void transcripts().ensureLoaded().then(() => this.render());
    document.body.append(this.overlay);
    this.render();
  }

  close(): void {
    this.overlay.remove();
  }

  private setOpt(patch: Partial<CleanupOptions>): void {
    this.opts = { ...this.opts, ...patch };
    try {
      localStorage.setItem(OPTIONS_KEY, JSON.stringify(this.opts));
    } catch {
      /* not remembered */
    }
    this.items = null;
    this.render();
  }

  private async find(): Promise<void> {
    const hasWords = transcripts().words().length > 0;
    const opts = { ...this.opts, fillers: this.opts.fillers && hasWords };
    if (!opts.pauses && !opts.fillers) return toast(this.opts.fillers && !hasWords ? 'Transcribe the episode first to find hesitations' : 'Choose what to look for');
    this.busy = true;
    this.render();
    try {
      const project = store.project;
      this.items = await api().findCleanup(opts);
      this.foundIn = project;
      this.chosen = new Set(this.items.map((i) => i.id));
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private async preview(item: CleanupItem): Promise<void> {
    const pad = Math.round(PREVIEW_PAD_SECONDS * store.sampleRate);
    store.preview = { end: item.end + pad, origin: store.transport.position };
    try {
      if (store.transport.state === 'playing') await api().stop();
      await api().play(Math.max(0, item.start - pad));
    } catch (e) {
      store.preview = null;
      toast(errorMessage(e), 'error');
    }
  }

  private selected(): CleanupItem[] {
    return (this.items ?? []).filter((i) => this.chosen.has(i.id));
  }

  private apply(): void {
    const items = this.selected();
    if (!items.length) return;
    const saved = cleanupSaving(items);
    store.edit((p) => applyCleanup(p, items));
    store.select({ range: null, rangeTracks: null, clipIds: new Set() });
    toast(`Cleaned up ${items.length} spot${items.length === 1 ? '' : 's'}: ${(saved / store.sampleRate).toFixed(1)} s shorter (Ctrl+Z undoes it)`);
    this.close();
  }

  private mark(): void {
    const items = this.selected();
    if (!items.length) return;
    store.edit((p) => items.reduce((q, i) => addMarker(q, i.start, 'edit', label(i)).project, p));
    toast(`Marked ${items.length} spot${items.length === 1 ? '' : 's'} with edit markers`);
    this.close();
  }

  private render(): void {
    keepScroll(this.overlay, () => this.build());
  }

  private build(): void {
    clear(this.overlay);
    const sr = store.sampleRate;
    const hasWords = transcripts().words().length > 0;
    const stale = !!this.items && this.foundIn !== store.project;
    const names = new Map(store.project.tracks.map((t) => [t.id, t.name]));
    const items = stale ? null : this.items;
    const chosen = this.selected();
    const options = h(
      'div',
      { class: 'cleanup-options' },
      h(
        'label',
        { class: 'check' },
        h('input', { type: 'checkbox', checked: this.opts.pauses, onchange: (e: Event) => this.setOpt({ pauses: (e.target as HTMLInputElement).checked }) }),
        'Shorten pauses longer than ',
        seconds(this.opts.maxPause, 0.5, 10, (v) => this.setOpt({ maxPause: v })),
        ' s to ',
        seconds(this.opts.keepPause, 0.1, 5, (v) => this.setOpt({ keepPause: v })),
        ' s',
      ),
      h(
        'label',
        { class: 'check', title: hasWords ? '' : 'Needs a transcript: View › Transcript › Transcribe' },
        h('input', { type: 'checkbox', checked: this.opts.fillers && hasWords, disabled: !hasWords, onchange: (e: Event) => this.setOpt({ fillers: (e.target as HTMLInputElement).checked }) }),
        'Remove hesitations (äh, ähm, öhm, hm, uh, um…)',
        hasWords ? null : h('span', { class: 'muted' }, ' · transcribe the episode first'),
      ),
      h('div', { class: 'row' }, h('button', { class: 'primary', disabled: this.busy, onclick: () => void this.find() }, this.busy ? 'Looking…' : items ? 'Find again' : 'Find')),
    );
    const list = items
      ? items.length
        ? h(
            'div',
            { class: 'cleanup-list' },
            h(
              'label',
              { class: 'check cleanup-all' },
              h('input', {
                type: 'checkbox',
                checked: chosen.length === items.length,
                onchange: (e: Event) => {
                  this.chosen = (e.target as HTMLInputElement).checked ? new Set(items.map((i) => i.id)) : new Set();
                  this.render();
                },
              }),
              `${items.filter((i) => i.kind === 'pause').length} pauses, ${items.filter((i) => i.kind === 'filler').length} hesitations`,
            ),
            ...items.map((item) =>
              h(
                'div',
                { class: `cleanup-item ${item.kind}` },
                h('input', {
                  type: 'checkbox',
                  checked: this.chosen.has(item.id),
                  onchange: (e: Event) => {
                    if ((e.target as HTMLInputElement).checked) this.chosen.add(item.id);
                    else this.chosen.delete(item.id);
                    this.render();
                  },
                }),
                h('button', { class: 'small icon-only', title: 'Listen (from a little before to a little after)', onclick: () => void this.preview(item) }, '▶'),
                h('span', { class: 'cleanup-time' }, formatTimestamp(item.start / sr, false)),
                h(
                  'span',
                  { class: 'cleanup-what' },
                  item.kind === 'pause'
                    ? `Pause ${((item.pauseLength ?? 0) / sr).toFixed(1)} s → ${(((item.pauseLength ?? 0) - (item.end - item.start)) / sr).toFixed(1)} s`
                    : h('span', null, h('b', null, `“${item.text}”`), ` ${names.get(item.trackId ?? '') ?? ''}`),
                ),
                item.kind === 'filler'
                  ? h(
                      'select',
                      {
                        class: 'cleanup-action',
                        title: 'Cut takes it out of every track and closes the gap; Mute silences it on its own track only (use it when someone else talks at the same time)',
                        onchange: (e: Event) => {
                          item.action = (e.target as HTMLSelectElement).value as CleanupItem['action'];
                          this.render();
                        },
                      },
                      h('option', { value: 'cut', selected: item.action === 'cut' }, 'Cut'),
                      h('option', { value: 'mute', selected: item.action === 'mute' }, 'Mute'),
                    )
                  : h('span', { class: 'cleanup-action muted' }, 'Cut'),
              ),
            ),
          )
        : h('p', { class: 'muted' }, 'Nothing found: no pause is that long, and no hesitations in the transcript.')
      : stale
        ? h('p', { class: 'warning' }, 'The episode changed since the search. Find again.')
        : null;
    const dialog = h(
      'div',
      { class: 'dialog cleanup-dialog' },
      h('h2', null, 'Clean up pauses and hesitations'),
      h('p', { class: 'muted' }, 'Pauses are found in the mix (the middle of each is taken out, so breaths stay). Hesitations come from the transcript; each cut is moved to the quiet points around the sound. Untick what should stay, listen with ▶.'),
      options,
      list,
      h(
        'div',
        { class: 'row end' },
        items?.length ? h('span', { class: 'muted cleanup-sum' }, `${chosen.length} selected · ${(cleanupSaving(chosen) / sr).toFixed(1)} s shorter`) : null,
        h('button', { disabled: this.busy, onclick: () => this.close() }, 'Close'),
        items?.length ? h('button', { disabled: !chosen.length, title: 'Only put edit markers there, to decide by hand', onclick: () => this.mark() }, 'Mark only') : null,
        items?.length ? h('button', { class: 'primary', disabled: !chosen.length, onclick: () => this.apply() }, `Apply ${chosen.length}`) : null,
      ),
    );
    this.overlay.append(dialog);
  }
}

function label(i: CleanupItem): string {
  return i.kind === 'pause' ? 'Long pause' : `Hesitation “${i.text ?? ''}”`;
}

function seconds(value: number, min: number, max: number, set: (v: number) => void): HTMLInputElement {
  return h('input', {
    type: 'number',
    class: 'cleanup-seconds',
    min: String(min),
    max: String(max),
    step: '0.1',
    value: String(value),
    onchange: (e: Event) => {
      const v = Number((e.target as HTMLInputElement).value);
      if (Number.isFinite(v)) set(Math.min(max, Math.max(min, v)));
    },
  });
}
