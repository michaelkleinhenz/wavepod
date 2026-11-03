// Auphonic hand-off: creates a multitrack production from the episode's stems, chapters, metadata
// and cover (https://auphonic.com/help/api/). Pure request building plus a small fetch client; the
// main process renders the stems and drives it.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Project } from '../shared/types';
import { markersToChapters } from './project';
import { formatTimestamp } from '../shared/time';

export const AUPHONIC_BASE = 'https://auphonic.com';

export interface AuphonicTrack {
  /** Auphonic track id; also the upload field name. */
  id: string;
  title: string;
  file: string;
}

export interface AuphonicPreset {
  uuid: string;
  name: string;
  multitrack: boolean;
}

/** Unique ids Auphonic accepts (letters, digits, - and _), from the track names. */
export function trackIds(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((n, i) => {
    const base = n.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase() || `track${i + 1}`;
    let id = base;
    for (let k = 2; used.has(id); k++) id = `${base}_${k}`;
    used.add(id);
    return id;
  });
}

/** The JSON body that creates the production. */
export function productionRequest(project: Project, tracks: AuphonicTrack[], preset?: string): Record<string, unknown> {
  const m = project.metadata;
  const meta: Record<string, string> = {};
  const set = (k: string, v?: string) => {
    if (v && v.trim()) meta[k] = v.trim();
  };
  set('title', m.title || project.name);
  set('artist', m.author);
  set('album', m.podcast);
  set('track', m.episode);
  set('year', m.year);
  set('summary', m.description);
  set('genre', m.category || 'Podcast');
  return {
    ...(preset ? { preset } : {}),
    is_multitrack: true,
    metadata: meta,
    multi_input_files: tracks.map((t) => ({ type: 'multitrack', id: t.id })),
    chapters: markersToChapters(project).map((c) => ({ start: formatTimestamp(c.start), title: c.title, ...(c.url ? { url: c.url } : {}) })),
  };
}

type FetchFn = typeof fetch;

export class AuphonicClient {
  constructor(
    private apiKey: string,
    private base = AUPHONIC_BASE,
    private fetchFn: FetchFn = fetch,
  ) {}

  private async call<T>(method: string, url: string, body?: BodyInit, json = false): Promise<T> {
    const res = await this.fetchFn(`${this.base}${url}`, {
      method,
      headers: { Authorization: `bearer ${this.apiKey}`, ...(json ? { 'Content-Type': 'application/json' } : {}) },
      body,
    });
    const text = await res.text();
    let data: { data?: T; error_message?: string; message?: string } = {};
    try {
      data = JSON.parse(text);
    } catch {
      // not JSON (proxy error page and the like)
    }
    if (res.status === 401 || res.status === 403) throw new Error('Auphonic did not accept the API key. Check it under Account Settings on auphonic.com.');
    if (!res.ok) throw new Error(`Auphonic: ${data.error_message || data.message || `HTTP ${res.status}`}`);
    return data.data as T;
  }

  async presets(): Promise<AuphonicPreset[]> {
    const list = await this.call<Array<{ uuid: string; preset_name: string; is_multitrack?: boolean }>>('GET', '/api/presets.json');
    return (list ?? []).map((p) => ({ uuid: p.uuid, name: p.preset_name, multitrack: !!p.is_multitrack }));
  }

  async createProduction(body: Record<string, unknown>): Promise<string> {
    const data = await this.call<{ uuid: string }>('POST', '/api/productions.json', JSON.stringify(body), true);
    if (!data?.uuid) throw new Error('Auphonic did not return a production id.');
    return data.uuid;
  }

  /** Uploads one file into the production's field (a multitrack id, or "image" for the cover). */
  async upload(uuid: string, field: string, file: string): Promise<void> {
    const form = new FormData();
    form.append(field, await fs.openAsBlob(file), path.basename(file));
    await this.call('POST', `/api/production/${uuid}/upload.json`, form);
  }

  async start(uuid: string): Promise<void> {
    await this.call('POST', `/api/production/${uuid}/start.json`);
  }
}

/** Where the user sees the production in the browser. */
export function productionUrl(uuid: string, base = AUPHONIC_BASE): string {
  return `${base}/engine/multitrack/edit/${uuid}`;
}
