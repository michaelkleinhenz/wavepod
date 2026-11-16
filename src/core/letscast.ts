// LetsCast.fm hand-off: fills the episode with the same number on letscast.fm (or creates it) with
// WavePod's MP3, details, show notes and cover. LetsCast has no public API for episodes (its documented API only covers
// analytics), so this speaks the same requests as its web app, a Rails app with a session cookie:
//   - GET an edit page for the CSRF token,
//   - files: POST /media/direct_uploads with name, size and MD5 (Active Storage direct upload), PUT
//     the bytes to the pre-signed URL that comes back, then use the blob's signed id as the value,
//   - PATCH the form with only the fields that change; Rails leaves the others as they are:
//       episode form   …/episodes/<slug>          episode[audio|image|title|subtitle|summary|…]
//       show notes     …/episodes/<slug>/show_notes   episode[content]
//   - a new episode: POST …/episodes with the same fields (the publishing date is required).
// The main process supplies a fetch that carries the cookies of the LetsCast sign-in window.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LetsCastParts, Project } from '../shared/types';
import {
  LETSCAST_BASE,
  LetsCastSignedOut,
  isSignInPage,
  letscastDate,
  parseEpisodePage,
  parseEpisodes,
  parsePodcasts,
  parseShowNotes,
  textToHtml,
  type LetsCastEpisode,
  type LetsCastEpisodePage,
  type LetsCastPodcast,
} from './letscastPages';

export * from './letscastPages';

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface UploadProgress {
  phase: string;
  fraction: number;
}

/** What to change on the episode; anything left out stays as it is on letscast.fm. */
export interface LetsCastEpisodeUpdate {
  /** MP3 to become the episode's audio. */
  audioFile?: string;
  coverFile?: string;
  /** Episode form fields by name ("episode[title]" → value); only fields WavePod has a value for. */
  fields?: Array<[string, string]>;
  /** HTML (see textToHtml); only saved when the episode has no show notes yet. */
  showNotesHtml?: string;
}

