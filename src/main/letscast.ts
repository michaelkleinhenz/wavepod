// Main-process side of the LetsCast.fm hand-off. The user signs in on letscast.fm's own page in a
// WavePod window; its cookies live in a separate persistent session and are only sent to
// letscast.fm. WavePod never sees or stores the password.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BrowserWindow, session, shell } from 'electron';
import type { ExportOptions, ExportProgress, ExportResult, LetsCastInfo, LetsCastParts, Project } from '../shared/types';
import { LETSCAST_BASE, LetsCastClient, editUrl, letscastUpdate, type LetsCastEpisodeUpdate } from '../core/letscast';
import { DEFAULT_EXPORT_SETTINGS } from '../core/exportSettings';
import { safeName } from '../core/exporter';

const PARTITION = 'persist:letscast';

/** As stored in the app settings: where the last upload went, to preselect it. */
export interface StoredLetsCast {
  podcast: string;
  episode: string;
  parts: LetsCastParts;
}

export const DEFAULT_LETSCAST_PARTS: LetsCastParts = { audio: true, details: true, showNotes: true, cover: true };

export function normalizeLetsCast(raw: unknown): StoredLetsCast {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<StoredLetsCast>;
  const slug = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(v) ? v : '');
  const p = (r.parts && typeof r.parts === 'object' ? r.parts : {}) as Partial<LetsCastParts>;
  const parts = Object.fromEntries(Object.entries(DEFAULT_LETSCAST_PARTS).map(([k, d]) => [k, typeof p[k as keyof LetsCastParts] === 'boolean' ? p[k as keyof LetsCastParts] : d])) as unknown as LetsCastParts;
  return { podcast: slug(r.podcast), episode: slug(r.episode), parts };
}

/** Tests point it at a local mock server. */
const base = () => process.env.WAVEPOD_LETSCAST_BASE || LETSCAST_BASE;

let uaSet = false;

function letscastSession(): Electron.Session {
  const ses = session.fromPartition(PARTITION);
  if (!uaSet) {
    // look like the Chrome it is, without the app and Electron tokens
    ses.setUserAgent(ses.getUserAgent().replace(/\s(?:WavePod|wavepod|Electron)\/\S+/g, ''));
    uaSet = true;
  }
  return ses;
}

export function letscastClient(): LetsCastClient {
  const ses = letscastSession();
  return new LetsCastClient((url, init) => ses.fetch(url, { ...init, credentials: 'include' } as RequestInit), base());
}

export async function letscastInfo(s: StoredLetsCast): Promise<LetsCastInfo> {
  let signedIn = false;
  try {
    signedIn = await letscastClient().signedIn();
  } catch {
    // offline: shown as signed out; signing in tells the user more
  }
  return { signedIn, podcast: s.podcast, episode: s.episode, parts: s.parts };
}

let signInWindow: BrowserWindow | null = null;

/** Shows letscast.fm's sign-in page; true once the user is signed in, false if they close the window first. */
export function letscastSignIn(parent: BrowserWindow | null): Promise<boolean> {
  if (signInWindow && !signInWindow.isDestroyed()) {
    signInWindow.focus();
    return new Promise((resolve) => signInWindow!.once('closed', () => void letscastClient().signedIn().then(resolve, () => resolve(false))));
  }
  const win = new BrowserWindow({
    width: 960,
    height: 780,
    title: 'Sign in to LetsCast.fm',
    autoHideMenuBar: true,
    ...(parent ? { parent } : {}),
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  signInWindow = win;
  // links that open new windows (help, legal pages) go to the browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      resolve(ok);
      if (!win.isDestroyed()) win.close();
    };
    win.webContents.on('did-navigate', (_e, url) => {
      // after signing in, letscast.fm leaves /users/… for the dashboard
      if (url.startsWith(base()) && !new URL(url).pathname.startsWith('/users')) {
        void letscastClient()
          .signedIn()
          .then((ok) => ok && finish(true), () => {});
      }
    });
    win.once('closed', () => {
      signInWindow = null;
      if (!done) void letscastClient().signedIn().then((ok) => finish(ok), () => finish(false));
    });
    void win.loadURL(`${base()}/users/sign_in`);
  });
}

export async function letscastSignOut(): Promise<void> {
  await letscastSession().clearStorageData();
}

/**
 * Sends the chosen parts to the episode `episode` (a slug), or, with episode '', creates a new one
 * with WavePod's episode number. The MP3 is rendered (with the episode's export settings) into a
 * temporary folder. Returns the edit page of the episode.
 */
export async function uploadToLetsCast(
  project: Project,
  projectDir: string,
  podcast: string,
  episode: string,
  parts: LetsCastParts,
  render: (opts: ExportOptions) => Promise<ExportResult>,
  progress: (p: ExportProgress) => void,
): Promise<{ url: string; episode: string }> {
  if (parts.audio && !project.tracks.some((t) => t.clips.length)) throw new Error('There is no audio to upload yet.');
  const update: LetsCastEpisodeUpdate = letscastUpdate(project, projectDir, parts);
  if (!parts.audio && !Object.keys(update).length) throw new Error('There is nothing to send: the chosen parts are empty in WavePod.');
  const number = project.metadata.episode.trim();
  if (!episode && !/^\d+$/.test(number)) throw new Error('Set the episode number in the episode details first: WavePod finds or creates the LetsCast episode by its number.');
  const client = letscastClient();
  // fail early (before rendering) when signed out or the episode is gone
  if (episode) await client.episode(podcast, episode);
  else if (await client.findByNumber(podcast, number)) throw new Error(`Episode ${number} already exists on LetsCast.fm. Pick it in the list.`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavepod-letscast-'));
  try {
    if (parts.audio) {
      const s = project.exportSettings ?? DEFAULT_EXPORT_SETTINGS;
      const res = await render({
        ...s,
        outputBase: path.join(dir, safeName(project.metadata.title || project.name)),
        formats: ['mp3'],
        stems: false,
        chapterFiles: false,
        video: undefined,
      });
      update.audioFile = res.files.find((f) => f.toLowerCase().endsWith('.mp3'));
      if (!update.audioFile) throw new Error('Rendering the MP3 failed.');
    }
    const report = (p: { phase: string; fraction: number }) => progress({ phase: p.phase, fraction: p.fraction });
    let slug = episode;
    if (slug) await client.updateEpisode(podcast, slug, update, report);
    else slug = await client.createEpisode(podcast, number, update, report);
    return { url: editUrl(podcast, slug, base()), episode: slug };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
