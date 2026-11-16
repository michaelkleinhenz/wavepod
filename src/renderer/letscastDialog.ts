// File › Upload to LetsCast.fm…: sign in on letscast.fm, pick the podcast and an existing episode,
// and send it the rendered MP3, the details, show notes, chapters and cover (each one optional).
// Empty values in WavePod are not sent, so they never clear anything on letscast.fm.
import type { ExportProgress, LetsCastEpisodeDetails, LetsCastEpisodeInfo, LetsCastInfo, LetsCastParts, LetsCastPodcastInfo } from '../shared/types';
import { parseEpisodeLink } from '../core/letscastPages';
import { clear, errorMessage, h, keepScroll, toast } from './dom';
import { api, store } from './store';

export class LetsCastDialog {
  private overlay = h('div', { class: 'overlay' });
  private info: LetsCastInfo | null = null;
  private podcasts: LetsCastPodcastInfo[] | null = null;
  private episodes: LetsCastEpisodeInfo[] | null = null;
  private podcast = '';
  private episode = '';
  private details: LetsCastEpisodeDetails | null = null;
  private error = '';
  private busy = false;
  private signingIn = false;
  private status = '';
  private result: string | null = null;
  private linkDraft = '';
  private parts: LetsCastParts = { audio: true, details: true, showNotes: true, chapters: true, cover: true };

