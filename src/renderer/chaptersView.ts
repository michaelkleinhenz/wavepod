// Chapters & episode info: edit chapter titles/URLs/times, edit markers, import/export chapter files, metadata.
import type { Region, EpisodeMetadata, Marker } from '../shared/types';
import { formatTimestamp, parseTimestamp } from '../shared/time';
import { CHAPTER_FORMATS, exportChapters } from '../core/chapters';
import { addMarker, chapterWarnings, markersToChapters, moveChapterContent, removeMarker, updateMarker } from '../core/project';
import { projectLength } from '../core/project';
import { clear, errorMessage, h, keepScroll, toast } from './dom';
import { importChapterFile, seek } from './actions';
import { api, store } from './store';

/** Top-level podcast directory categories (Apple Podcasts / Podcasting 2.0 list). */
const PODCAST_CATEGORIES = ['Arts', 'Business', 'Comedy', 'Education', 'Fiction', 'Government', 'Health & Fitness', 'History', 'Kids & Family', 'Leisure', 'Music', 'News', 'Religion & Spirituality', 'Science', 'Society & Culture', 'Sports', 'Technology', 'True Crime', 'TV & Film'];
import { removeRegion, updateRegion } from '../core/regions';
import { thumbnail } from './images';

/** Asks for an image and copies it into the project; null if cancelled or failed (failure is shown). */
async function chooseImage(title: string): Promise<string | null> {
  try {
    return await api().pickImage(title);
  } catch (e) {
    toast(errorMessage(e), 'error');
    return null;
  }
}

/** Image picker cell: thumbnail (click to change) and a remove button, or an "Image…" button. */
export function imagePicker(current: string | undefined, title: string, size: 'small' | 'large', set: (rel: string | undefined) => void): HTMLElement {
  const choose = async () => {
    const rel = await chooseImage(title);
    if (rel) set(rel);
  };
  if (!current) return h('button', { class: 'small', title, onclick: () => void choose() }, size === 'large' ? 'Choose image…' : 'Image…');
  const img = thumbnail(current, `thumb ${size}`);
  img.title = `${current} (click to change)`;
  img.onclick = () => void choose();
  return h('div', { class: 'image-pick' }, img, h('button', { class: 'small danger', title: 'Remove image', onclick: () => set(undefined) }, '×'));
}

export class ChaptersView {
  readonly el = h('div', { class: 'view chapters-view' });
  /** Chapter whose content is being dragged to another chapter slot. */
  private dragId: string | null = null;

  render(): void {
    keepScroll(this.el, () => this.build());
  }