const MIME: Record<string, string> = { '.mp3': 'audio/mpeg', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

export class LetsCastClient {
  /**
   * `fetchFn` must send and keep the LetsCast session cookie (in the app: the sign-in window's
   * session); `base` is only changed by tests.
   */
  constructor(
    private fetchFn: FetchFn,
    private base = LETSCAST_BASE,
  ) {}

  private async page(url: string): Promise<string> {
    const res = await this.fetchFn(`${this.base}${url}`, { headers: { Accept: 'text/html' } });
    const html = await res.text();
    if (isSignInPage(res.url, html) || res.status === 401) throw new LetsCastSignedOut();
    if (res.status === 404) throw new Error('LetsCast.fm could not find that page. Is the episode link right?');
    if (!res.ok) throw new Error(`LetsCast.fm: HTTP ${res.status}`);
    return html;
  }

  /** True when the session is signed in. */
  async signedIn(): Promise<boolean> {
    try {
      await this.page('/podcasts');
      return true;
    } catch (e) {
      if (e instanceof LetsCastSignedOut) return false;
      throw e;
    }
  }

  async podcasts(): Promise<LetsCastPodcast[]> {
    return parsePodcasts(await this.page('/podcasts'));
  }

  /** The newest episodes (LetsCast's first list page, or a later one). */
  async episodes(podcast: string, page = 1): Promise<LetsCastEpisode[]> {
    return parseEpisodes(await this.page(`/podcasts/${podcast}/episodes${page > 1 ? `?page=${page}` : ''}`), podcast);
  }

  /** The episode with this number, looking through the newest `pages` list pages; null if there is none. */
  async findByNumber(podcast: string, number: string, pages = 5): Promise<LetsCastEpisode | null> {
    for (let p = 1; p <= pages; p++) {
      const list = await this.episodes(podcast, p);
      const hit = list.find((e) => e.number === number);
      if (hit) return hit;
      if (list.length < 20) break;
    }
    return null;
  }

  async showNotes(podcast: string, episode: string): Promise<string> {
    return parseShowNotes(await this.page(`/podcasts/${podcast}/episodes/${episode}/show_notes/edit`));
  }

  async episode(podcast: string, episode: string): Promise<LetsCastEpisodePage> {
    return parseEpisodePage(await this.page(`/podcasts/${podcast}/episodes/${episode}/edit`));
  }

  /** Uploads a file to LetsCast's storage; returns the signed id a form field takes, and the blob id. */
  async uploadFile(csrf: string, file: string): Promise<{ signedId: string; id: string }> {
    const data = fs.readFileSync(file);
    const filename = path.basename(file);
    const res1 = await this.fetchFn(`${this.base}/media/direct_uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrf, 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({
        blob: { filename, content_type: MIME[path.extname(filename).toLowerCase()] ?? 'application/octet-stream', byte_size: data.length, checksum: createHash('md5').update(data).digest('base64') },
      }),
    });
    if (res1.status === 401 || res1.status === 422) throw new LetsCastSignedOut();
    if (!res1.ok) throw new Error(`LetsCast.fm did not accept ${filename} (HTTP ${res1.status}).`);
    const blob = (await res1.json()) as { id?: string | number; signed_id?: string; direct_upload?: { url?: string; headers?: Record<string, string> } };
    if (!blob.signed_id || !blob.direct_upload?.url) throw new Error('LetsCast.fm changed its upload; the upload needs an update of WavePod.');
    const res2 = await this.fetchFn(blob.direct_upload.url, { method: 'PUT', headers: blob.direct_upload.headers ?? {}, body: new Uint8Array(data) });
    if (!res2.ok) throw new Error(`Uploading ${filename} to LetsCast.fm failed (HTTP ${res2.status}).`);
    return { signedId: blob.signed_id, id: blob.id === undefined ? '' : String(blob.id) };
  }

  /** PATCHes one of the episode's forms with these fields. */
  private async patch(url: string, csrf: string, fields: Array<[string, string]>, what: string): Promise<void> {
    const form = new FormData();
    form.append('_method', 'patch');
    form.append('authenticity_token', csrf);
    for (const [k, v] of fields) form.append(k, v);
    const res = await this.fetchFn(`${this.base}${url}`, { method: 'POST', headers: { Accept: 'text/html' }, body: form });
    const html = await res.text();
    if (isSignInPage(res.url, html)) throw new LetsCastSignedOut();
    if (!res.ok) throw new Error(`LetsCast.fm did not save the ${what} (HTTP ${res.status}). Check the episode on letscast.fm.`);
  }

  /** Changes the episode as asked; returns the audio URL it plays afterwards. */
  async updateEpisode(podcast: string, episode: string, u: LetsCastEpisodeUpdate, progress: (p: UploadProgress) => void = () => {}): Promise<{ audio: string }> {
    const ep = `/podcasts/${podcast}/episodes/${episode}`;
    progress({ phase: 'Connecting to LetsCast.fm', fraction: 0 });
    const before = await this.episode(podcast, episode);
    if (!before.csrf) throw new Error('LetsCast.fm changed its page; the upload needs an update of WavePod.');
    const csrf = before.csrf;

    const { fields, audioBlob } = await this.formFields(csrf, u, progress);
    if (fields.length) {
      progress({ phase: 'Saving the episode', fraction: 0.8 });
      await this.patch(ep, csrf, fields, 'episode');
    }
    await this.saveShowNotes(podcast, episode, csrf, u, progress);

    const after = await this.episode(podcast, episode);
    if (audioBlob) {
      // Electron's fetch hides redirects, so whether it took is read from the edit page: the stored
      // audio file is the one just uploaded
      const took = after.audioBlobId
        ? audioBlob.id
          ? after.audioBlobId === audioBlob.id
          : after.audioBlobId !== before.audioBlobId
        : !before.audioBlobId && !!after.audio && after.audio !== before.audio;
      if (!took) throw new Error('LetsCast.fm took the file but the episode still has its old audio. Check the episode on letscast.fm.');
    }
    progress({ phase: 'Done', fraction: 1 });
    return { audio: after.audio };
  }

  /** Creates a new episode with this number (the fields must include a publishing date); returns its slug. */
  async createEpisode(podcast: string, number: string, u: LetsCastEpisodeUpdate, progress: (p: UploadProgress) => void = () => {}): Promise<string> {
    if (!u.fields?.some(([k]) => k === 'episode[publishing_date]')) throw new Error('Set a publishing date in the episode details: LetsCast.fm needs one for a new episode.');
    progress({ phase: 'Connecting to LetsCast.fm', fraction: 0 });
    const csrf = parseEpisodePage(await this.page(`/podcasts/${podcast}/episodes/new`)).csrf;
    if (!csrf) throw new Error('LetsCast.fm changed its page; the upload needs an update of WavePod.');
    const { fields } = await this.formFields(csrf, u, progress);
    progress({ phase: 'Creating the episode', fraction: 0.8 });
    const form = new FormData();
    form.append('authenticity_token', csrf);
    for (const [k, v] of fields) form.append(k, v);
    const res = await this.fetchFn(`${this.base}/podcasts/${podcast}/episodes`, { method: 'POST', headers: { Accept: 'text/html' }, body: form });
    const html = await res.text();
    if (isSignInPage(res.url, html)) throw new LetsCastSignedOut();
    const created = await this.findByNumber(podcast, number, 1);
    if (!res.ok || !created) throw new Error(`LetsCast.fm did not create the episode (HTTP ${res.status}). Check the title and publishing date, or create it on letscast.fm.`);
    await this.saveShowNotes(podcast, created.slug, csrf, u, progress);
    progress({ phase: 'Done', fraction: 1 });
    return created.slug;
  }

  /** Uploads the files and returns the episode form fields to send. */
  private async formFields(csrf: string, u: LetsCastEpisodeUpdate, progress: (p: UploadProgress) => void): Promise<{ fields: Array<[string, string]>; audioBlob: { signedId: string; id: string } | null }> {
    const fields: Array<[string, string]> = [];
    let audioBlob: { signedId: string; id: string } | null = null;
    if (u.audioFile) {
      progress({ phase: 'Uploading the MP3', fraction: 0.05 });
      audioBlob = await this.uploadFile(csrf, u.audioFile);
      fields.push(['episode[audio]', audioBlob.signedId]);
    }
    if (u.coverFile) {
      progress({ phase: 'Uploading the cover', fraction: 0.7 });
      fields.push(['episode[image]', (await this.uploadFile(csrf, u.coverFile)).signedId]);
    }
    fields.push(...(u.fields ?? []));
    return { fields, audioBlob };
  }

  /** Show notes are only written into an episode that has none yet. */
  private async saveShowNotes(podcast: string, episode: string, csrf: string, u: LetsCastEpisodeUpdate, progress: (p: UploadProgress) => void): Promise<void> {
    if (!u.showNotesHtml) return;
    if (await this.showNotes(podcast, episode)) return;
    progress({ phase: 'Saving the show notes', fraction: 0.9 });
    await this.patch(`/podcasts/${podcast}/episodes/${episode}/show_notes`, csrf, [['episode[content]', u.showNotesHtml]], 'show notes');
  }

  /** Uploads the MP3 and makes it the episode's audio; nothing else changes. */
  uploadAudio(podcast: string, episode: string, file: string, progress?: (p: UploadProgress) => void): Promise<{ audio: string }> {
    return this.updateEpisode(podcast, episode, { audioFile: file }, progress);
  }
}

/** What WavePod would send for these parts. Only fields with a value in WavePod are sent, so nothing on letscast.fm is cleared. */
export function letscastUpdate(project: Project, projectDir: string, parts: LetsCastParts): Omit<LetsCastEpisodeUpdate, 'audioFile'> {
  const m = project.metadata;
  const file = (rel?: string) => (rel && fs.existsSync(path.join(projectDir, rel)) ? path.join(projectDir, rel) : undefined);
  const u: Omit<LetsCastEpisodeUpdate, 'audioFile'> = {};
  if (parts.details) {
    const f: Array<[string, string]> = [];
    const set = (name: string, v: string | undefined) => {
      if (v !== undefined && v.trim()) f.push([`episode[${name}]`, v.trim()]);
    };
    const flag = (name: string, v: boolean | undefined) => {
      if (v !== undefined) f.push([`episode[${name}]`, v ? '1' : '0']);
    };
    set('title', m.title);
    set('subtitle', m.subtitle);
    set('publishing_date', m.publishDate ? letscastDate(m.publishDate) : undefined);
    set('episode_type', m.episodeType);
    if (/^\d+$/.test(m.episode.trim())) set('number', m.episode);
    set('author', m.author);
    set('keywords', m.keywords);
    if (m.description.trim()) f.push(['episode[summary]', textToHtml(m.description)]);
    set('custom_site_url', m.siteUrl);
    set('youtube_id', m.youtubeId);
    flag('has_explicit_content', m.explicit);
    flag('hidden', m.hidden);
    flag('hide_on_platforms', m.hideOnPlatforms);
    if (f.length) u.fields = f;
  }
  if (parts.showNotes && m.showNotes?.trim()) u.showNotesHtml = textToHtml(m.showNotes);
  if (parts.cover && file(m.artwork)) u.coverFile = file(m.artwork);
  return u;
}
