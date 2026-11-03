// Chapters & episode info: edit chapter titles/URLs/times, edit markers, import/export chapter files, metadata.
import type { EpisodeMetadata, Marker } from '../shared/types';
import { formatTimestamp, parseTimestamp } from '../shared/time';
import { CHAPTER_FORMATS, exportChapters } from '../core/chapters';
import { addMarker, chapterWarnings, markersToChapters, removeMarker, updateMarker } from '../core/project';
import { projectLength } from '../core/project';
import { clear, errorMessage, h, toast } from './dom';
import { importChapterFile, seek } from './actions';
import { api, store } from './store';
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

  render(): void {
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

    const row = (m: Marker, withUrl: boolean) =>
      h(
        'tr',
        { class: store.selection.markerId === m.id ? 'selected' : '' },
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
          h('button', { class: 'small', title: 'Jump to marker', onclick: () => { seek(m.position); store.select({ markerId: m.id }); store.setView('edit'); } }, '▶'),
          withUrl ? null : h('button', { class: 'small', title: 'Turn into chapter', onclick: () => store.edit((p) => updateMarker(p, m.id, { kind: 'chapter' })) }, '→ chapter'),
          h('button', { class: 'small danger', title: 'Delete marker', onclick: () => store.edit((p) => removeMarker(p, m.id)) }, '×'),
        ),
      );

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
            h('thead', null, h('tr', null, h('th', null, 'Start'), h('th', null, 'Title'), h('th', null, 'Link'), h('th', null, 'Image'), h('th', null, ''))),
            h('tbody', null, ...chapters.map((m) => row(m, true))),
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

    this.el.append(h('div', { class: 'columns' }, h('div', null, chapterCard, editCard), h('div', null, metaCard)));
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
