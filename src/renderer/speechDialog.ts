// Transcript › Change words (experimental): type a word or a short phrase, ElevenLabs says it in
// the speaker's voice (cloned from their track, or one of the account's voices), and it is put
// into the recording in place of the chosen words, or before or after them. One undo step.
import type { SpeechInfo, SpokenWords, TimelineWord, TrackVoice } from '../shared/types';
import { speechContext, speechEditRange, spliceSpeech, type ElevenVoice, type SpeechEditMode } from '../core/speech';
import { updateTrack } from '../core/project';
import { clear, errorMessage, h, toast } from './dom';
import { seek } from './actions';
import { api, store } from './store';

const CLONE = '__clone__';

let voiceCache: ElevenVoice[] | null = null;

export class SpeechDialog {
  private overlay = h('div', { class: 'overlay' });
  private words: TimelineWord[] = [];
  private from = 0;
  private to = 0;
  private mode: SpeechEditMode = 'replace';
  private text = '';
  private voiceId = '';
  private info: SpeechInfo | null = null;
  private voices: ElevenVoice[] | null = voiceCache;
  private voicesError = '';
  private consent = false;
  private busy = '';
  private error = '';
  /** The last generated words and what they were made from. */
  private spoken: { key: string; result: SpokenWords } | null = null;
  /** The project the words were picked in; an edit since then makes their positions stale. */
  private pickedIn = store.project;

