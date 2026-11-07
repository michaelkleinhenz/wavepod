// View › Script: the audio drama script beside the timeline. Import a plain-text, Fountain or
// Final Draft script; every line shows who speaks it, ticks off as recorded and, once its take is
// known, jumps there. "Line up" finds the lines in the transcript; while recording, Enter ticks the
// focused line at the playhead and moves on to the next open one.
import type { Project, ScriptLine } from '../shared/types';
import {
  SCRIPT_EXTENSIONS,
  applyLineUp,
  characterKey,
  createScript,
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
    const res = await api().openTextFile('Script (plain text, Fountain or Final Draft)', SCRIPT_EXTENSIONS);
    if (!res) return false;
    const name = res.path.replace(/^.*[\\/]/, '');
    const parsed = parseScript(res.text, name);
    const n = parsed.lines.filter((l) => l.kind === 'dialogue').length;
    if (!n) {
      toast(`No lines found in ${name}. Write them as "NAME: what they say", or use Fountain or Final Draft.`, 'error');
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

export class ScriptPanel {
  readonly el = h('aside', { class: 'script-panel', tabIndex: -1 });
  private toolbar = h('div', { class: 'script-toolbar' });
  private summary = h('div', { class: 'script-summary' });
  private cast = h('div', { class: 'script-cast' });
  private body = h('div', { class: 'script-body' });
  private rows = new Map<number, HTMLElement>();
  private shownProject: Project | null = null;
  private placed: PlacedLine[] = [];
  private placedAt = new Map<number, PlacedLine>();
  /** Index (into script.lines) of the line the keys act on. */
  private focus = -1;
  private current = -1;
  /** Only this character's lines (upper-case key), or all. */
  private character: string | null = null;
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
      this.body,
    );
    this.body.addEventListener('click', (e) => this.click(e));
    this.el.addEventListener('keydown', (e) => this.key(e));
    transcripts().subscribe(() => this.shown && this.renderToolbar());
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
      this.scrollTo(this.focus);
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
    if (!this.shown || this.hidden || p === this.shownProject) return;
    this.render();
  }

  /** Transport update: highlight the line playing. */
  updatePosition(): void {
    if (!this.shown || this.hidden || !this.placed.length) return;
    const t = store.transport;
    const i = t.state === 'stopped' && !this.placedAt.size ? -1 : lineAt(this.placed, t.position, store.sampleRate);
    if (i === this.current) return;
    this.rows.get(this.current)?.classList.remove('current');
    this.current = i;
    const row = this.rows.get(i);
    if (!row) return;
    row.classList.add('current');
    if (t.state === 'playing') this.scrollTo(i, true);
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

  private jumpToScene(sceneIndex: number): void {
    const p = store.project;
    const at = sceneStart(p, sceneIndex, this.placed);
    const first = sceneIndex + 1;
    this.setFocus(this.visible(first) ? first : this.nextVisible(sceneIndex, 1));
    this.scrollTo(sceneIndex < 0 ? this.focus : sceneIndex, false, 'start');
    if (at === null) return toast('Nothing of this scene is recorded yet');
    seek(at);
    store.select({ range: null, rangeTracks: null, clipIds: new Set() });
  }

  private menu(e: MouseEvent): void {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const has = !!store.project.script;
    showContextMenu(
      [
        { label: has ? 'Import a New Draft…' : 'Import Script…', title: 'Lines that stay the same keep their recorded ticks', run: () => void importScriptFile() },
        { label: 'Tick All Lines Off', enabled: has, run: () => this.untickAll() },
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

  private visible(i: number): boolean {
    const l = store.project.script?.lines[i];
    if (!l || l.kind !== 'dialogue') return false;
    if (this.character && characterKey(l.character ?? '') !== this.character) return false;
    return true;
  }

  private nextVisible(from: number, dir: 1 | -1, open = false): number {
    const lines = store.project.script?.lines ?? [];
    for (let i = from + dir; i >= 0 && i < lines.length; i += dir) if (this.visible(i) && (!open || !lines[i].recorded)) return i;
    return -1;
  }

  private setFocus(i: number): void {
    this.rows.get(this.focus)?.classList.remove('focus');
    this.focus = i;
    this.rows.get(i)?.classList.add('focus');
  }

  private scrollTo(i: number, gentle = false, block: ScrollLogicalPosition = 'center'): void {
    const row = this.rows.get(i);
    if (!row) return;
    if (gentle) {
      const b = this.body.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      if (r.top >= b.top + 30 && r.bottom <= b.bottom - 30) return;
    }
    row.scrollIntoView({ block });
  }

  private key(e: KeyboardEvent): void {
    if ((e.target as HTMLElement).closest('select, input:not([type=checkbox])')) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const n = this.nextVisible(this.focus < 0 && e.key === 'ArrowUp' ? Infinity : this.focus, e.key === 'ArrowDown' ? 1 : -1);
      if (n >= 0) {
        this.setFocus(n);
        this.scrollTo(n, true);
      }
    } else if (e.key === 'Enter' && this.focus >= 0) {
      // the recording flow: tick the line just spoken, go on to the next open one
      e.preventDefault();
      e.stopPropagation();
      const l = store.project.script?.lines[this.focus];
      if (!l) return;
      if (e.shiftKey) return this.jump(this.focus);
      this.toggleLine(this.focus, true);
      const n = this.nextVisible(this.focus, 1, true);
      if (n >= 0) {
        this.setFocus(n);
        this.scrollTo(n, true);
      }
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.focus >= 0) {
      e.preventDefault();
      e.stopPropagation();
      this.toggleLine(this.focus, false);
    }
  }

  private click(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    const scene = t.closest<HTMLElement>('[data-scene]');
    if (scene) return this.jumpToScene(Number(scene.dataset.scene));
    const row = t.closest<HTMLElement>('[data-line]');
    if (!row) return;
    const i = Number(row.dataset.line);
    this.el.focus({ preventScroll: true });
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
      h('button', { class: script ? 'small' : 'small primary', title: 'Plain text (NAME: line), Fountain (.fountain) or Final Draft (.fdx)', onclick: () => void importScriptFile() }, script ? 'Import…' : 'Import script…'),
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
      ...scenes.map((s) => h('option', { value: String(s.index) }, `${s.recorded === s.lines && s.lines ? '✓ ' : ''}${s.title} (${s.recorded}/${s.lines})`)),
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
            class: `script-chip${this.character === c.key ? ' on' : ''}${c.recorded === c.lines ? ' done' : ''}`,
            style: `--char-color: ${color(c.key)}`,
            title: this.character === c.key ? 'Show every character again' : `Only ${c.name}'s lines`,
            onclick: () => {
              this.character = this.character === c.key ? null : c.key;
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
    const p = store.project;
    const script = p.script;
    this.rows.clear();
    this.current = -1;
    if (!script) {
      this.body.replaceChildren(
        h(
          'div',
          { class: 'script-empty muted' },
          h('p', null, 'Import the script of your audio drama to see every line by character, tick lines off as they are recorded and jump to scenes.'),
          h('p', null, 'Plain text with one line per speech, like ', h('code', null, 'ANNA: Is this the night train?'), ', Fountain (.fountain) and Final Draft (.fdx) work. Scene headings (INT. …, Scene 2, # …) become jump points.'),
          h('p', null, 'Name the tracks like the characters and Line up finds each line in the transcript by itself.'),
        ),
      );
      return;
    }
    const tracks = new Map(p.tracks.map((t) => [t.id, t]));
    const frag = document.createDocumentFragment();
    const scenes = new Map(scriptScenes(script).map((s) => [s.index, s]));
    script.lines.forEach((l: ScriptLine, i) => {
      if (l.kind === 'scene') {
        const s = scenes.get(i);
        const head = h(
          'div',
          { class: `script-scene${s && s.lines && s.recorded === s.lines ? ' done' : ''}`, 'data-scene': String(i), title: 'Jump to this scene' },
          h('span', { class: 'title' }, l.text),
          s?.lines ? h('span', { class: 'count' }, `${s.recorded}/${s.lines}`) : null,
        );
        this.rows.set(i, head);
        frag.append(head);
        return;
      }
      if (l.kind === 'action') {
        if (this.character || this.openOnly) return;
        const row = h('div', { class: 'script-action' }, l.text);
        this.rows.set(i, row);
        frag.append(row);
        return;
      }
      if (!this.visible(i) || (this.openOnly && l.recorded && i !== this.focus)) return;
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
      this.rows.set(i, row);
      frag.append(row);
    });
    const scroll = this.body.scrollTop;
    this.body.replaceChildren(frag);
    // with a character filter, scene headings without any of their lines go
    if (this.character) {
      for (const el of [...this.body.querySelectorAll<HTMLElement>('.script-scene')]) {
        const next = el.nextElementSibling;
        if (!next || next.classList.contains('script-scene')) el.remove();
      }
    }
    this.body.scrollTop = scroll;
    if (!this.rows.has(this.focus) || !this.visible(this.focus)) this.focus = this.nextVisible(-1, 1, true);
    this.rows.get(this.focus)?.classList.add('focus');
    this.updatePosition();
  }

  private render(): void {
    const p = store.project;
    this.shownProject = p;
    this.placed = placedLines(p);
    this.placedAt = new Map(this.placed.map((x) => [x.index, x]));
    if (this.character && !p.script?.lines.some((l) => characterKey(l.character ?? '') === this.character)) this.character = null;
    this.renderToolbar();
    this.renderSummary();
    this.renderCast();
    this.renderLines();
  }
}
