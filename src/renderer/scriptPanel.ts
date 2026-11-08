// View › Script: the audio drama script beside the timeline. Import a plain-text, Fountain or
// Final Draft script or a PlotGod audioplay export; every line shows who speaks it, ticks off as recorded and, once its take is
// known, jumps there. "Line up" finds the lines in the transcript; while recording, Enter ticks the
// focused line at the playhead and moves on to the next open one. Acts and scenes fold away, and the
// script opens in a window of its own (to share with an actor on a video call) that follows the panel.
import type { Project, ScriptLine } from '../shared/types';
import {
  SCRIPT_EXTENSIONS,
  applyLineUp,
  characterKey,
  createScript,
  foldAllBut,
  foldedLines,
  headingLevel,
  headingsAbove,
  lineAt,
  lineTrack,
  lineUpScript,
  parseScript,
  placedLines,
  removeScript,
  replaceScript,
  sceneStart,
  scriptCharacters,
  scriptProgress,
  scriptScenes,
  setCast,
  setLineRecorded,
  settleTakes,
  takeAt,
  type PlacedLine,
} from '../core/script';
import { formatTimestamp } from '../shared/time';
import { showContextMenu } from './contextMenu';
import { append, errorMessage, h, toast } from './dom';
import { seek } from './actions';
import { api, store } from './store';
import { transcripts } from './transcripts';

const OPEN_ONLY_KEY = 'wavepod.scriptOpenOnly';
const FOLDED_KEY = 'wavepod.scriptFolded';
const WINDOW_ZOOM_KEY = 'wavepod.scriptWindowZoom';
/** The name window.open gives the script window; the main process lets only this one open. */
export const SCRIPT_WINDOW_NAME = 'wavepod-script';
const load = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const save = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // only remembered for this session
  }
};

/** Opens a script file and puts it into the episode (keeping what a previous draft had recorded). */
export async function importScriptFile(): Promise<boolean> {
  try {
    const res = await api().openTextFile('Script (plain text, Fountain, Final Draft or PlotGod)', SCRIPT_EXTENSIONS);
    if (!res) return false;
    const name = res.path.replace(/^.*[\\/]/, '');
    const parsed = parseScript(res.text, name);
    const n = parsed.lines.filter((l) => l.kind === 'dialogue').length;
    if (!n) {
      toast(`No lines found in ${name}. Write them as "NAME: what they say", or use Fountain, Final Draft or a PlotGod export.`, 'error');
      return false;
    }
    const had = !!store.project.script;
    store.edit((p) => replaceScript(p, createScript(p, parsed, name)));
    const cast = scriptCharacters(store.project.script!);
    const onTracks = cast.filter((c) => store.project.script!.cast[c.key]).length;
    toast(`${had ? 'Updated' : 'Imported'} ${parsed.title}: ${n} line${n === 1 ? '' : 's'}, ${cast.length} character${cast.length === 1 ? '' : 's'}${onTracks ? ` (${onTracks} on their tracks)` : ''}`);
    return true;
  } catch (e) {
    toast(`Could not read the script: ${errorMessage(e)}`, 'error');
    return false;
  }
}

/** One place the lines show: the side panel or the script window. */
interface LinesView {
  body: HTMLElement;
  rows: Map<number, HTMLElement>;
  current: number;
  /** Only this character's lines (upper-case key), or all. */
  character: string | null;
  /** The script window: the picked line stays in the middle, for whoever reads along. */
  window?: Window;
}

interface ScriptWindow {
  win: Window;
  view: LinesView;
  title: HTMLElement;
  scene: HTMLElement;
  progress: HTMLElement;
  characters: HTMLSelectElement;
  zoom: number;
}

