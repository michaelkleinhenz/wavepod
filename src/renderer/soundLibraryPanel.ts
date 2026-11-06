// View › Sound Library: the sound effects folder beside the timeline. Type to search file and
// folder names; arrow keys walk the results and play each one (pre-listen on the main output);
// Enter or a double click inserts the sound at the playhead, dragging a row drops it on a track
// at the drop position, and "Fill selection" loops an ambience over a selected time range.
import type { Clip } from '../shared/types';
import { addClip, addTrack } from '../core/project';
import { fillClips, libraryFolderOf, libraryTitle, matchRanges, searchLibrary, type LibraryEntry, type SoundLibraryInfo } from '../core/soundLibrary';
import { formatTimestamp, uid } from '../shared/time';
import { decodeBytes } from './audioFiles';
import { showContextMenu } from './contextMenu';
import { append, errorMessage, h, toast } from './dom';
import { api, store } from './store';

/** Drag data type of a library row (its path inside the library). */
export const LIBRARY_DRAG_TYPE = 'application/x-wavepod-sound';
/** Insert target meaning "the Sound effects track" (created when missing). */
const SFX_TARGET = '__sfx';
const SFX_TRACK_NAME = 'Sound effects';
const MAX_ROWS = 400;
const TARGET_KEY = 'wavepod.libraryTarget';
const AUTOPLAY_KEY = 'wavepod.libraryAutoplay';
/** Crossfade between the repeats of "Fill selection". */
const FILL_CROSSFADE_SECONDS = 1;

const load = (key: string, fallback: string) => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};
const save = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // not stored: the default comes back next time
  }
};

// ---------------------------------------------------------------- audio of library files

const decoded = new Map<string, Promise<Float32Array[]>>();
const durations = new Map<string, number>();
const imported = new Map<string, Promise<{ file: string; length: number }>>();

/** Decodes a library file at the project rate (the last few are kept for quick replays and inserts). */
function decodeLibraryFile(rel: string): Promise<Float32Array[]> {
  const key = `${rel}|${store.sampleRate}`;
  let p = decoded.get(key);
  if (!p) {
    p = api()
      .readLibraryFile(rel)
      .then((bytes) => decodeBytes(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, store.sampleRate))
      .then((ch) => {
        durations.set(rel, ch[0].length / store.sampleRate);
        return ch;
      });
    p.catch(() => decoded.delete(key));
    decoded.set(key, p);
    while (decoded.size > 12) decoded.delete(decoded.keys().next().value!);
  } else {
    // most recently used last
    decoded.delete(key);
    decoded.set(key, p);
  }
  return p;
}

/** Copies a library file into the episode's media folder once per episode (as WAV at the project rate). */
function importLibraryFile(rel: string): Promise<{ file: string; length: number }> {
  const key = `${store.dir}|${rel}|${store.sampleRate}`;
  let p = imported.get(key);
  if (!p) {
    p = decodeLibraryFile(rel).then((ch) => api().importAudio(libraryTitle(rel), ch, store.sampleRate));
    p.catch(() => imported.delete(key));
    imported.set(key, p);
  }
  return p;
}

function sfxTrackId(): string | null {
  return store.project.tracks.find((t) => t.name === SFX_TRACK_NAME && t.kind !== 'soundboard')?.id ?? null;
}

/**
 * Inserts a library sound: at `at` (default: the playhead) on `trackId` (null: a new track named
 * after the sound; undefined: the panel's chosen target). With `fill`, the sound repeats over that range.
 */