  constructor() {
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay && !this.busy) this.close();
    });
    this.overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.busy) this.close();
    });
    api().onExportProgress((p) => this.progress(p));
  }

  async open(): Promise<void> {
    this.result = null;
    this.status = '';
    this.error = '';
    this.linkDraft = '';
    document.body.append(this.overlay);
    this.render();
    try {
      this.info = await api().letscastStatus();
      this.podcast = this.info.podcast;
      this.episode = this.info.episode;
      this.parts = { ...this.info.parts };
      if (!store.project.tracks.some((t) => t.clips.length)) this.parts.audio = false;
      this.render();
      if (this.info.signedIn) await this.loadPodcasts();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  }

  close(): void {
    this.overlay.remove();
  }

  private async guard(fn: () => Promise<void>): Promise<void> {
    this.error = '';
    try {
      await fn();
    } catch (e) {
      this.error = errorMessage(e);
      if (/sign in to letscast/i.test(this.error) && this.info) this.info = { ...this.info, signedIn: false };
    }
    this.render();
  }

  private loadPodcasts(): Promise<void> {
    return this.guard(async () => {
      this.podcasts = await api().letscastPodcasts();
      if (!this.podcasts.some((p) => p.slug === this.podcast)) this.podcast = this.podcasts[0]?.slug ?? '';
      this.render();
      await this.loadEpisodes();
    });
  }

  private loadEpisodes(): Promise<void> {
    return this.guard(async () => {
      this.episodes = null;
      if (!this.podcast) return;
      this.episodes = await api().letscastEpisodes(this.podcast);
      if (!this.episodes.some((e) => e.slug === this.episode)) this.episode = '';
      this.render();
      await this.loadDetails();
    });
  }

  private loadDetails(): Promise<void> {
    return this.guard(async () => {
      this.details = null;
      if (!this.podcast || !this.episode) return;
      this.details = await api().letscastEpisode(this.podcast, this.episode);
    });
  }

  private async signIn(): Promise<void> {
    this.signingIn = true;
    this.render();
    try {
      const ok = await api().letscastSignIn();
      this.info = await api().letscastStatus();
      if (ok) await this.loadPodcasts();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      this.signingIn = false;
      this.render();
    }
  }

  private async signOut(): Promise<void> {
    this.info = await api().letscastSignOut();
    this.podcasts = null;
    this.episodes = null;
    this.details = null;
    this.render();
  }

  /** A pasted episode link picks that podcast and episode, also one older than the list shows. */
  private async useLink(): Promise<void> {
    const link = parseEpisodeLink(this.linkDraft);
    if (!link) return toast('That is not a LetsCast.fm episode link', 'error');
    this.linkDraft = '';
    this.podcast = link.podcast;
    this.episode = link.episode;
    await this.guard(async () => {
      this.details = await api().letscastEpisode(link.podcast, link.episode);
      if (this.episodes && !this.episodes.some((e) => e.slug === link.episode)) {
        this.episodes = [{ slug: link.episode, title: this.details.title || link.episode, info: '' }, ...this.episodes];
      }
    });
  }

  private progress(p: ExportProgress): void {
    if (!this.busy) return;
    this.status = p.phase === 'Done' ? '' : `${p.phase}${p.fraction > 0 && p.fraction < 1 ? ` ${Math.round(p.fraction * 100)}%` : ''}`;
    const el = this.overlay.querySelector('.letscast-status');
    if (el) el.textContent = this.status;
  }

  private async upload(parts: LetsCastParts): Promise<void> {
    this.busy = true;
    this.result = null;
    this.error = '';
    this.status = parts.audio ? 'Rendering the MP3…' : 'Sending…';
    this.render();
    try {
      const r = await api().uploadToLetsCast(this.podcast, this.episode, parts);
      this.result = r.url;
      this.status = '';
      if (this.details && parts.audio) this.details = { ...this.details, hasAudio: true };
      toast(parts.audio ? 'Uploaded to LetsCast.fm' : 'Sent to LetsCast.fm');
    } catch (e) {
      this.status = '';
      this.error = errorMessage(e);
      if (/sign in to letscast/i.test(this.error) && this.info) this.info = { ...this.info, signedIn: false };
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private render(): void {
    keepScroll(this.overlay, () => this.build());
  }

  private build(): void {
    clear(this.overlay);
    const info = this.info;
    const signedIn = !!info?.signedIn;
    const account = signedIn
      ? h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Signed in to LetsCast.fm.'), h('button', { class: 'small', disabled: this.busy, onclick: () => void this.signOut() }, 'Sign out'))
      : h(
          'div',
          { class: 'row' },
          h('span', { class: 'muted' }, info ? 'Sign in on letscast.fm once. WavePod keeps the sign-in, never your password.' : 'Checking the sign-in…'),
          h('button', { class: 'small primary', disabled: !info || this.signingIn, onclick: () => void this.signIn() }, this.signingIn ? 'Waiting for sign-in…' : 'Sign in…'),
        );
    const podcastSel = h(
      'select',
      {
        class: 'letscast-podcast',
        disabled: !signedIn || this.busy || !this.podcasts,
        onchange: (e: Event) => {
          this.podcast = (e.target as HTMLSelectElement).value;
          this.episode = '';
          void this.loadEpisodes();
        },
      },
      ...(this.podcasts ?? []).map((p) => h('option', { value: p.slug, selected: p.slug === this.podcast }, p.title)),
    );
    const episodeSel = h(
      'select',
      {
        class: 'letscast-episode',
        disabled: !signedIn || this.busy || !this.episodes,
        onchange: (e: Event) => {
          this.episode = (e.target as HTMLSelectElement).value;
          void this.loadDetails();
        },
      },
      h('option', { value: '', selected: !this.episode }, this.episodes ? 'Choose an episode' : 'Loading…'),
      ...(this.episodes ?? []).map((e) => h('option', { value: e.slug, selected: e.slug === this.episode }, e.info ? `${e.title} · ${e.info}` : e.title)),
    );
    const linkRow = h(
      'div',
      { class: 'row' },
      h('input', {
        type: 'text',
        class: 'letscast-link',
        style: 'flex: 1; min-width: 0',
        placeholder: 'Or paste the episode link from letscast.fm',
        value: this.linkDraft,
        disabled: !signedIn || this.busy,
        oninput: (e: Event) => (this.linkDraft = (e.target as HTMLInputElement).value),
        onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && void this.useLink(),
      }),
      h('button', { class: 'small', disabled: !signedIn || this.busy || !this.linkDraft.trim(), onclick: () => void this.useLink() }, 'Use link'),
    );
    const s = store.project.exportSettings;
    const m = store.project.metadata;
    const hasAudio = store.project.tracks.some((t) => t.clips.length);
    const chapters = store.project.markers.filter((k) => k.kind === 'chapter');
    const what = `${s?.mp3Bitrate ?? 128} kbps${s?.mono ? ' mono' : ''}${s?.normalize === false ? '' : `, ${String(s?.targetLufs ?? -16).replace('-', '−')} LUFS`}`;
    const details = [m.title && `title "${m.title}"`, /^\d+$/.test(m.episode.trim()) && `number ${m.episode.trim()}`, m.author && `author ${m.author}`, m.description.trim() && 'description as the summary']
      .filter(Boolean)
      .join(', ');
    const notes = m.showNotes?.trim() ?? '';
    const part = (key: keyof LetsCastParts, label: string, note: string, available: boolean) =>
      h(
        'label',
        { class: 'check', title: available ? '' : 'Empty in WavePod, so nothing to send' },
        h('input', {
          type: 'checkbox',
          checked: available && this.parts[key],
          disabled: !available || this.busy,
          onchange: (e: Event) => {
            this.parts = { ...this.parts, [key]: (e.target as HTMLInputElement).checked };
            this.render();
          },
        }),
        h('span', null, label, h('span', { class: 'muted' }, ` · ${note}`)),
      );
    const chosen = (key: keyof LetsCastParts, available: boolean) => available && this.parts[key];
    const sends = {
      audio: chosen('audio', hasAudio),
      details: chosen('details', !!details),
      showNotes: chosen('showNotes', !!notes),
      chapters: chosen('chapters', chapters.length > 0),
      cover: chosen('cover', !!m.artwork),
    };
    const ready = signedIn && !!this.podcast && !!this.episode && !this.busy && Object.values(sends).some(Boolean);
    const dialog = h(
      'div',
      { class: 'dialog narrow letscast-dialog' },
      h('h2', null, 'Upload to LetsCast.fm'),
      h('p', { class: 'muted' }, 'Fills an episode you already created on letscast.fm. Only what you tick is sent; the publishing date and everything else there stay as they are.'),
      h('h3', null, 'Account'),
      account,
      h('h3', null, 'Podcast'),
      h('label', { class: 'field' }, podcastSel),
      h('h3', null, 'Episode'),
      h('label', { class: 'field' }, episodeSel),
      linkRow,
      h('h3', null, 'Send'),
      part('audio', 'Audio', hasAudio ? `MP3, ${what}, as set in File › Export` : 'no audio yet', hasAudio),
      part('details', 'Episode details', details || 'empty in the Chapters view', !!details),
      part('showNotes', 'Show notes', notes ? `${notes.length} characters` : 'empty in the Chapters view', !!notes),
      part('chapters', 'Chapters', chapters.length ? `${chapters.length}${chapters.some((k) => k.url || k.image) ? ' with their links and images' : ''}; they replace the chapters there` : 'no chapter markers', chapters.length > 0),
      part('cover', 'Episode cover', m.artwork ? 'the cover from the Chapters view' : 'no cover set', !!m.artwork),
      this.details?.hasAudio && sends.audio && !this.result ? h('p', { class: 'warning' }, `"${this.details.title || this.episode}" already has audio. Uploading replaces it.`) : null,
      this.error ? h('p', { class: 'warning' }, this.error) : null,
      this.result
        ? h('p', null, sends.audio ? 'Uploaded. LetsCast.fm now converts the audio. ' : 'Sent. ', h('a', { href: '#', onclick: (e: Event) => (e.preventDefault(), void api().openLetsCast(this.result!)) }, 'Open the episode on letscast.fm'))
        : null,
      h('div', { class: 'row' }, h('span', { class: 'letscast-status muted' }, this.status)),
      h(
        'div',
        { class: 'row end' },
        h('button', { disabled: this.busy, onclick: () => this.close() }, 'Close'),
        h('button', { class: 'primary', disabled: !ready, onclick: () => void this.upload({ ...this.parts, audio: sends.audio }) }, this.busy ? 'Uploading…' : 'Upload'),
      ),
    );
    this.overlay.append(dialog);
  }
}
