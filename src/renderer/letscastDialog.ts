// File › Upload to LetsCast.fm…: sign in on letscast.fm, pick the podcast and an existing episode,
// and make the rendered MP3 that episode's audio. Nothing else on the episode changes.
import type { ExportProgress, LetsCastEpisodeDetails, LetsCastEpisodeInfo, LetsCastInfo, LetsCastPodcastInfo } from '../shared/types';
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
    if (!store.project.tracks.some((t) => t.clips.length)) return toast('There is no audio to upload yet');
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

  private async upload(): Promise<void> {
    this.busy = true;
    this.result = null;
    this.status = 'Rendering the MP3…';
    this.render();
    try {
      const r = await api().uploadToLetsCast(this.podcast, this.episode);
      this.result = r.url;
      this.status = '';
      if (this.details) this.details = { ...this.details, hasAudio: true };
      toast('Uploaded to LetsCast.fm');
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
    const what = `${s?.mp3Bitrate ?? 128} kbps${s?.mono ? ' mono' : ''}${s?.normalize === false ? '' : `, ${String(s?.targetLufs ?? -16).replace('-', '−')} LUFS`}`;
    const ready = signedIn && !!this.podcast && !!this.episode && !this.busy;
    const dialog = h(
      'div',
      { class: 'dialog narrow letscast-dialog' },
      h('h2', null, 'Upload to LetsCast.fm'),
      h('p', { class: 'muted' }, `Renders the episode as MP3 (${what}, with chapters and cover, as set in File › Export) and makes it the audio of an episode you already created on letscast.fm. Title, show notes and publishing date stay as they are there.`),
      h('h3', null, 'Account'),
      account,
      h('h3', null, 'Podcast'),
      h('label', { class: 'field' }, podcastSel),
      h('h3', null, 'Episode'),
      h('label', { class: 'field' }, episodeSel),
      linkRow,
      this.details?.hasAudio && !this.result ? h('p', { class: 'warning' }, `"${this.details.title || this.episode}" already has audio. Uploading replaces it.`) : null,
      this.error ? h('p', { class: 'warning' }, this.error) : null,
      this.result
        ? h('p', null, 'Uploaded. LetsCast.fm now converts it. ', h('a', { href: '#', onclick: (e: Event) => (e.preventDefault(), void api().openLetsCast(this.result!)) }, 'Open the episode on letscast.fm'))
        : null,
      h('div', { class: 'row' }, h('span', { class: 'letscast-status muted' }, this.status)),
      h(
        'div',
        { class: 'row end' },
        h('button', { disabled: this.busy, onclick: () => this.close() }, 'Close'),
        h('button', { class: 'primary', disabled: !ready, onclick: () => void this.upload() }, this.busy ? 'Uploading…' : this.details?.hasAudio ? 'Replace audio' : 'Upload'),
      ),
    );
    this.overlay.append(dialog);
  }
}