export async function insertLibrarySound(rel: string, opts: { at?: number; trackId?: string | null; fill?: [number, number]; folderId?: string } = {}): Promise<void> {
  const title = libraryTitle(rel);
  try {
    const media = await importLibraryFile(rel);
    const at = Math.max(0, Math.round(opts.fill ? opts.fill[0] : opts.at ?? store.transport.position));
    let target = opts.trackId === undefined ? libraryTarget() : opts.trackId;
    let created = '';
    let ids: string[] = [];
    store.edit((p) => {
      let q = p;
      let id = target && target !== SFX_TARGET && q.tracks.some((t) => t.id === target) ? target : null;
      if (!id && target === SFX_TARGET) id = q.tracks.find((t) => t.name === SFX_TRACK_NAME && t.kind !== 'soundboard')?.id ?? null;
      if (!id) {
        created = target === SFX_TARGET ? SFX_TRACK_NAME : title;
        id = uid('trk');
        q = addTrack(q, { id, name: created, ...(opts.folderId ? { folderId: opts.folderId } : {}) });
      }
      target = id;
      const clips: Clip[] = opts.fill
        ? fillClips({ file: media.file, length: media.length, start: opts.fill[0], end: opts.fill[1], crossfade: Math.round(FILL_CROSSFADE_SECONDS * store.sampleRate), id: () => uid('clp') })
        : [{ id: uid('clp'), file: media.file, start: at, offset: 0, length: media.length, gain: 0, fadeIn: 0, fadeOut: 0 }];
      ids = clips.map((c) => c.id);
      return clips.reduce((r, c) => addClip(r, id!, c), q);
    });
    store.select({ clipIds: new Set(ids), range: opts.fill ? store.selection.range : null, markerId: null });
    const track = store.project.tracks.find((t) => t.id === target)?.name ?? '';
    const where = opts.fill ? `filled ${formatTimestamp((opts.fill[1] - opts.fill[0]) / store.sampleRate, false)} (${ids.length}×)` : `at ${formatTimestamp(at / store.sampleRate, false)}`;
    toast(`${title} on ${created ? `new track "${track}"` : track}, ${where}`);
  } catch (e) {
    toast(`Could not insert ${title}: ${errorMessage(e)}`, 'error');
  }
}

/** The panel's "Insert on" choice: a track id, or SFX_TARGET. */
function libraryTarget(): string {
  const t = load(TARGET_KEY, SFX_TARGET);
  return t === SFX_TARGET || store.project.tracks.some((x) => x.id === t) ? t : SFX_TARGET;
}

// ---------------------------------------------------------------- panel

export class SoundLibraryPanel {
  readonly el = h('aside', { class: 'library-panel', tabIndex: -1 });
  private search = h('input', { type: 'search', class: 'library-search', placeholder: 'Search sounds, e.g. door creak', spellcheck: false });
  private targetSel = h('select', { class: 'library-target', title: 'Where Enter, a double click and the menu put a sound' });
  private autoplayBox = h('input', { type: 'checkbox' });
  private info: SoundLibraryInfo | null = null;
  private body = h('div', { class: 'library-body' });
  private status = h('div', { class: 'library-status muted' });
  private folderLine = h('div', { class: 'library-folder' });
  private results: LibraryEntry[] = [];
  private total = 0;
  private rows: HTMLElement[] = [];
  private sel = -1;
  private playing: { rel: string; startedAt: number } | null = null;
  private shown = false;
  private hidden = false;
  private searchTimer: number | undefined;
  private scanning = false;
  /** Called when the panel opens (the app closes the transcript, which sits in the same place). */
  onOpen: () => void = () => {};

  constructor() {
    this.autoplayBox.checked = load(AUTOPLAY_KEY, '1') === '1';
    this.autoplayBox.addEventListener('change', () => save(AUTOPLAY_KEY, this.autoplayBox.checked ? '1' : '0'));
    this.targetSel.addEventListener('change', () => save(TARGET_KEY, this.targetSel.value));
    this.search.addEventListener('input', () => {
      window.clearTimeout(this.searchTimer);
      this.searchTimer = window.setTimeout(() => this.runSearch(), (this.info?.files.length ?? 0) > 20000 ? 120 : 30);
    });
    this.el.append(
      h('div', { class: 'fx-head' }, h('div', null, h('div', { class: 'fx-kicker' }, 'Sound effects'), h('h2', null, 'Sound library')), h('button', { class: 'fx-close', title: 'Close', onclick: () => this.close() }, '×')),
      h('div', { class: 'library-toolbar' }, this.search),
      h(
        'div',
        { class: 'library-options' },
        h('label', { class: 'library-insert' }, 'Insert on ', this.targetSel),
        h('label', { class: 'library-autoplay', title: 'Play each sound as you move to it with the arrow keys' }, this.autoplayBox, ' Play on select'),
      ),
      this.status,
      this.body,
      this.folderLine,
    );
    this.el.addEventListener('keydown', (e) => this.key(e));
    window.addEventListener('wavepod:library-changed', () => void this.reload(false));
  }

