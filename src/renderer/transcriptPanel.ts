// View › Transcript: the episode as text beside the timeline. Click a word to jump there; drag
// across words to select that time; Delete cuts it out of every track (ripple cut), so editing
// the text edits the audio. Delete right after clicking a single word cuts just that word.
// Enter or a double-click changes the words: speech synthesis says new ones (experimental).
// Hesitations are marked, the playing word is highlighted.
import type { TimelineWord } from '../shared/types';
import { paragraphs, transcriptText, transcriptVtt, wordAt, wordsRange } from '../core/transcript';
import { formatTimestamp } from '../shared/time';
import { errorMessage, h, toast } from './dom';
import { rippleCut, seek } from './actions';
import { api, store } from './store';
import { transcripts } from './transcripts';
import { SpeechDialog } from './speechDialog';

export class TranscriptPanel {
  readonly el = h('aside', { class: 'transcript-panel', tabIndex: -1 });
  private body = h('div', { class: 'transcript-body' });
  private toolbar = h('div', { class: 'transcript-toolbar' });
  private status = h('div', { class: 'transcript-status muted' });
  private spans: HTMLSpanElement[] = [];
  private shownWords: TimelineWord[] | null = null;
  private current = -1;
  private anchor: number | null = null;
  /** The word last clicked (without dragging): Delete cuts it when nothing is selected. */
  private picked: number | null = null;
  private dragging = false;
  private follow = true;
  private shown = false;
  private hidden = false;
  private speech = new SpeechDialog();
  /** Opens the cleanup dialog (set by the app shell). */
  onCleanup: () => void = () => {};