  constructor() {
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay && !this.busy) this.close();
    });
    this.overlay.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' && !this.busy) this.close();
    });
  }

  /** Opens for the words `from..to` (indices into `words`, all on one track). */
  open(words: TimelineWord[], from: number, to: number, mode: SpeechEditMode = 'replace'): void {
    this.words = words;
    this.from = Math.min(from, to);
    this.to = Math.max(from, to);
    const trackIds = new Set(words.slice(this.from, this.to + 1).map((w) => w.trackId));
    if (trackIds.size > 1) return toast('Choose words of one speaker to change', 'error');
    this.mode = mode;
    this.text = mode === 'replace' ? this.chosenText() : '';
    this.pickedIn = store.project;
    this.spoken = null;
    this.error = '';
    this.consent = false;
    this.voiceId = this.track()?.voice?.id ?? '';
    document.body.append(this.overlay);
    this.render();
    this.overlay.querySelector<HTMLInputElement>('.speech-text')?.select();
    void this.load();
  }

  close(): void {
    void api().previewSound(null);
    this.overlay.remove();
  }

  private get trackId(): string {
    return this.words[this.from]?.trackId ?? '';
  }

  private track() {
    return store.project.tracks.find((t) => t.id === this.trackId);
  }

  private chosenText(): string {
    return this.words
      .slice(this.from, this.to + 1)
      .map((w) => w.text)
      .join(' ');
  }

  private async load(): Promise<void> {
    try {
      this.info = await api().getSpeechInfo();
      if (!this.info.hasKey) {
        this.error = 'Add your ElevenLabs API key first: Edit › Settings.';
        return this.render();
      }
      this.render();
      if (!this.voices) {
        this.voices = voiceCache = await api().listVoices();
        this.render();
      }
    } catch (e) {
      this.voicesError = errorMessage(e);
      this.render();
    }
  }

  private key(): string {
    const s = this.info?.settings;
    return JSON.stringify([this.text.trim(), this.voiceId, this.mode, s?.model, s?.hq, this.from, this.to]);
  }

  private async generate(): Promise<SpokenWords | null> {
    if (this.spoken?.key === this.key()) return this.spoken.result;
    if (!this.text.trim()) {
      this.error = 'Type the words to say.';
      this.render();
      return null;
    }
    if (!this.voiceId || this.voiceId === CLONE) {
      this.error = 'Choose a voice first, or clone the speaker’s voice.';
      this.render();
      return null;
    }
    const key = this.key();
    const [at] = speechEditRange(this.words, this.from, this.to, this.mode, store.sampleRate);
    const ctx = speechContext(this.words, this.trackId, this.mode === 'after' ? this.to + 1 : this.from, this.mode === 'before' ? this.from - 1 : this.to);
    this.busy = 'Generating…';
    this.error = '';
    this.render();
    try {
      const result = await api().speakWords({ trackId: this.trackId, voiceId: this.voiceId, text: this.text.trim(), ...ctx, mode: this.mode, at });
      this.spoken = { key, result };
      return result;
    } catch (e) {
      this.error = errorMessage(e);
      return null;
    } finally {
      this.busy = '';
      this.render();
    }
  }

  private async listen(): Promise<void> {
    const r = await this.generate();
    if (!r) return;
    const g = 10 ** (r.gain / 20);
    if (!(await api().previewSound([r.samples.map((v) => v * g)]))) toast('Nothing to play on: no output device is open', 'error');
  }

  private async put(): Promise<void> {
    if (store.project !== this.pickedIn) {
      this.error = 'The episode changed since you picked the words. Close this and pick them again.';
      return this.render();
    }
    const r = await this.generate();
    if (!r) return;
    this.busy = 'Putting it in…';
    this.render();
    try {
      const text = this.text.trim();
      const { file, length } = await api().storeSpokenWords(text, { samples: r.samples, pad: r.pad });
      const [start, end] = speechEditRange(this.words, this.from, this.to, this.mode, store.sampleRate);
      let clipId = '';
      store.edit((p) => {
        const res = spliceSpeech(p, { trackId: this.trackId, start, end, file, length, gain: r.gain });
        clipId = res.clipId;
        return res.project;
      });
      store.select({ clipIds: new Set([clipId]), range: null, rangeTracks: null, markerId: null });
      seek(Math.max(0, start - Math.round(store.sampleRate * 1.5)));
      const what = this.mode === 'replace' ? `Replaced “${this.chosenText()}” with` : 'Put in';
      toast(`${what} “${text}” (Ctrl+Z undoes it)`);
      this.busy = '';
      this.close();
    } catch (e) {
      this.busy = '';
      this.error = errorMessage(e);
      this.render();
    }
  }

  private async clone(): Promise<void> {
    const track = this.track();
    if (!track) return;
    this.busy = `Cloning ${track.name}’s voice…`;
    this.error = '';
    this.render();
    try {
      const v = await api().cloneVoice(track.id);
      this.setVoice(track.id, { id: v.id, name: v.name, cloned: true });
      voiceCache = null;
      this.voices = [{ id: v.id, name: v.name, category: 'cloned' }, ...(this.voices ?? [])];
      this.voiceId = v.id;
      toast(`Cloned ${track.name}’s voice from ${v.seconds} s of speech`);
    } catch (e) {
      this.error = errorMessage(e);
    } finally {
      this.busy = '';
      this.render();
    }
  }

  private async removeClone(): Promise<void> {
    const track = this.track();
    const v = track?.voice;
    if (!track || !v?.cloned) return;
    this.busy = 'Deleting the cloned voice…';
    this.render();
    try {
      await api().deleteVoice(v.id);
      this.setVoice(track.id, undefined);
      this.voices = (this.voices ?? []).filter((x) => x.id !== v.id);
      voiceCache = this.voices;
      this.voiceId = '';
      toast(`Deleted ${v.name} from your ElevenLabs account`);
    } catch (e) {
      this.error = errorMessage(e);
    } finally {
      this.busy = '';
      this.render();
    }
  }

  /** Remembers the speaker's voice on the track (not an undo step; the picked words stay valid). */
  private setVoice(trackId: string, voice: TrackVoice | undefined): void {
    const fresh = store.project === this.pickedIn;
    store.patch((p) => updateTrack(p, trackId, { voice }));
    if (fresh) this.pickedIn = store.project;
  }

  private chooseVoice(id: string): void {
    this.voiceId = id;
    this.error = '';
    const track = this.track();
    const v = this.voices?.find((x) => x.id === id);
    // remember the voice for this speaker (a cloned one stays marked as ours)
    if (track && v && track.voice?.id !== id) this.setVoice(track.id, { id: v.id, name: v.name });
    this.render();
  }

  private async setting(patch: Partial<SpeechInfo['settings']>): Promise<void> {
    try {
      this.info = await api().setSpeechSettings(patch);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
    this.render();
  }

  private render(): void {
    clear(this.overlay);
    const track = this.track();
    const busy = !!this.busy;
    const s = this.info?.settings;
    const chosen = this.chosenText();
    const before = speechContext(this.words, this.trackId, this.from, this.to, 8).previousText;
    const after = speechContext(this.words, this.trackId, this.from, this.to, 8).nextText;
    const voices = this.voices ?? [];
    const own = track?.voice;
    const known = voices.some((v) => v.id === this.voiceId) || (!!own && own.id === this.voiceId);
    const cloning = this.voiceId === CLONE || (!this.voiceId && !own);
    const modeBtn = (m: SpeechEditMode, label: string) =>
      h(
        'label',
        { class: 'check' },
        h('input', {
          type: 'radio',
          name: 'speech-mode',
          checked: this.mode === m,
          disabled: busy,
          onchange: () => {
            if (this.mode === 'replace' && this.text === chosen) this.text = '';
            this.mode = m;
            if (m === 'replace' && !this.text) this.text = chosen;
            this.render();
          },
        }),
        label,
      );
    const dialog = h(
      'div',
      { class: 'dialog narrow speech-dialog' },
      h('h2', null, 'Change words ', h('span', { class: 'badge-experimental' }, 'Experimental')),
      h(
        'p',
        { class: 'speech-context', style: `--track-color: ${track?.color ?? 'var(--muted)'}` },
        h('span', { class: 'speaker' }, track?.name ?? ''),
        before ? `…${before} ` : '',
        h('mark', null, chosen),
        after ? ` ${after}…` : '',
      ),
      h('div', { class: 'speech-modes' }, modeBtn('replace', `Replace “${chosen.length > 30 ? `${chosen.slice(0, 30)}…` : chosen}”`), modeBtn('before', 'Insert before'), modeBtn('after', 'Insert after')),
      h(
        'label',
        { class: 'field' },
        h('span', null, this.mode === 'replace' ? 'Say instead' : 'Words to insert'),
        h('input', {
          type: 'text',
          class: 'speech-text',
          value: this.text,
          maxLength: 400,
          disabled: busy,
          placeholder: 'A word or a short phrase',
          oninput: (e: Event) => {
            this.text = (e.target as HTMLInputElement).value;
            this.error = '';
          },
          onkeydown: (e: KeyboardEvent) => {
            if (e.key === 'Enter') void (e.ctrlKey || e.metaKey ? this.put() : this.listen());
          },
        }),
      ),
      h(
        'div',
        { class: 'settings-grid' },
        h(
          'label',
          { class: 'field' },
          h('span', null, 'Voice'),
          h(
            'select',
            { class: 'speech-voice', disabled: busy, onchange: (e: Event) => this.chooseVoice((e.target as HTMLSelectElement).value) },
            h('option', { value: CLONE, selected: cloning }, `Clone ${track?.name ?? 'the speaker'}’s voice from this episode…`),
            own && !voices.some((v) => v.id === own.id) ? h('option', { value: own.id, selected: own.id === this.voiceId }, `${own.name}${own.cloned ? ' (cloned)' : ''}`) : null,
            ...voices.map((v) => h('option', { value: v.id, selected: v.id === this.voiceId }, `${v.name}${v.category === 'cloned' ? ' (cloned)' : ''}`)),
            this.voiceId && !known && this.voiceId !== CLONE ? h('option', { value: this.voiceId, selected: true }, this.voiceId) : null,
          ),
        ),
        h(
          'label',
          { class: 'field' },
          h('span', null, 'Model'),
          h(
            'select',
            { disabled: busy || !s, onchange: (e: Event) => void this.setting({ model: (e.target as HTMLSelectElement).value }) },
            ...(this.info?.models ?? []).map((m) => h('option', { value: m.id, selected: m.id === s?.model, title: m.description }, m.name)),
          ),
        ),
      ),
      this.voicesError ? h('p', { class: 'error-text' }, this.voicesError) : !this.voices && this.info?.hasKey ? h('p', { class: 'muted' }, 'Loading your voices…') : null,
      cloning
        ? h(
            'div',
            { class: 'speech-clone' },
            h(
              'p',
              { class: 'muted' },
              `Up to 90 seconds of ${track?.name ?? 'this speaker'}’s transcribed speech is uploaded to ElevenLabs and becomes an instant voice clone in your account. It is remembered for this track.`,
            ),
            h(
              'label',
              { class: 'check' },
              h('input', {
                type: 'checkbox',
                checked: this.consent,
                disabled: busy,
                onchange: (e: Event) => {
                  this.consent = (e.target as HTMLInputElement).checked;
                  this.render();
                },
              }),
              'I have this speaker’s permission to clone their voice',
            ),
            h('div', { class: 'row' }, h('button', { class: 'small primary', disabled: busy || !this.consent || !this.info?.hasKey, onclick: () => void this.clone() }, 'Clone voice')),
          )
        : own?.cloned && own.id === this.voiceId
          ? h('p', { class: 'muted speech-own' }, 'Cloned from this track. ', h('button', { class: 'link', disabled: busy, onclick: () => void this.removeClone() }, 'Delete it from ElevenLabs'))
          : null,
      h(
        'label',
        { class: 'check', title: 'pcm_44100 instead of pcm_24000. ElevenLabs only offers it on the Pro plan and up.' },
        h('input', { type: 'checkbox', checked: !!s?.hq, disabled: busy || !s, onchange: (e: Event) => void this.setting({ hq: (e.target as HTMLInputElement).checked }) }),
        'High quality (44.1 kHz, needs an ElevenLabs Pro plan)',
      ),
      this.busy
        ? h('p', { class: 'speech-status busy' }, h('span', { class: 'spinner' }), this.busy)
        : this.error
          ? h('p', { class: 'error-text' }, this.error)
          : this.spoken?.key === this.key()
            ? h(
                'p',
                { class: 'ok-text' },
                `✓ ${((this.spoken.result.samples.length - 2 * this.spoken.result.pad) / store.sampleRate).toFixed(2)} s, ${this.spoken.result.gain >= 0 ? '+' : ''}${this.spoken.result.gain.toFixed(1)} dB to match ${track?.name ?? 'the speaker'}`,
              )
            : h('p', { class: 'muted' }, 'Enter listens, Ctrl+Enter puts it in. The words around it are sent too, so the intonation fits. Every take costs ElevenLabs credits.'),
      h(
        'div',
        { class: 'row end' },
        h('button', { disabled: busy, onclick: () => this.close() }, 'Cancel'),
        h('button', { disabled: busy || cloning, onclick: () => void this.listen() }, '▶ Listen'),
        h('button', { class: 'primary', disabled: busy || cloning, onclick: () => void this.put() }, this.mode === 'replace' ? 'Replace' : 'Insert'),
      ),
    );
    this.overlay.append(dialog);
    if (!busy) {
      const input = dialog.querySelector<HTMLInputElement>('.speech-text');
      if (input && document.activeElement?.closest('.speech-dialog') == null) input.focus();
    }
  }
}