  get isOpen(): boolean {
    return this.shown;
  }

  toggle(): void {
    if (this.shown) this.close();
    else this.open();
  }

  open(): void {
    if (!this.shown) this.onOpen();
    this.shown = true;
    document.body.classList.add('library-open');
    if (!this.hidden) document.getElementById('app')!.append(this.el);
    this.renderTargets();
    if (!this.info) void this.reload(false);
    else this.renderRows();
    this.search.focus();
    this.search.select();
  }

  close(): void {
    this.stopPreview();
    this.shown = false;
    document.body.classList.remove('library-open');
    this.el.remove();
  }

  /** Off screen outside the edit view, back on return. */
  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    if (hidden) {
      this.stopPreview();
      this.el.remove();
      document.body.classList.remove('library-open');
    } else if (this.shown) {
      document.body.classList.add('library-open');
      document.getElementById('app')!.append(this.el);
    }
  }

  /** The project changed: tracks for "Insert on". */
  refresh(): void {
    if (this.shown) this.renderTargets();
  }

  /** Transport update: the preview's progress, and its end. */
  updatePreview(): void {
    if (!this.playing) return;
    const p = store.transport.preview;
    const row = this.rows[this.results.findIndex((e) => e.path === this.playing!.rel)];
    if (!p) {
      // the first updates after starting may not carry it yet
      if (performance.now() - this.playing.startedAt > 400) this.setPlaying(null);
      return;
    }
    const bar = row?.querySelector<HTMLElement>('.library-progress');
    if (bar) bar.style.width = `${Math.min(100, (p.pos / Math.max(1, p.length)) * 100)}%`;
  }

  private async reload(rescan: boolean): Promise<void> {
    this.scanning = true;
    this.renderStatus();
    try {
      this.info = await api().getSoundLibrary(rescan);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
    this.scanning = false;
    this.runSearch();
  }

  private runSearch(): void {
    const files = this.info?.files ?? [];
    const prev = this.results[this.sel]?.path;
    const r = searchLibrary(files, this.search.value, MAX_ROWS);
    this.results = r.results;
    this.total = r.total;
    const keep = prev ? this.results.findIndex((e) => e.path === prev) : -1;
    this.sel = keep >= 0 ? keep : this.results.length ? 0 : -1;
    this.renderRows();
  }

  private renderTargets(): void {
    const value = libraryTarget();
    this.targetSel.replaceChildren(
      h('option', { value: SFX_TARGET, selected: value === SFX_TARGET }, sfxTrackId() ? `${SFX_TRACK_NAME} track` : `${SFX_TRACK_NAME} track (new)`),
      ...store.project.tracks.filter((t) => t.name !== SFX_TRACK_NAME).map((t) => h('option', { value: t.id, selected: value === t.id }, t.name)),
    );
  }

  private renderStatus(): void {
    const info = this.info;
    if (this.scanning) this.status.textContent = 'Reading the library folder…';
    else if (!info?.folder) this.status.textContent = '';
    else if (info.error) this.status.textContent = info.error;
    else {
      const n = info.files.length;
      const all = `${n.toLocaleString()} sound${n === 1 ? '' : 's'}${info.truncated ? ' (first part of the folder only)' : ''}`;
      this.status.textContent = this.search.value.trim()
        ? `${this.total.toLocaleString()} of ${all}${this.total > MAX_ROWS ? `, showing the best ${MAX_ROWS}` : ''}`
        : `${all}${n > MAX_ROWS ? `, showing the first ${MAX_ROWS}: type to search` : ''}`;
    }
    this.folderLine.replaceChildren();
    append(this.folderLine, [
      info?.folder ? h('span', { class: 'library-folder-path', title: info.folder }, info.folder) : h('span', { class: 'muted' }, 'No library folder set'),
      info?.folder ? h('button', { class: 'small', title: 'Read the folder again (after adding sounds)', disabled: this.scanning, onclick: () => void this.reload(true) }, 'Rescan') : null,
      h('button', { class: 'small', onclick: () => void this.chooseFolder() }, info?.folder ? 'Change…' : 'Choose folder…'),
    ]);
  }

  private async chooseFolder(): Promise<void> {
    try {
      const info = await api().chooseSoundLibraryFolder();
      if (!info) return;
      this.info = info;
      window.dispatchEvent(new Event('wavepod:library-changed'));
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  }

  private renderRows(): void {
    this.renderStatus();
    const query = this.search.value;
    this.rows = this.results.map((e, i) => this.row(e, i, query));
    if (!this.info?.folder && !this.scanning) {
      this.body.replaceChildren(
        h(
          'div',
          { class: 'library-empty' },
          h('p', null, 'Choose the folder where your sound effects are. WavePod finds every audio file in it and in its subfolders, and you search them by file and folder name.'),
          h('p', { class: 'muted' }, 'WAV, MP3, FLAC, Ogg, Opus, M4A and AIFF files are found. Sounds you insert are copied into the episode, so the episode keeps working without the library.'),
          h('button', { class: 'primary', onclick: () => void this.chooseFolder() }, 'Choose library folder…'),
        ),
      );
      return;
    }
    if (!this.rows.length && !this.scanning) {
      this.body.replaceChildren(h('div', { class: 'library-empty muted' }, this.search.value.trim() ? 'No sound matches. Words are matched at the start of the words in file and folder names.' : 'No audio files in this folder.'));
      return;
    }
    this.body.replaceChildren(...this.rows);
    this.markSelected(false);
  }

  private row(e: LibraryEntry, i: number, query: string): HTMLElement {
    const title = libraryTitle(e.path);
    const folder = libraryFolderOf(e.path);
    const dur = durations.get(e.path);
    const playing = this.playing?.rel === e.path;
    const el = h(
      'div',
      {
        class: `library-row${playing ? ' playing' : ''}`,
        draggable: 'true',
        title: `${e.path}\nClick: listen · Double click or Enter: insert · Drag onto a track · Right click: more`,
        onmousedown: (ev: MouseEvent) => {
          if (ev.button !== 0 || (ev.target as HTMLElement).closest('.library-play')) return;
          this.select(i, false);
        },
        onclick: (ev: MouseEvent) => {
          if ((ev.target as HTMLElement).closest('.library-play')) return;
          if (ev.detail === 1) this.togglePreview(e.path);
        },
        ondblclick: () => void this.insert(e.path),
        oncontextmenu: (ev: MouseEvent) => {
          ev.preventDefault();
          this.select(i, false);
          this.menu(e, ev.pageX, ev.pageY);
        },
        ondragstart: (ev: DragEvent) => {
          ev.dataTransfer!.setData(LIBRARY_DRAG_TYPE, e.path);
          ev.dataTransfer!.setData('text/plain', title);
          ev.dataTransfer!.effectAllowed = 'copy';
        },
      },
      h('button', { class: 'library-play small icon-only', title: playing ? 'Stop' : 'Listen', onclick: () => (this.select(i, false), this.togglePreview(e.path)) }, playing ? '■' : '▶'),
      h('div', { class: 'library-text' }, h('div', { class: 'library-name' }, ...highlight(title, query)), folder ? h('div', { class: 'library-sub' }, ...highlight(folder, query)) : null),
      h('span', { class: 'library-dur' }, dur !== undefined ? formatDur(dur) : ''),
      h('div', { class: 'library-progress' }),
    );
    return el;
  }

  private menu(e: LibraryEntry, x: number, y: number): void {
    const range = store.selection.range;
    const hasRange = !!range && range[1] > range[0];
    showContextMenu(
      [
        { label: this.playing?.rel === e.path ? 'Stop' : 'Listen', accel: 'Click', run: () => this.togglePreview(e.path) },
        { kind: 'separator' },
        { label: 'Insert at the Playhead', accel: 'Enter', run: () => void this.insert(e.path) },
        { label: 'Insert on a New Track', run: () => void insertLibrarySound(e.path, { trackId: null }) },
        {
          label: 'Fill the Selection (Loop)',
          enabled: hasRange,
          title: hasRange ? 'Repeat the sound over the selected time range, with crossfades: for ambience and atmospheres' : 'Select a time range on the timeline first',
          run: () => void insertLibrarySound(e.path, { fill: range!, trackId: store.selection.rangeTracks?.length === 1 ? store.selection.rangeTracks[0] : undefined }),
        },
        { kind: 'separator' },
        { label: 'Show in Folder', run: () => void api().revealLibraryFile(e.path) },
      ],
      x,
      y,
    );
  }

  private select(i: number, preview: boolean): void {
    if (i < 0 || i >= this.results.length) return;
    this.sel = i;
    this.markSelected(true);
    if (preview) this.startPreview(this.results[i].path);
  }

  private markSelected(scroll: boolean): void {
    this.rows.forEach((r, i) => r.classList.toggle('selected', i === this.sel));
    if (scroll) this.rows[this.sel]?.scrollIntoView({ block: 'nearest' });
  }

  private key(e: KeyboardEvent): void {
    const inSearch = e.target === this.search;
    const sel = this.results[this.sel];
    let handled = true;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const next = Math.max(0, Math.min(this.results.length - 1, this.sel + (e.key === 'ArrowDown' ? 1 : -1)));
      if (next !== this.sel || !this.playing) this.select(next, this.autoplayBox.checked);
    } else if (e.key === 'Enter') {
      if (sel) void this.insert(sel.path);
    } else if (e.key === 'Escape') {
      if (this.playing) this.stopPreview();
      else if (this.search.value) {
        this.search.value = '';
        this.runSearch();
      } else this.close();
    } else if (e.key === ' ' && (!inSearch || e.ctrlKey)) {
      if (sel) this.togglePreview(sel.path);
    } else if (!inSearch && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // typing anywhere in the panel searches
      this.search.focus();
      handled = false;
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    } else if (!inSearch) {
      // keep timeline shortcuts away from the list (Delete, letters)
      e.stopPropagation();
    }
  }

  private async insert(rel: string): Promise<void> {
    await insertLibrarySound(rel);
  }

  private togglePreview(rel: string): void {
    if (this.playing?.rel === rel) this.stopPreview();
    else this.startPreview(rel);
  }

  private async startPreview(rel: string): Promise<void> {
    this.setPlaying({ rel, startedAt: performance.now() });
    try {
      const ch = await decodeLibraryFile(rel);
      if (this.playing?.rel !== rel) return; // moved on meanwhile
      this.updateDuration(rel);
      const ok = await api().previewSound(ch);
      if (!ok) this.setPlaying(null);
      else if (this.playing?.rel === rel) this.playing.startedAt = performance.now();
    } catch (e) {
      if (this.playing?.rel === rel) this.setPlaying(null);
      toast(`Could not play ${libraryTitle(rel)}: ${errorMessage(e)}`, 'error');
    }
  }

  private stopPreview(): void {
    if (!this.playing) return;
    this.setPlaying(null);
    void api().previewSound(null);
  }

  private setPlaying(p: { rel: string; startedAt: number } | null): void {
    const before = this.playing?.rel;
    this.playing = p;
    for (const rel of [before, p?.rel]) {
      const i = this.results.findIndex((e) => e.path === rel);
      const row = this.rows[i];
      if (!row) continue;
      const on = p?.rel === rel;
      row.classList.toggle('playing', on);
      const btn = row.querySelector('.library-play')!;
      btn.textContent = on ? '■' : '▶';
      btn.setAttribute('title', on ? 'Stop' : 'Listen');
      if (!on) row.querySelector<HTMLElement>('.library-progress')!.style.width = '0';
    }
  }

  private updateDuration(rel: string): void {
    const d = durations.get(rel);
    const row = this.rows[this.results.findIndex((e) => e.path === rel)];
    const el = row?.querySelector('.library-dur');
    if (el && d !== undefined) el.textContent = formatDur(d);
  }
}

function formatDur(s: number): string {
  if (s < 10) return `${s.toFixed(1)} s`;
  if (s < 60) return `${Math.round(s)} s`;
  return formatTimestamp(s, false).replace(/^00:/, '');
}

/** The text with the query's words marked. */
function highlight(text: string, query: string): Array<string | HTMLElement> {
  const ranges = matchRanges(text, query);
  if (!ranges.length) return [text];
  const chars = Array.from(text);
  const out: Array<string | HTMLElement> = [];
  let at = 0;
  for (const [a, b] of ranges) {
    if (a < at) continue;
    if (a > at) out.push(chars.slice(at, a).join(''));
    out.push(h('mark', null, chars.slice(a, b).join('')));
    at = b;
  }
  if (at < chars.length) out.push(chars.slice(at).join(''));
  return out;
}