  constructor() {
    this.el.append(
      h('div', { class: 'fx-head' }, h('div', null, h('div', { class: 'fx-kicker' }, 'Text'), h('h2', null, 'Transcript')), h('button', { class: 'fx-close', title: 'Close', onclick: () => this.close() }, '×')),
      this.toolbar,
      this.status,
      this.body,
    );
    this.body.addEventListener('mousedown', (e) => this.down(e));
    this.body.addEventListener('mouseover', (e) => this.over(e));
    window.addEventListener('mouseup', () => (this.dragging = false));
    this.body.addEventListener('dblclick', (e) => {
      const i = this.index(e);
      if (i === null) return;
      e.preventDefault();
      this.changeWords();
    });
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'F2') {
        e.preventDefault();
        e.stopPropagation();
        this.changeWords();
        return;
      }
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (!store.selection.range && this.picked !== null) this.selectWords(this.picked, this.picked);
      if (!store.selection.range) return;
      // in the text, deleting words means cutting them out (the gap closes)
      e.preventDefault();
      e.stopPropagation();
      rippleCut();
      this.anchor = null;
      this.setPicked(null);
    });
    // scrolling by hand pauses following until the next click
    this.body.addEventListener('wheel', () => {
      if (store.transport.state === 'playing') this.follow = false;
    });
    transcripts().subscribe(() => this.shown && this.render());
  }

  get isOpen(): boolean {
    return this.shown;
  }

  toggle(): void {
    if (this.shown) this.close();
    else this.open();
  }

  open(): void {
    this.shown = true;
    this.follow = true;
    document.body.classList.add('transcript-open');
    void transcripts().ensureLoaded();
    this.render();
    if (!this.hidden) document.getElementById('app')!.append(this.el);
  }

  close(): void {
    this.shown = false;
    document.body.classList.remove('transcript-open');
    this.el.remove();
  }

  /** Off screen outside the edit view, back on return. */
  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    if (hidden) {
      this.el.remove();
      document.body.classList.remove('transcript-open');
    } else if (this.shown) {
      document.body.classList.add('transcript-open');
      this.render();
      document.getElementById('app')!.append(this.el);
    }
  }

  /** The project or selection changed. */
  refresh(): void {
    if (!this.shown || this.hidden) return;
    if (transcripts().words() !== this.shownWords) this.render();
    else this.markSelection();
  }

  /** Transport update: highlight the playing word and keep it in view. */
  updatePosition(): void {
    if (!this.shown || this.hidden || !this.shownWords) return;
    const i = wordAt(this.shownWords, store.transport.position);
    const w = this.shownWords[i];
    const idx = w && store.transport.position <= w.end + store.sampleRate * 0.3 ? i : -1;
    if (idx === this.current) return;
    this.spans[this.current]?.classList.remove('current');
    this.current = idx;
    const span = this.spans[idx];
    if (!span) return;
    span.classList.add('current');
    if (this.follow && store.transport.state === 'playing') {
      const b = this.body.getBoundingClientRect();
      const r = span.getBoundingClientRect();
      if (r.top < b.top + 40 || r.bottom > b.bottom - 40) span.scrollIntoView({ block: 'center' });
    }
  }

  private index(e: Event): number | null {
    const t = (e.target as HTMLElement).closest?.('[data-i]') as HTMLElement | null;
    return t ? Number(t.dataset.i) : null;
  }

  private down(e: MouseEvent): void {
    if (e.button !== 0) return;
    const i = this.index(e);
    if (i === null || !this.shownWords) return;
    e.preventDefault();
    this.el.focus({ preventScroll: true });
    this.follow = true;
    if (e.shiftKey && this.anchor !== null) {
      this.setPicked(null);
      this.selectWords(this.anchor, i);
      return;
    }
    this.anchor = i;
    this.dragging = true;
    // a plain click jumps there, clears a selection and picks the word for Delete; dragging selects
    store.select({ range: null, rangeTracks: null, clipIds: new Set() });
    this.setPicked(i);
    seek(this.shownWords[i].start);
  }

  private over(e: MouseEvent): void {
    if (!this.dragging || this.anchor === null || !(e.buttons & 1)) return;
    const i = this.index(e);
    if (i === null || i === this.anchor) return;
    this.setPicked(null);
    this.selectWords(this.anchor, i);
  }

  /** The chosen words: the selected ones, else the clicked one (indices into the shown words). */
  private chosenWords(): [number, number] | null {
    const words = this.shownWords ?? [];
    const r = store.selection.range;
    if (r) {
      let a = -1;
      let b = -1;
      words.forEach((w, i) => {
        if (w.start < r[0] - 1 || w.end > r[1] + 1) return;
        if (a < 0) a = i;
        b = i;
      });
      if (a >= 0) return [a, b];
    }
    return this.picked !== null && words[this.picked] ? [this.picked, this.picked] : null;
  }

  /** Experimental: type new words for the chosen ones (or around them); ElevenLabs says them. */
  changeWords(): void {
    const chosen = this.chosenWords();
    if (!chosen || !this.shownWords) return toast('Click a word first (or drag across some)');
    this.speech.open(this.shownWords, chosen[0], chosen[1]);
  }

  private setPicked(i: number | null): void {
    if (this.picked !== null) this.spans[this.picked]?.classList.remove('picked');
    this.picked = i;
    if (i !== null) this.spans[i]?.classList.add('picked');
  }

  private selectWords(a: number, b: number): void {
    const words = this.shownWords;
    if (!words) return;
    const r = wordsRange(words, a, b);
    if (!r) return;
    store.select({ range: r, rangeTracks: null, clipIds: new Set() });
  }

  private markSelection(): void {
    const r = store.selection.range;
    const words = this.shownWords ?? [];
    for (let i = 0; i < this.spans.length; i++) {
      const w = words[i];
      this.spans[i].classList.toggle('selected', !!r && w.start >= r[0] - 1 && w.end <= r[1] + 1);
    }
  }

  private async exportText(kind: 'txt' | 'vtt'): Promise<void> {
    const words = transcripts().words();
    if (!words.length) return toast('Nothing transcribed yet');
    const p = store.project;
    const text = kind === 'vtt' ? transcriptVtt(p, words) : transcriptText(p, words);
    const name = `${(p.metadata.title || p.name).replace(/[\\/:*?"<>|]+/g, '_')}.${kind}`;
    try {
      const saved = await api().saveTextFile(name, text);
      if (saved) toast(`Saved ${saved}`);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  }

  private renderToolbar(): void {
    const t = transcripts();
    const p = t.progress;
    const missing = !t.complete;
    this.toolbar.replaceChildren(
      t.busy
        ? h('button', { class: 'small', onclick: () => t.stop() }, 'Stop')
        : h('button', { class: missing ? 'small primary' : 'small', title: 'Upload the tracks to ElevenLabs speech-to-text. Only files without a transcript are sent.', onclick: () => void t.transcribe(false) }, missing ? 'Transcribe' : 'Up to date'),
      h('button', { class: 'small', title: 'Experimental: replace the clicked or selected words, or insert new ones, spoken by ElevenLabs in the speaker’s voice (Enter or double-click a word)', onclick: () => this.changeWords() }, 'Change…'),
      h('button', { class: 'small', title: 'Find long pauses and hesitations (äh, ähm, uh) and take them out', onclick: () => this.onCleanup() }, 'Clean up…'),
      h(
        'select',
        {
          class: 'transcript-export',
          title: 'Save the transcript',
          onchange: (e: Event) => {
            const v = (e.target as HTMLSelectElement).value as 'txt' | 'vtt' | '';
            (e.target as HTMLSelectElement).value = '';
            if (v) void this.exportText(v);
          },
        },
        h('option', { value: '' }, 'Save as…'),
        h('option', { value: 'txt' }, 'Text with speakers (.txt)'),
        h('option', { value: 'vtt' }, 'Subtitles (.vtt)'),
      ),
    );
    if (p) {
      const what = p.phase === 'preparing' ? 'Preparing' : p.phase === 'uploading' ? 'Uploading' : 'Transcribing';
      this.status.replaceChildren(h('span', { class: 'spinner' }), `${what} ${p.name ? `${p.name} ` : ''}(${p.file} of ${p.files})…`);
    } else if (t.busy) this.status.replaceChildren(h('span', { class: 'spinner' }), 'Starting…');
    else this.status.textContent = t.count ? 'Click a word to jump there · Delete cuts it · Enter or double-click changes it · drag to select more' : '';
    this.status.classList.toggle('busy', t.busy);
  }

  private render(): void {
    this.renderToolbar();
    const words = transcripts().words();
    if (words === this.shownWords) return this.markSelection();
    const scroll = this.body.scrollTop;
    this.shownWords = words;
    this.current = -1;
    this.spans = [];
    // word numbers refer to the words shown before
    this.anchor = null;
    this.picked = null;
    if (!words.length) {
      this.body.replaceChildren(
        h(
          'div',
          { class: 'transcript-empty muted' },
          transcripts().busy
            ? 'The transcript shows up here as soon as the first track is done.'
            : 'No transcript yet. Transcribe sends each speaker track to ElevenLabs and brings back every word with its time; then you can cut by deleting words, find hesitations and save subtitles.',
        ),
      );
      return;
    }
    const tracks = new Map(store.project.tracks.map((t) => [t.id, t]));
    const frag = document.createDocumentFragment();
    for (const para of paragraphs(words, store.sampleRate)) {
      const track = tracks.get(para.trackId);
      const text = h('p', { class: 'transcript-text' });
      for (const i of para.words) {
        const w = words[i];
        const span = h('span', { class: `w${w.filler ? ' filler' : ''}${w.muted ? ' muted' : ''}`, 'data-i': String(i) }, w.text);
        if (w.filler) span.title = 'Hesitation';
        this.spans[i] = span;
        text.append(span, ' ');
      }
      frag.append(
        h(
          'div',
          { class: 'transcript-para', style: `--track-color: ${track?.color ?? 'var(--muted)'}` },
          h('div', { class: 'transcript-speaker' }, h('span', { class: 'name' }, track?.name ?? ''), h('span', { class: 'time' }, formatTimestamp(para.start / store.sampleRate, false))),
          text,
        ),
      );
    }
    this.body.replaceChildren(frag);
    this.body.scrollTop = scroll;
    this.markSelection();
    this.updatePosition();
  }
}
