// LetsCast.fm hand-off: puts an exported MP3 into an existing episode. LetsCast has no public
// API for episodes (its documented API only covers analytics), so this speaks the same requests as
// its web app, which is a Rails app with a session cookie:
//   1. GET the episode's edit page for the CSRF token (and to see whether it has audio yet),
//   2. POST /media/direct_uploads with the file's name, size and MD5 (Active Storage direct upload),
//   3. PUT the file to the pre-signed storage URL that comes back,
//   4. PATCH the episode with only episode[audio] = the blob's signed id; nothing else changes.
// Pure parsing plus a small client with an injected fetch; the main process supplies a fetch that
// carries the cookies of the LetsCast sign-in window.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LETSCAST_BASE, LetsCastSignedOut, isSignInPage, parseEpisodePage, parseEpisodes, parsePodcasts, type LetsCastEpisode, type LetsCastEpisodePage, type LetsCastPodcast } from './letscastPages';

export * from './letscastPages';

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface UploadProgress {
  phase: string;
  fraction: number;
}

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

  /** Uploads the file and makes it the episode's audio. Returns the audio URL LetsCast then shows. */
  async uploadAudio(podcast: string, episode: string, file: string, progress: (p: UploadProgress) => void = () => {}): Promise<{ audio: string }> {
    progress({ phase: 'Connecting to LetsCast.fm', fraction: 0 });
    const before = await this.episode(podcast, episode);
    if (!before.csrf) throw new Error('LetsCast.fm changed its page; the upload needs an update of WavePod.');
    const data = fs.readFileSync(file);
    const checksum = createHash('md5').update(data).digest('base64');
    const filename = path.basename(file);
    const contentType = /\.mp3$/i.test(filename) ? 'audio/mpeg' : 'application/octet-stream';

    const res1 = await this.fetchFn(`${this.base}/media/direct_uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': before.csrf, 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ blob: { filename, content_type: contentType, byte_size: data.length, checksum } }),
    });
    if (res1.status === 401 || res1.status === 422) throw new LetsCastSignedOut();
    if (!res1.ok) throw new Error(`LetsCast.fm did not accept the upload (HTTP ${res1.status}).`);
    const blob = (await res1.json()) as { id?: string | number; signed_id?: string; direct_upload?: { url?: string; headers?: Record<string, string> } };
    if (!blob.signed_id || !blob.direct_upload?.url) throw new Error('LetsCast.fm changed its upload; the upload needs an update of WavePod.');

    progress({ phase: 'Uploading the MP3', fraction: 0.05 });
    const res2 = await this.fetchFn(blob.direct_upload.url, { method: 'PUT', headers: blob.direct_upload.headers ?? {}, body: new Uint8Array(data) });
    if (!res2.ok) throw new Error(`Uploading the MP3 to LetsCast.fm failed (HTTP ${res2.status}).`);

    progress({ phase: 'Attaching it to the episode', fraction: 0.95 });
    const form = new FormData();
    form.append('_method', 'patch');
    form.append('authenticity_token', before.csrf);
    form.append('episode[audio]', blob.signed_id);
    const res3 = await this.fetchFn(`${this.base}/podcasts/${podcast}/episodes/${episode}`, { method: 'POST', headers: { Accept: 'text/html' }, body: form });
    const html3 = await res3.text();
    if (isSignInPage(res3.url, html3)) throw new LetsCastSignedOut();
    // Electron's fetch hides redirects, so whether it took is read from the edit page: the stored
    // audio file is a new one now
    if (!res3.ok) throw new Error(`LetsCast.fm did not save the episode (HTTP ${res3.status}). Check it on letscast.fm.`);
    const after = await this.episode(podcast, episode);
    const changed = after.audioBlobId
      ? blob.id !== undefined
        ? after.audioBlobId === String(blob.id)
        : after.audioBlobId !== before.audioBlobId
      : !before.audioBlobId && !!after.audio && after.audio !== before.audio;
    if (!changed) throw new Error('LetsCast.fm took the file but the episode still has its old audio. Check the episode on letscast.fm.');
    progress({ phase: 'Done', fraction: 1 });
    return { audio: after.audio };
  }
}
