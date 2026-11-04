// Main-process side of the Auphonic hand-off: the API key (encrypted with the OS keychain where
// available), and the job that renders stems, creates the production and uploads everything.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeStorage } from 'electron';
import type { AuphonicInfo, AuphonicSettingsInput, ExportOptions, ExportProgress, ExportResult, Project } from '../shared/types';
import { AuphonicClient, productionRequest, productionUrl, trackIds, type AuphonicPreset, type AuphonicTrack } from '../core/auphonic';
import { safeName } from '../core/exporter';

/** As stored in the app settings. */
export interface StoredAuphonic {
  /** "enc:<base64>" (OS-encrypted) or the plain key where the OS offers no encryption. */
  key: string;
  preset: string;
  start: boolean;
}

export function normalizeAuphonic(raw: unknown): StoredAuphonic {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<StoredAuphonic>;
  return { key: typeof r.key === 'string' ? r.key : '', preset: typeof r.preset === 'string' ? r.preset : '', start: r.start === true };
}

export function decodeKey(stored: string): string {
  if (!stored.startsWith('enc:')) return stored;
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
  } catch {
    return '';
  }
}

export function encodeKey(key: string): string {
  if (!key) return '';
  return safeStorage.isEncryptionAvailable() ? `enc:${safeStorage.encryptString(key).toString('base64')}` : key;
}

export function auphonicInfo(s: StoredAuphonic): AuphonicInfo {
  return { hasKey: !!decodeKey(s.key), preset: s.preset, start: s.start };
}

export function updateAuphonic(s: StoredAuphonic, input: AuphonicSettingsInput): StoredAuphonic {
  return {
    key: input.apiKey === undefined ? s.key : encodeKey(input.apiKey.trim()),
    preset: input.preset ?? s.preset,
    start: input.start ?? s.start,
  };
}

export function auphonicClient(s: StoredAuphonic): AuphonicClient {
  const key = decodeKey(s.key);
  if (!key) throw new Error('Enter your Auphonic API key first (auphonic.com → Account Settings → API Key).');
  // tests point it at a local mock server
  return new AuphonicClient(key, process.env.WAVEPOD_AUPHONIC_BASE || undefined);
}

export async function auphonicPresets(s: StoredAuphonic): Promise<AuphonicPreset[]> {
  return (await auphonicClient(s).presets()).filter((p) => p.multitrack);
}

/**
 * Renders one FLAC stem per track with audio into `<projectDir>/auphonic/`, creates a multitrack
 * production with chapters, metadata and cover, uploads it all and (optionally) starts it.
 */
export async function sendToAuphonic(
  s: StoredAuphonic,
  project: Project,
  projectDir: string,
  renderStems: (opts: ExportOptions) => Promise<ExportResult>,
  progress: (p: ExportProgress) => void,
): Promise<{ uuid: string; url: string; started: boolean }> {
  const client = auphonicClient(s);
  const tracks = project.tracks.filter((t) => t.clips.length > 0);
  if (!tracks.length) throw new Error('There is no audio to send yet.');
  const dir = path.join(projectDir, 'auphonic');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  try {
    const base = path.join(dir, safeName(project.metadata.title || project.name));
    const res = await renderStems({ outputBase: base, formats: [], mp3Bitrate: 128, normalize: false, targetLufs: -16, peakCeiling: -1, stems: true, stemFormat: 'flac', chapterFiles: false });
    const files = res.files.filter((f) => f.endsWith('.flac'));
    if (files.length !== tracks.length) throw new Error('Rendering the tracks failed.');
    const ids = trackIds(tracks.map((t) => t.name));
    const list: AuphonicTrack[] = tracks.map((t, i) => ({ id: ids[i], title: t.name, file: files[i] }));
    progress({ phase: 'Creating the Auphonic production', fraction: 0 });
    const uuid = await client.createProduction(productionRequest(project, list, s.preset || undefined));
    const cover = project.metadata.artwork ? path.join(projectDir, project.metadata.artwork) : null;
    const uploads = [...list.map((t) => ({ field: t.id, file: t.file, label: t.title })), ...(cover && fs.existsSync(cover) ? [{ field: 'image', file: cover, label: 'cover' }] : [])];
    for (const [i, u] of uploads.entries()) {
      progress({ phase: `Uploading ${u.label}`, fraction: i / uploads.length });
      await client.upload(uuid, u.field, u.file);
    }
    if (s.start) {
      progress({ phase: 'Starting the production', fraction: 1 });
      await client.start(uuid);
    }
    progress({ phase: 'Done', fraction: 1 });
    return { uuid, url: productionUrl(uuid), started: s.start };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