export class ScriptPanel {
  readonly el = h('aside', { class: 'script-panel', tabIndex: -1 });
  private toolbar = h('div', { class: 'script-toolbar' });
  private summary = h('div', { class: 'script-summary' });
  private cast = h('div', { class: 'script-cast' });
  private main: LinesView = { body: h('div', { class: 'script-body' }), rows: new Map(), current: -1, character: null };
  private popout: ScriptWindow | null = null;
  private shownProject: Project | null = null;
  private placed: PlacedLine[] = [];
  private placedAt = new Map<number, PlacedLine>();
  /** Index (into script.lines) of the line the keys act on. */
  private focus = -1;
  /** Ids of the folded act and scene headings (kept per computer, not in the episode). */
  private folded = new Set<string>(readFolded());
  /** Per line: hidden under a folded heading. */
  private hiddenRows: boolean[] = [];
  private openOnly = load(OPEN_ONLY_KEY) === '1';
  private castOpen = false;
  private shown = false;
  private hidden = false;
  private lining = false;
  /** Called when the panel opens (the app closes the other side panels). */
  onOpen: () => void = () => {};

  constructor() {
    this.el.append(
      h('div', { class: 'fx-head' }, h('div', null, h('div', { class: 'fx-kicker' }, 'Audio drama'), h('h2', null, 'Script')), h('button', { class: 'fx-close', title: 'Close', onclick: () => this.close() }, '×')),
      this.toolbar,
      this.summary,
      this.cast,
      this.main.body,
    );
    this.main.body.addEventListener('click', (e) => this.click(e, this.main));
    this.el.addEventListener('keydown', (e) => this.key(e, this.main));
    transcripts().subscribe(() => this.shown && this.renderToolbar());
    window.addEventListener('beforeunload', () => this.popout?.win.close());
  }

  /** Where the lines show right now. */
  private views(): LinesView[] {
    const out: LinesView[] = [];
    if (this.shown && !this.hidden) out.push(this.main);
    if (this.popout && !this.popout.win.closed) out.push(this.popout.view);
    return out;
  }

  get isWindowOpen(): boolean {
    return !!this.popout && !this.popout.win.closed;
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
    document.body.classList.add('script-open');
    this.shownProject = null;
    this.render();
    if (!this.hidden) {
      document.getElementById('app')!.append(this.el);
      this.el.focus({ preventScroll: true });
      this.scrollTo(this.main, this.focus);
    }
  }

  close(): void {
    this.shown = false;
    document.body.classList.remove('script-open');
    this.el.remove();
  }