  private build(): void {
    clear(this.el);
    const sr = store.sampleRate;
    const chapters = store.project.markers.filter((m) => m.kind === 'chapter');
    const edits = store.project.markers.filter((m) => m.kind === 'edit');

    const timeInput = (m: Marker) =>
      h('input', {
        class: 'time',
        value: formatTimestamp(m.position / sr),
        onchange: (e: Event) => {
          const secs = parseTimestamp((e.target as HTMLInputElement).value);
          if (Number.isNaN(secs)) {
            toast('Use HH:MM:SS.mmm', 'error');
            this.render();
            return;
          }
          store.edit((p) => updateMarker(p, m.id, { position: Math.round(secs * sr) }));
        },
      });

    const moveContent = (fromId: string, toId: string) => store.edit((p) => moveChapterContent(p, fromId, toId));
    const row = (m: Marker, withUrl: boolean, index = 0) => {
      const prev = withUrl ? chapters[index - 1] : undefined;
      const next = withUrl ? chapters[index + 1] : undefined;
      const tr = h(
        'tr',
        { class: store.selection.markerId === m.id ? 'selected' : '' },
        withUrl ? h('td', { class: 'grip', title: 'Drag to move this title, link and image to another chapter. The start times stay where they are.' }, '⋮⋮') : null,
        h('td', null, timeInput(m)),
        h(
          'td',
          null,
          h('input', {
            class: 'title',
            value: m.title,
            placeholder: 'Title',
            onchange: (e: Event) => store.edit((p) => updateMarker(p, m.id, { title: (e.target as HTMLInputElement).value })),
          }),
        ),
        withUrl
          ? h(
              'td',
              null,
              h('input', {
                class: 'url',
                value: m.url ?? '',
                placeholder: 'https://… (optional)',
                onchange: (e: Event) => {
                  const url = (e.target as HTMLInputElement).value.trim();
                  store.edit((p) => updateMarker(p, m.id, { url: url || undefined }));
                },
              }),
            )
          : null,
        withUrl
          ? h('td', { class: 'image' }, imagePicker(m.image, 'Chapter image', 'small', (image) => store.edit((p) => updateMarker(p, m.id, { image }))))
          : null,
        h(
          'td',
          { class: 'actions' },
          withUrl
            ? h('button', { class: 'small', title: 'Move title, link and image to the chapter above (start times stay)', disabled: !prev, onclick: () => prev && moveContent(m.id, prev.id) }, '↑')
            : null,
          withUrl
            ? h('button', { class: 'small', title: 'Move title, link and image to the chapter below (start times stay)', disabled: !next, onclick: () => next && moveContent(m.id, next.id) }, '↓')
            : null,
          h('button', { class: 'small', title: 'Jump to marker', onclick: () => { seek(m.position); store.select({ markerId: m.id }); store.setView('edit'); } }, '▶'),
          withUrl ? null : h('button', { class: 'small', title: 'Turn into chapter', onclick: () => store.edit((p) => updateMarker(p, m.id, { kind: 'chapter' })) }, '→ chapter'),
          h('button', { class: 'small danger', title: 'Delete marker', onclick: () => store.edit((p) => removeMarker(p, m.id)) }, '×'),
        ),
      );
      if (withUrl) this.makeDraggable(tr, m, index, moveContent);
      return tr;
    };

    const chapterCard = h(
      'section',
      { class: 'card' },
      h(
        'div',
        { class: 'card-head' },
        h('h2', null, `Chapters (${chapters.length})`),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'small', onclick: () => store.edit((p) => addMarker(p, store.transport.position, 'chapter').project) }, '+ at playhead'),
          h('button', { class: 'small', onclick: () => void importChapterFile() }, 'Import…'),
          ...CHAPTER_FORMATS.map((f) =>
            h(
              'button',
              {
                class: 'small',
                title: `Export as ${f.label}`,
                disabled: chapters.length === 0,
                onclick: async () => {
                  try {
                    const text = exportChapters(markersToChapters(store.project), f.id, projectLength(store.project) / sr);
                    const p = await api().saveTextFile(`${safe(store.project.metadata.title || store.project.name)}.${f.ext}`, text);
                    if (p) toast(`Saved ${p}`);
                  } catch (e) {
                    toast(errorMessage(e), 'error');
                  }
                },
              },
              `Export ${f.id}`,
            ),
          ),
        ),
      ),
      chapters.length
        ? h(
            'table',
            { class: 'markers' },
            h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Start'), h('th', null, 'Title'), h('th', null, 'Link'), h('th', null, 'Image'), h('th', null, ''))),
            h('tbody', null, ...chapters.map((m, i) => row(m, true, i))),
          )
        : h('p', { class: 'muted' }, 'Press M while recording or playing to drop a chapter marker at the playhead. Chapters are embedded in the MP3 export and written as chapter files.'),
      chapterWarningList(),
    );

    const editCard = h(
      'section',
      { class: 'card' },
      h('h2', null, `Edit markers (${edits.length})`),
      edits.length
        ? h(
            'table',
            { class: 'markers' },
            h('thead', null, h('tr', null, h('th', null, 'Position'), h('th', null, 'Note'), h('th', null, ''))),
            h('tbody', null, ...edits.map((m) => row(m, false))),
          )
        : h('p', { class: 'muted' }, 'Press E to mark a spot to fix later (a cough, a restart, a long pause). Edit markers are not exported.'),
    );

    const meta = store.project.metadata;
    const field = (key: keyof EpisodeMetadata, label: string, multiline = false) =>
      h(
        'label',
        { class: 'field' },
        h('span', null, label),
        h(multiline ? 'textarea' : 'input', {
          value: meta[key],
          onchange: (e: Event) => {
            const v = (e.target as HTMLInputElement).value;
            store.edit((p) => ({ ...p, metadata: { ...p.metadata, [key]: v }, name: key === 'title' && v ? v : p.name }));
          },
        }),
      );
    const metaCard = h(
      'section',
      { class: 'card' },
      h('h2', null, 'Episode'),
      h(
        'div',
        { class: 'grid' },
        field('title', 'Episode title'),
        field('podcast', 'Podcast'),
        field('author', 'Author'),
        field('episode', 'Episode number'),
        field('year', 'Year'),
        h(
          'label',
          { class: 'field' },
          h('span', null, 'Category'),
          h('input', {
            value: meta.category ?? '',
            placeholder: 'Podcast',
            list: 'podcast-categories',
            title: 'Written into the MP3 and FLAC as the genre. Pick one of the podcast directory categories or type your own.',
            onchange: (e: Event) => {
              const v = (e.target as HTMLInputElement).value.trim();
              store.edit((p) => {
                const { category: _c, ...rest } = p.metadata;
                return { ...p, metadata: v ? { ...rest, category: v } : rest };
              });
            },
          }),
          h('datalist', { id: 'podcast-categories' }, ...PODCAST_CATEGORIES.map((c) => h('option', { value: c }))),
        ),
      ),
      field('description', 'Description', true),
      h(
        'div',
        { class: 'field artwork' },
        h('span', null, 'Episode cover'),
        imagePicker(meta.artwork, 'Episode cover (JPEG or PNG, square, ideally 1400–3000 px)', 'large', (artwork) =>
          store.edit((p) => {
            const { artwork: _a, ...rest } = p.metadata;
            return { ...p, metadata: artwork ? { ...rest, artwork } : rest };
          }),
        ),
        h('small', { class: 'muted' }, 'Embedded in the MP3. Shown by podcatchers that read the file.'),
      ),
    );

    const regions = store.project.regions ?? [];
    const regionTime = (r: Region, key: 'start' | 'end') =>
      h('input', {
        class: 'time',
        value: formatTimestamp(r[key] / sr),
        onchange: (e: Event) => {
          const secs = parseTimestamp((e.target as HTMLInputElement).value);
          if (Number.isNaN(secs)) {
            toast('Use HH:MM:SS.mmm', 'error');
            this.render();
            return;
          }
          store.edit((p) => updateRegion(p, r.id, { [key]: Math.round(secs * sr) }));
        },
      });
    const regionCard = h(
      'section',
      { class: 'card' },
      h('h2', null, `Regions (${regions.length})`),
      regions.length
        ? h(
            'table',
            { class: 'markers' },
            h('thead', null, h('tr', null, h('th', null, 'Start'), h('th', null, 'End'), h('th', null, 'Title'), h('th', null, ''))),
            h(
              'tbody',
              null,
              ...regions.map((r) =>
                h(
                  'tr',
                  null,
                  h('td', null, regionTime(r, 'start')),
                  h('td', null, regionTime(r, 'end')),
                  h('td', null, h('input', { class: 'title', value: r.title, placeholder: 'Title', onchange: (e: Event) => store.edit((p) => updateRegion(p, r.id, { title: (e.target as HTMLInputElement).value })) })),
                  h(
                    'td',
                    { class: 'actions' },
                    h('button', { class: 'small', title: 'Select on the timeline', onclick: () => { store.select({ range: [r.start, r.end], rangeTracks: null, clipIds: new Set(), markerId: null }); seek(r.start); store.setView('edit'); } }, '▶'),
                    h('button', { class: 'small danger', title: 'Delete region', onclick: () => store.edit((p) => removeRegion(p, r.id)) }, '×'),
                  ),
                ),
              ),
            ),
          )
        : h('p', { class: 'muted' }, 'Select a time range and click “Region from selection” in the timeline toolbar to mark a part of the session (for example two episodes recorded in one go). The export can write each region as its own file.'),
    );

    this.el.append(h('div', { class: 'columns' }, h('div', null, chapterCard, editCard, regionCard), h('div', null, metaCard)));
  }

  /**
   * Drag a chapter row by its grip onto another chapter row to move its content (title, link,
   * image) into that slot; the content in between shifts by one. Start times never move.
   */
  private makeDraggable(tr: HTMLElement, m: Marker, index: number, move: (fromId: string, toId: string) => void): void {
    const indexOf = (id: string) => store.project.markers.filter((x) => x.kind === 'chapter').findIndex((x) => x.id === id);
    // only the grip starts a drag, so the text fields keep working
    tr.addEventListener('mousedown', (e) => {
      tr.draggable = (e.target as HTMLElement).classList.contains('grip');
    });
    tr.addEventListener('dragstart', (e) => {
      this.dragId = m.id;
      e.dataTransfer?.setData('text/plain', m.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      tr.classList.add('dragging');
    });
    tr.addEventListener('dragend', () => {
      this.dragId = null;
      tr.draggable = false;
      tr.classList.remove('dragging');
    });
    tr.addEventListener('dragover', (e) => {
      if (!this.dragId || this.dragId === m.id) return;
      e.preventDefault();
      const from = indexOf(this.dragId);
      tr.classList.toggle('drop-before', from > index);
      tr.classList.toggle('drop-after', from < index);
    });
    tr.addEventListener('dragleave', () => tr.classList.remove('drop-before', 'drop-after'));
    tr.addEventListener('drop', (e) => {
      e.preventDefault();
      tr.classList.remove('drop-before', 'drop-after');
      const id = this.dragId;
      this.dragId = null;
      if (id && id !== m.id) move(id, m.id);
    });
  }
}

/** Warnings about the chapter list (no chapter at 0:00, untitled chapters), with a quick fix for the first. */
export function chapterWarningList(rangeStart = 0, rangeEnd = Infinity, after?: () => void): HTMLElement | null {
  const warnings = chapterWarnings(store.project, rangeStart, rangeEnd);
  if (!warnings.length) return null;
  return h(
    'ul',
    { class: 'chapter-warnings' },
    ...warnings.map((w) =>
      h(
        'li',
        { class: 'warning' },
        w.message,
        w.kind === 'no-start'
          ? h(
              'button',
              {
                class: 'small',
                onclick: () => {
                  store.edit((p) => addMarker(p, rangeStart, 'chapter', 'Intro').project);
                  after?.();
                },
              },
              `Add chapter at ${rangeStart ? 'range start' : '0:00'}`,
            )
          : null,
      ),
    ),
  );
}

function safe(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, '_');
}
