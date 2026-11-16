// LetsCast.fm hand-off: fills an existing episode on letscast.fm with WavePod's MP3, details, show
// notes, chapters and cover. LetsCast has no public API for episodes (its documented API only covers
// analytics), so this speaks the same requests as its web app, a Rails app with a session cookie:
//   - GET an edit page for the CSRF token,
//   - files: POST /media/direct_uploads with name, size and MD5 (Active Storage direct upload), PUT
//     the bytes to the pre-signed URL that comes back, then use the blob's signed id as the value,
//   - PATCH the form with only the fields that change; Rails leaves the others as they are:
//       episode form   …/episodes/<slug>          episode[audio|image|title|number|author|summary]
//       show notes     …/episodes/<slug>/show_notes   episode[content]
//       chapters       …/episodes/<slug>/chapters     episode[chapters_attributes][i][…] (nested:
//                      old ones by id with _destroy=1, new ones with start, title, href, picture).
// The main process supplies a fetch that carries the cookies of the LetsCast sign-in window.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LetsCastParts, Project } from '../shared/types';
import { markersToChapters } from './project';
import {
  LETSCAST_BASE,
  LetsCastSignedOut,
  chapterStart,
  isSignInPage,
  parseChapterIds,
  parseEpisodePage,
  parseEpisodes,
  parsePodcasts,
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
  title?: string;
  /** Only digits; LetsCast's number field takes a number. */
  number?: string;
  author?: string;
  /** HTML (see textToHtml). */
  summaryHtml?: string;
  showNotesHtml?: string;
  /** Replaces all chapters. */
  chapters?: Array<{ start: number; title: string; url?: string; imageFile?: string }>;
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

  /** The newest episodes (LetsCast's first list page). */
  async episodes(podcast: string): Promise<LetsCastEpisode[]> {
    return parseEpisodes(await this.page(`/podcasts/${podcast}/episodes`), podcast);
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

    // the episode form: audio, cover and details in one go
    const fields: Array<[string, string]> = [];
    let audioBlob: { signedId: string; id: string } | null = null;
    if (u.audioFile) {
      progress({ phase: 'Uploading the MP3', fraction: 0.05 });
      audioBlob = await this.uploadFile(csrf, u.audioFile);
      fields.push(['episode[audio]', audioBlob.signedId]);
    }
    if (u.coverFile) {
      progress({ phase: 'Uploading the cover', fraction: 0.6 });
      fields.push(['episode[image]', (await this.uploadFile(csrf, u.coverFile)).signedId]);
    }
    if (u.title) fields.push(['episode[title]', u.title]);
    if (u.number && /^\d+$/.test(u.number)) fields.push(['episode[number]', u.number]);
    if (u.author) fields.push(['episode[author]', u.author]);
    if (u.summaryHtml) fields.push(['episode[summary]', u.summaryHtml]);
    if (fields.length) {
      progress({ phase: 'Saving the episode', fraction: 0.7 });
      await this.patch(ep, csrf, fields, 'episode');
    }

    if (u.showNotesHtml) {
      progress({ phase: 'Saving the show notes', fraction: 0.75 });
      await this.patch(`${ep}/show_notes`, csrf, [['episode[content]', u.showNotesHtml]], 'show notes');
    }

    if (u.chapters) {
      progress({ phase: 'Saving the chapters', fraction: 0.8 });
      const old = parseChapterIds(await this.page(`${ep}/chapters/edit`));
      const ch: Array<[string, string]> = [];
      old.forEach((id, i) => ch.push([`episode[chapters_attributes][${i}][id]`, id], [`episode[chapters_attributes][${i}][_destroy]`, '1']));
      for (const [k, c] of u.chapters.entries()) {
        const i = old.length + k;
        ch.push([`episode[chapters_attributes][${i}][start]`, chapterStart(c.start)], [`episode[chapters_attributes][${i}][title]`, c.title], [`episode[chapters_attributes][${i}][href]`, c.url ?? '']);
        if (c.imageFile) ch.push([`episode[chapters_attributes][${i}][picture]`, (await this.uploadFile(csrf, c.imageFile)).signedId]);
      }
      if (ch.length) await this.patch(`${ep}/chapters`, csrf, ch, 'chapters');
    }

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

  /** Uploads the MP3 and makes it the episode's audio; nothing else changes. */
  uploadAudio(podcast: string, episode: string, file: string, progress?: (p: UploadProgress) => void): Promise<{ audio: string }> {
    return this.updateEpisode(podcast, episode, { audioFile: file }, progress);
  }
}

/** What WavePod would send for these parts; empty values are left out so they don't clear anything on letscast.fm. */
export function letscastUpdate(project: Project, projectDir: string, parts: LetsCastParts): Omit<LetsCastEpisodeUpdate, 'audioFile'> {
  const m = project.metadata;
  const file = (rel?: string) => (rel && fs.existsSync(path.join(projectDir, rel)) ? path.join(projectDir, rel) : undefined);
  const u: Omit<LetsCastEpisodeUpdate, 'audioFile'> = {};
  if (parts.details) {
    if (m.title.trim()) u.title = m.title.trim();
    if (m.episode.trim()) u.number = m.episode.trim();
    if (m.author.trim()) u.author = m.author.trim();
    if (m.description.trim()) u.summaryHtml = textToHtml(m.description);
  }
  if (parts.showNotes && m.showNotes?.trim()) u.showNotesHtml = textToHtml(m.showNotes);
  if (parts.cover && file(m.artwork)) u.coverFile = file(m.artwork);
  if (parts.chapters) {
    const chapters = markersToChapters(project).map((c) => ({ start: c.start, title: c.title, ...(c.url ? { url: c.url } : {}), ...(file(c.image) ? { imageFile: file(c.image) } : {}) }));
    if (chapters.length) u.chapters = chapters;
  }
  return u;
}