  /** Off screen outside the edit view, back on return. */
  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    if (hidden) {
      this.el.remove();
      document.body.classList.remove('script-open');
    } else if (this.shown) {
      document.body.classList.add('script-open');
      this.render();
      document.getElementById('app')!.append(this.el);
    }
  }

  /** The project changed. Lines ticked while recording move onto the take's clip once it exists. */
  refresh(): void {
    const p = store.project;
    if (p.script && store.transport.state !== 'recording') {
      const settled = settleTakes(p);
      if (settled !== p) {
        store.patch(() => settled);
        return;
      }
    }
    if (!this.views().length || p === this.shownProject) return;
    this.render();
  }

  /** Transport update: highlight the line playing. */
  updatePosition(): void {
    if (!this.placed.length) return;
    const t = store.transport;
    const i = t.state === 'stopped' && !this.placedAt.size ? -1 : lineAt(this.placed, t.position, store.sampleRate);
    for (const v of this.views()) {
      if (i === v.current) continue;
      v.rows.get(v.current)?.classList.remove('current');
      v.current = i;
      const row = v.rows.get(i);
      if (!row) continue;
      row.classList.add('current');
      if (t.state === 'playing') this.scrollTo(v, i, true);
    }
  }

  // ---------------------------------------------------------------- actions

  /** Finds the lines in the transcript (transcribing what's missing first). */
  async lineUp(): Promise<void> {
    if (this.lining || !store.project.script) return;
    const t = transcripts();
    this.lining = true;
    this.renderToolbar();
    try {
      await t.ensureLoaded();
      if (!t.complete) await t.transcribe(false);
      const words = t.words();
      if (!words.length) {
        toast('Line up needs a transcript of the recording: Transcribe first (ElevenLabs key in Edit › Settings)');
        return;
      }
      const r = lineUpScript(store.project, words);
      store.edit((p) => applyLineUp(p, r));
      const multi = [...r.found.values()].filter((f) => (f.takes ?? 1) > 1).length;
      toast(
        r.found.size
          ? `Found ${r.found.size} of ${r.searched} lines in the recording${multi ? `, ${multi} with several takes` : ''}`
          : 'None of the lines were found in the transcript. Are the characters on the right tracks?',
      );
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      this.lining = false;
      this.renderToolbar();
    }
  }

  /** Ticks a line as recorded at the playhead, or unticks it. */
  private toggleLine(index: number, recorded?: boolean): void {
    const p = store.project;
    const script = p.script;
    const l = script?.lines[index];
    if (!script || !l || l.kind !== 'dialogue') return;
    const on = recorded ?? !l.recorded;
    if (on) {
      const take = takeAt(p, store.transport.position, undefined, lineTrack(script, l));
      store.edit((q) => setLineRecorded(q, l.id, true, take));
    } else store.edit((q) => setLineRecorded(q, l.id, false));
  }

  /** Jumps to a line's take (and selects it, so Repeat loops it). */
  private jump(index: number): void {
    const p = this.placedAt.get(index);
    if (!p) return;
    seek(p.start);
    const script = store.project.script!;
    const track = lineTrack(script, script.lines[index]);
    store.select({ range: p.end !== undefined ? [p.start, p.end] : null, rangeTracks: p.end !== undefined && track ? [track] : null, clipIds: new Set() });
  }

  private jumpToScene(sceneIndex: number, view = this.main): void {
    const p = store.project;
    const lines = p.script?.lines ?? [];
    const at = sceneStart(p, sceneIndex, this.placed);
    // a folded scene opens when you go there
    if (sceneIndex >= 0 && this.unfold([...headingsAbove(lines, sceneIndex), sceneIndex])) this.renderLines();
    const first = sceneIndex + 1;
    this.setFocus(this.visible(first, view) ? first : this.nextVisible(sceneIndex, 1, view));
    for (const v of this.views()) this.scrollTo(v, sceneIndex < 0 ? this.focus : sceneIndex, false, 'start');
    if (at === null) return toast('Nothing of this scene is recorded yet');
    seek(at);
    store.select({ range: null, rangeTracks: null, clipIds: new Set() });
  }

  // ---------------------------------------------------------------- folding

  /** Folds or unfolds one act or scene heading. */
  private toggleFold(index: number): void {
    const l = store.project.script?.lines[index];
    if (!l || l.kind !== 'scene') return;
    if (this.folded.has(l.id)) this.folded.delete(l.id);
    else this.folded.add(l.id);
    this.foldChanged();
  }

  /** Opens the headings at these indexes; true if any was folded. */
  private unfold(indexes: number[]): boolean {
    const lines = store.project.script?.lines ?? [];
    let changed = false;
    for (const i of indexes) if (lines[i] && this.folded.delete(lines[i].id)) changed = true;
    if (changed) this.saveFolded();
    return changed;
  }

  /** Folds every act and scene, or opens them all again. */
  private foldAll(fold: boolean): void {
    const lines = store.project.script?.lines ?? [];
    this.folded = new Set(fold ? lines.filter((l) => l.kind === 'scene').map((l) => l.id) : []);
    this.foldChanged();
  }

  /** Folds everything but the act and scene of the picked line. */
  private foldToCurrent(): void {
    const lines = store.project.script?.lines ?? [];
    const at = this.focus >= 0 ? this.focus : this.nextVisible(-1, 1, this.main, true, true);
    if (at < 0) return toast('Pick a line first');
    this.folded = foldAllBut(lines, at);
    this.foldChanged();
    for (const v of this.views()) this.scrollTo(v, this.focus, false);
  }

  private foldChanged(): void {
    this.saveFolded();
    this.renderLines();
  }

  private saveFolded(): void {
    const ids = new Set((store.project.script?.lines ?? []).map((l) => l.id));
    save(FOLDED_KEY, JSON.stringify([...this.folded].filter((id) => ids.has(id))));
  }

  // ---------------------------------------------------------------- the script window

  /** Opens the script in a window of its own, or brings it to the front. */
  openWindow(): void {
    if (this.popout && !this.popout.win.closed) {
      this.popout.win.focus();
      return;
    }
    const win = window.open('', SCRIPT_WINDOW_NAME, 'width=760,height=900');
    if (!win) return toast('Could not open the script window', 'error');
    const doc = win.document;
    doc.title = 'Script – WavePod';
    // the app's look: same stylesheet, the window's own body class
    for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) doc.head.append(h('link', { rel: 'stylesheet', href: link.href }));
    doc.body.className = 'script-window';
    const zoom = Math.min(3, Math.max(0.8, Number(load(WINDOW_ZOOM_KEY)) || 1.6));
    const view: LinesView = { body: h('div', { class: 'script-body' }), rows: new Map(), current: -1, character: null, window: win };
    const pw: ScriptWindow = {
      win,
      view,
      title: h('div', { class: 'script-window-title' }),
      scene: h('div', { class: 'script-window-scene' }),
      progress: h('div', { class: 'script-window-progress' }),
      characters: h('select', {
        class: 'script-window-characters',
        title: 'Show only the lines of one character',
        onchange: (e: Event) => {
          view.character = (e.target as HTMLSelectElement).value || null;
          this.renderView(view);
          this.scrollTo(view, this.focus, false);
        },
      }),
      zoom,
    };
    const size = (step: number) => {
      pw.zoom = Math.round(Math.min(3, Math.max(0.8, pw.zoom + step)) * 10) / 10;
      save(WINDOW_ZOOM_KEY, String(pw.zoom));
      doc.body.style.setProperty('--script-zoom', String(pw.zoom));
      this.scrollTo(view, this.focus, false);
    };
    doc.body.style.setProperty('--script-zoom', String(zoom));
    doc.body.append(
      h(
        'header',
        { class: 'script-window-head' },
        h('div', { class: 'script-window-heading' }, pw.title, pw.scene),
        pw.progress,
        h(
          'div',
          { class: 'script-window-tools' },
          pw.characters,
          h('button', { class: 'small', title: 'Smaller text (Ctrl+-)', onclick: () => size(-0.2) }, 'A−'),
          h('button', { class: 'small', title: 'Larger text (Ctrl++)', onclick: () => size(0.2) }, 'A+'),
        ),
      ),
      view.body,
    );
    view.body.addEventListener('click', (e) => this.click(e, view));
    win.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '=' || e.key === '-')) {
        e.preventDefault();
        return size(e.key === '-' ? -0.2 : 0.2);
      }
      this.key(e, view);
    });
    win.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      size(e.deltaY < 0 ? 0.2 : -0.2);
    }, { passive: false });
    win.addEventListener('pagehide', () => {
      if (this.popout?.win === win) this.popout = null;
      this.renderToolbar();
    });
    this.popout = pw;
    this.shownProject = null;
    this.render();
    this.scrollTo(view, this.focus, false);
    win.focus();
  }

  closeWindow(): void {
    this.popout?.win.close();
    this.popout = null;
  }

  toggleWindow(): void {
    if (this.isWindowOpen) {
      this.closeWindow();
      this.renderToolbar();
    } else this.openWindow();
  }

  private menu(e: MouseEvent): void {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const has = !!store.project.script;
    showContextMenu(
      [
        { label: has ? 'Import a New Draft…' : 'Import Script…', title: 'Lines that stay the same keep their recorded ticks', run: () => void importScriptFile() },
        { label: 'Tick All Lines Off', enabled: has, run: () => this.untickAll() },
        { kind: 'separator' },
        { label: 'Show Only the Current Scene', enabled: has, title: 'Folds every other act and scene', run: () => this.foldToCurrent() },
        { label: 'Fold All Acts and Scenes', enabled: has, run: () => this.foldAll(true) },
        { label: 'Unfold All', enabled: has && this.folded.size > 0, run: () => this.foldAll(false) },
        { kind: 'separator' },
        { label: this.isWindowOpen ? 'Close Script Window' : 'Open in New Window', title: 'The script in a window of its own, to share with an actor on a video call', run: () => this.toggleWindow() },
        { kind: 'separator' },
        { label: 'Remove Script', enabled: has, run: () => store.edit(removeScript) },
      ],
      r.left,
      r.bottom,
    );
  }

  private untickAll(): void {
    store.edit((p) => (p.script ? { ...p, script: { ...p.script, lines: p.script.lines.map(({ recorded: _r, take: _t, ...l }) => l) } } : p));
  }

  // ---------------------------------------------------------------- keys and clicks

  /** A dialogue line the view shows (and the arrow keys can reach). Folded lines count with `folded`. */
  private visible(i: number, view: LinesView, folded = false): boolean {
    const l = store.project.script?.lines[i];
    if (!l || l.kind !== 'dialogue') return false;
    if (view.character && characterKey(l.character ?? '') !== view.character) return false;
    if (!folded && this.hiddenRows[i]) return false;
    return true;
  }

  private nextVisible(from: number, dir: 1 | -1, view: LinesView, open = false, folded = false): number {
    const lines = store.project.script?.lines ?? [];
    for (let i = from + dir; i >= 0 && i < lines.length; i += dir) if (this.visible(i, view, folded) && (!open || !lines[i].recorded)) return i;
    return -1;
  }

  private setFocus(i: number): void {
    const moved = i !== this.focus;
    for (const v of this.views()) v.rows.get(this.focus)?.classList.remove('focus');
    this.focus = i;
    for (const v of this.views()) {
      v.rows.get(i)?.classList.add('focus');
      // the window keeps the line to read next in the middle
      if (moved && v.window) this.scrollTo(v, i, false);
    }
    if (this.popout) this.renderWindowHead();
  }

  private scrollTo(view: LinesView, i: number, gentle = false, block: ScrollLogicalPosition = 'center'): void {
    const row = view.rows.get(i);
    if (!row) return;
    if (gentle) {
      const b = view.body.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      if (r.top >= b.top + 30 && r.bottom <= b.bottom - 30) return;
    }
    row.scrollIntoView({ block, behavior: view.window ? 'smooth' : 'auto' });
  }

  private key(e: KeyboardEvent, view: LinesView): void {
    if ((e.target as HTMLElement).closest('select, input:not([type=checkbox])')) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const n = this.nextVisible(this.focus < 0 && e.key === 'ArrowUp' ? Infinity : this.focus, e.key === 'ArrowDown' ? 1 : -1, view);
      if (n >= 0) {
        this.setFocus(n);
        this.scrollTo(view, n, true);
      }
    } else if (e.key === 'Enter' && this.focus >= 0) {
      // the recording flow: tick the line just spoken, go on to the next open one
      e.preventDefault();
      e.stopPropagation();
      const at = this.focus;
      const l = store.project.script?.lines[at];
      if (!l) return;
      if (e.shiftKey) return this.jump(at);
      // the next open line, even in a folded scene: that scene opens
      const n = this.nextVisible(at, 1, view, true, true);
      const unfolded = n >= 0 && this.unfold(headingsAbove(store.project.script!.lines, n));
      this.toggleLine(at, true);
      if (unfolded) this.renderLines();
      if (n >= 0) {
        this.setFocus(n);
        for (const v of this.views()) this.scrollTo(v, n, !v.window);
      }
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.focus >= 0) {
      e.preventDefault();
      e.stopPropagation();
      this.toggleLine(this.focus, false);
    }
  }

  private click(e: MouseEvent, view: LinesView): void {
    const t = e.target as HTMLElement;
    const fold = t.closest<HTMLElement>('[data-fold]');
    if (fold) return this.toggleFold(Number(fold.dataset.fold));
    const scene = t.closest<HTMLElement>('[data-scene]');
    if (scene) return this.jumpToScene(Number(scene.dataset.scene), view);
    const row = t.closest<HTMLElement>('[data-line]');
    if (!row) return;
    const i = Number(row.dataset.line);
    if (!view.window) this.el.focus({ preventScroll: true });
    this.setFocus(i);
    if (t.closest('.script-tick')) {
      e.preventDefault();
      this.toggleLine(i);
      return;
    }
    this.jump(i);
  }

  // ---------------------------------------------------------------- rendering

  private renderToolbar(): void {
    const script = store.project.script;
    const t = transcripts();
    const busy = this.lining || t.busy;
    this.toolbar.replaceChildren();
    append(this.toolbar, [
      h('button', { class: script ? 'small' : 'small primary', title: 'Plain text (NAME: line), Fountain (.fountain), Final Draft (.fdx) or PlotGod audioplay (.json)', onclick: () => void importScriptFile() }, script ? 'Import…' : 'Import script…'),
      script
        ? h(
            'button',
            {
              class: 'small',
              disabled: busy,
              title: 'Find every line in the transcript of the recording and tick it off (transcribes what is missing first)',
              onclick: () => void this.lineUp(),
            },
            busy ? h('span', { class: 'spinner' }) : null,
            busy ? ' Lining up…' : 'Line up',
          )
        : null,
      script ? this.sceneSelect() : null,
      script
        ? h(
            'button',
            {
              class: `small script-popout${this.isWindowOpen ? ' on' : ''}`,
              title: this.isWindowOpen ? 'Close the script window' : 'Open the script in a new window, to share with an actor on a video call',
              'aria-label': this.isWindowOpen ? 'Close script window' : 'Open script in new window',
              'aria-pressed': String(this.isWindowOpen),
              onclick: () => this.toggleWindow(),
            },
            '⧉',
          )
        : null,
      h('button', { class: 'small script-more', title: 'More', 'aria-label': 'More script commands', onclick: (e: MouseEvent) => this.menu(e) }, '⋯'),
    ]);
  }

  private sceneSelect(): HTMLSelectElement {
    const script = store.project.script!;
    const scenes = scriptScenes(script);
    return h(
      'select',
      {
        class: 'script-scenes',
        title: 'Jump to a scene',
        onchange: (e: Event) => {
          const sel = e.target as HTMLSelectElement;
          const v = sel.value;
          sel.value = '';
          if (v !== '') this.jumpToScene(Number(v));
        },
      },
      h('option', { value: '' }, scenes.length ? 'Jump to scene…' : 'No scenes'),
      ...scenes.map((s) => {
        const indent = s.level === undefined && scenes.some((a) => a.level !== undefined && a.index < s.index && a.end > s.index) ? '\u00a0\u00a0\u00a0' : '';
        return h('option', { value: String(s.index) }, `${indent}${s.recorded === s.lines && s.lines ? '✓ ' : ''}${s.title} (${s.recorded}/${s.lines})`);
      }),
    );
  }

  private renderSummary(): void {
    const script = store.project.script;
    if (!script) return this.summary.replaceChildren();
    const pr = scriptProgress(script);
    const pct = pr.lines ? Math.round((pr.recorded / pr.lines) * 100) : 0;
    this.summary.replaceChildren(
      h('div', { class: 'script-title' }, h('strong', null, script.title), script.source ? h('span', { class: 'muted' }, ` · ${script.source}`) : null),
      h(
        'div',
        { class: 'script-progress', title: `${pr.recorded} of ${pr.lines} lines recorded` },
        h('div', { class: 'script-progress-bar' }, h('div', { class: 'script-progress-fill', style: `width: ${pct}%` })),
        h('span', null, `${pr.recorded} of ${pr.lines} recorded`),
      ),
      h(
        'label',
        { class: 'script-open-only', title: 'Hide the lines that are ticked off' },
        h('input', {
          type: 'checkbox',
          checked: this.openOnly,
          onchange: (e: Event) => {
            this.openOnly = (e.target as HTMLInputElement).checked;
            save(OPEN_ONLY_KEY, this.openOnly ? '1' : '0');
            this.renderLines();
          },
        }),
        ' Open lines only',
      ),
    );
  }

  private renderCast(): void {
    const p = store.project;
    const script = p.script;
    if (!script) return this.cast.replaceChildren();
    const chars = scriptCharacters(script);
    const tracks = p.tracks.filter((t) => t.kind !== 'soundboard');
    const color = (key: string) => tracks.find((t) => t.id === script.cast[key])?.color ?? 'var(--muted)';
    const missing = chars.filter((c) => !script.cast[c.key]).length;
    const chips = h(
      'div',
      { class: 'script-chips' },
      ...chars.map((c) =>
        h(
          'button',
          {
            class: `script-chip${this.main.character === c.key ? ' on' : ''}${c.recorded === c.lines ? ' done' : ''}`,
            style: `--char-color: ${color(c.key)}`,
            title: this.main.character === c.key ? 'Show every character again' : `Only ${c.name}'s lines`,
            onclick: () => {
              this.main.character = this.main.character === c.key ? null : c.key;
              this.renderCast();
              this.renderLines();
            },
          },
          h('span', { class: 'name' }, c.name),
          h('span', { class: 'count' }, `${c.recorded}/${c.lines}`),
        ),
      ),
    );
    const details = h(
      'details',
      { class: 'script-tracks', open: this.castOpen || missing > 0 },
      h(
        'summary',
        { onclick: (e: Event) => (this.castOpen = !(e.currentTarget as HTMLElement).parentElement!.hasAttribute('open')) },
        missing ? `Tracks: ${missing} character${missing === 1 ? '' : 's'} without a track` : 'Tracks',
      ),
      ...chars.map((c) =>
        h(
          'label',
          { class: 'script-cast-row' },
          h('span', { class: 'dot', style: `background: ${color(c.key)}` }),
          h('span', { class: 'name' }, c.name),
          h(
            'select',
            {
              title: `The track ${c.name}'s lines are recorded on: Line up looks for them there`,
              onchange: (e: Event) => {
                const v = (e.target as HTMLSelectElement).value;
                store.edit((q) => setCast(q, c.key, v || null));
              },
            },
            h('option', { value: '' }, '— any track —'),
            ...tracks.map((t) => h('option', { value: t.id, selected: script.cast[c.key] === t.id }, t.name)),
          ),
        ),
      ),
    );
    this.cast.replaceChildren(chips, details);
  }

  private renderLines(): void {
    const script = store.project.script;
    this.hiddenRows = script ? foldedLines(script.lines, this.folded) : [];
    // a line hidden in a fold keeps its place as the one to record next
    if (script && !this.visible(this.focus, this.main, true)) this.focus = this.nextVisible(-1, 1, this.main, true, true);
    for (const v of this.views()) this.renderView(v);
    if (this.popout) this.renderWindowHead();
    this.updatePosition();
  }

  private renderView(view: LinesView): void {
    const p = store.project;
    const script = p.script;
    view.rows.clear();
    view.current = -1;
    if (!script) {
      view.body.replaceChildren(
        h(
          'div',
          { class: 'script-empty muted' },
          h('p', null, 'Import the script of your audio drama to see every line by character, tick lines off as they are recorded and jump to scenes.'),
          h('p', null, 'Plain text with one line per speech, like ', h('code', null, 'ANNA: Is this the night train?'), ', Fountain (.fountain), Final Draft (.fdx) and PlotGod audioplay exports (.json) work. Scene headings (INT. …, Scene 2, # …) become jump points.'),
          h('p', null, 'Name the tracks like the characters and Line up finds each line in the transcript by itself.'),
        ),
      );
      return;
    }
    const tracks = new Map(p.tracks.map((t) => [t.id, t]));
    const frag = document.createDocumentFragment();
    const scenes = new Map(scriptScenes(script).map((s) => [s.index, s]));
    script.lines.forEach((l: ScriptLine, i) => {
      if (this.hiddenRows[i]) return;
      if (l.kind === 'scene') {
        const s = scenes.get(i);
        const level = headingLevel(l);
        const folded = this.folded.has(l.id);
        const act = s?.level !== undefined;
        const head = h(
          'div',
          {
            class: `script-scene${act ? ' act' : ''}${folded ? ' folded' : ''}${s && s.lines && s.recorded === s.lines ? ' done' : ''}`,
            'data-scene': String(i),
            'data-level': String(level),
            title: `Jump to this ${act ? 'act' : 'scene'}`,
          },
          h(
            'button',
            {
              class: 'script-fold',
              'data-fold': String(i),
              'aria-expanded': String(!folded),
              'aria-label': `${folded ? 'Unfold' : 'Fold'} ${l.text}`,
              title: folded ? 'Unfold: show its lines' : `Fold: hide the lines of this ${act ? 'act' : 'scene'}`,
            },
            folded ? '▸' : '▾',
          ),
          h('span', { class: 'title' }, l.text),
          s?.lines ? h('span', { class: 'count' }, `${s.recorded}/${s.lines}`) : null,
        );
        view.rows.set(i, head);
        frag.append(head);
        return;
      }
      if (l.kind === 'action') {
        if (view.character || this.openOnly) return;
        const row = h('div', { class: 'script-action' }, l.text);
        view.rows.set(i, row);
        frag.append(row);
        return;
      }
      if (!this.visible(i, view) || (this.openOnly && l.recorded && i !== this.focus)) return;
      const track = tracks.get(lineTrack(script, l) ?? '');
      const placed = this.placedAt.get(i);
      const row = h(
        'div',
        {
          class: `script-line${l.recorded ? ' recorded' : ''}${placed ? ' placed' : ''}${i === this.focus ? ' focus' : ''}`,
          'data-line': String(i),
          style: `--char-color: ${track?.color ?? 'var(--muted)'}`,
          title: placed ? 'Click to jump to the take (Shift+Enter)' : l.recorded ? 'Recorded, but its take is not on the timeline' : 'Enter ticks it off at the playhead',
        },
        h('button', { class: 'script-tick', 'aria-label': l.recorded ? 'Recorded: click to untick' : 'Tick off as recorded', 'aria-pressed': String(!!l.recorded) }, l.recorded ? '✓' : ''),
        h(
          'div',
          { class: 'script-line-main' },
          h(
            'div',
            { class: 'script-speaker' },
            h('span', { class: 'name' }, l.character ?? ''),
            l.note ? h('span', { class: 'note' }, `(${l.note})`) : null,
            placed ? h('span', { class: 'time' }, formatTimestamp(placed.start / p.sampleRate, false)) : null,
            l.take?.takes ? h('span', { class: 'takes', title: `The transcript holds ${l.take.takes} takes of this line; the best one (of equally good ones the last) is marked` }, `${l.take.takes} takes`) : null,
          ),
          h('div', { class: 'script-text' }, l.text),
        ),
      );
      view.rows.set(i, row);
      frag.append(row);
    });
    const scroll = view.body.scrollTop;
    view.body.replaceChildren(frag);
    // with a character filter, headings without any of their lines go (scenes first, then their acts)
    if (view.character) {
      for (const el of [...view.body.querySelectorAll<HTMLElement>('.script-scene:not(.folded)')].reverse()) {
        const next = el.nextElementSibling as HTMLElement | null;
        if (!next || (next.classList.contains('script-scene') && Number(next.dataset.level) <= Number(el.dataset.level))) {
          view.rows.delete(Number(el.dataset.scene));
          el.remove();
        }
      }
    }
    view.body.scrollTop = scroll;
  }

  /** The script window's heading: the script, where the next line is, how far the recording is. */
  private renderWindowHead(): void {
    const pw = this.popout;
    if (!pw || pw.win.closed) return;
    const script = store.project.script;
    pw.win.document.title = script ? `${script.title} – Script` : 'Script – WavePod';
    pw.title.textContent = script?.title ?? 'No script';
    const lines = script?.lines ?? [];
    pw.scene.textContent = this.focus >= 0 ? headingsAbove(lines, this.focus).map((i) => lines[i].text).join(' › ') : '';
    const pr = script ? scriptProgress(script) : null;
    pw.progress.textContent = pr ? `${pr.recorded} of ${pr.lines} recorded` : '';
    const chars = script ? scriptCharacters(script) : [];
    if (pw.view.character && !chars.some((c) => c.key === pw.view.character)) pw.view.character = null;
    const want = ['', ...chars.map((c) => c.key)].join('|');
    if (pw.characters.dataset.keys !== want) {
      pw.characters.dataset.keys = want;
      pw.characters.replaceChildren(
        h('option', { value: '' }, 'All characters'),
        ...chars.map((c) => h('option', { value: c.key }, c.name)),
      );
    }
    pw.characters.value = pw.view.character ?? '';
  }

  private render(): void {
    const p = store.project;
    this.shownProject = p;
    this.placed = placedLines(p);
    this.placedAt = new Map(this.placed.map((x) => [x.index, x]));
    if (this.main.character && !p.script?.lines.some((l) => characterKey(l.character ?? '') === this.main.character)) this.main.character = null;
    this.renderToolbar();
    this.renderSummary();
    this.renderCast();
    this.renderLines();
  }
}

/** The folded headings remembered from last time. */
function readFolded(): string[] {
  try {
    const v = JSON.parse(load(FOLDED_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
