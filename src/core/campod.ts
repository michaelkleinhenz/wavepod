// CamPod: the multi-camera recorder (a Linux box with USB cameras, run as a service with a web page
// and an HTTP API). WavePod starts and stops its camera recording together with the sound, and
// downloads a recording's camera files into the episode as cameras.
//
// Pure apart from the injected fetch, so the tests run it against a mock server.
import type { CamPodCameraInfo, CamPodLink, CamPodSessionInfo, CamPodStatus, Frames, Project } from '../shared/types';

export type FetchFn = typeof fetch;

/** CamPod listens here unless its config says otherwise. */
export const CAMPOD_DEFAULT_PORT = 8080;

/** As stored in the app settings. */
export interface StoredCamPod {
  /** http://host:port ('' = not set up). */
  url: string;
  /** CamPod API key ("enc:<base64>" where the OS can encrypt, like the other keys; '' = none). */
  token: string;
  /** Start and stop the cameras with WavePod's recording. */
  followRecording: boolean;
}

export function normalizeCamPodSettings(raw: unknown): StoredCamPod {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<StoredCamPod>;
  let url = '';
  try {
    url = typeof r.url === 'string' ? normalizeCamPodUrl(r.url) : '';
  } catch {
    url = '';
  }
  return { url, token: typeof r.token === 'string' ? r.token : '', followRecording: r.followRecording !== false };
}

/**
 * The server address as typed ("studio-pc", "192.168.1.20:8080", "http://campod.local/") as a base
 * URL: http:// when no scheme is given, CamPod's port 8080 when neither scheme nor port is, no path.
 */
export function normalizeCamPodUrl(input: string): string {
  const s = input.trim();
  if (!s) return '';
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  if (hasScheme && !/^https?:\/\//i.test(s)) throw new Error('The CamPod address starts with http:// or https://.');
  let u: URL;
  try {
    u = new URL(hasScheme ? s : `http://${s}`);
  } catch {
    throw new Error(`“${s}” is not a server address. Type the CamPod computer’s name or IP address, e.g. 192.168.1.20.`);
  }
  if (!u.hostname) throw new Error('Type the CamPod computer’s name or IP address.');
  if (!hasScheme && !u.port) u.port = String(CAMPOD_DEFAULT_PORT);
  return `${u.protocol}//${u.host}`;
}

// ---------------------------------------------------------------- CamPod's wire format

/** A camera in CamPod's /api/status (only what WavePod reads). */
interface WireCamera {
  id: string;
  name: string;
  model?: string;
  present?: boolean;
  state?: string;
  error?: string;
  choice?: { fourcc?: string; width?: number; height?: number; fps?: number } | null;
  codec?: string;
  hasAudio?: boolean;
  settings?: { enabled?: boolean; videoCodec?: string; useAudio?: boolean; fourcc?: string };
}

interface WireStatus {
  version?: string;
  recording?: { name: string; title?: string; startedAt?: string } | null;
  disk?: { remaining?: number; warning?: string };
  cameras?: WireCamera[] | null;
}

interface WireSummary {
  name: string;
  title?: string;
  startedAt?: string;
  /** Go time.Duration: nanoseconds. */
  duration?: number;
  bytes?: number;
  files?: number;
  active?: boolean;
}

/** session.json of a recording. */
export interface WireSession {
  name: string;
  title?: string;
  startedAt?: string;
  stoppedAt?: string | null;
  cameras?: Array<{
    id: string;
    name: string;
    model?: string;
    files?: string[] | null;
    choice?: { fourcc?: string; width?: number; height?: number; fps?: number } | null;
    codec?: string;
    hasAudio?: boolean;
    startError?: string;
  }> | null;
}

/**
 * Why WavePod can't use what a camera records, or null. WavePod decodes video with the system's
 * decoders (H.264, HEVC, VP9, AV1), which have no MJPEG; CamPod keeps a camera's MJPEG stream
 * unchanged unless the camera is set to H.264.
 */
export function cameraProblem(c: { fourcc?: string; codec?: string; hasAudio?: boolean }): string | null {
  const fourcc = (c.fourcc ?? '').toUpperCase();
  if (fourcc === 'MJPG' && (c.codec ?? 'copy') === 'copy') return 'Records MJPEG, which WavePod can’t decode. Set it to H.264.';
  if (c.hasAudio === false) return 'Records no sound, so WavePod can’t sync it. Give it a microphone in CamPod.';
  return null;
}

function cameraInfo(c: WireCamera): CamPodCameraInfo {
  // before a camera has started, its settings say what it will record
  const fourcc = c.choice?.fourcc ?? c.settings?.fourcc ?? '';
  const codec = c.codec || c.settings?.videoCodec || '';
  const hasAudio = c.present === false ? undefined : c.settings?.useAudio === false ? false : c.hasAudio;
  return {
    id: c.id,
    name: c.name || c.model || c.id,
    present: c.present !== false,
    enabled: c.settings?.enabled !== false,
    state: c.state ?? '',
    ...(c.error ? { error: c.error } : {}),
    format: [codec === 'h264' && fourcc.toUpperCase() !== 'H264' ? `H.264 (from ${fourcc || 'camera'})` : fourcc, c.choice?.width && c.choice?.height ? `${c.choice.width}×${c.choice.height}` : '', c.choice?.fps ? `${c.choice.fps} fps` : ''].filter(Boolean).join(' '),
    canSwitchToH264: fourcc.toUpperCase() === 'MJPG' && (codec || 'copy') === 'copy',
    problem: c.present === false || c.settings?.enabled === false ? null : cameraProblem({ fourcc, codec: codec || 'copy', hasAudio }),
  };
}

export function statusFromWire(w: WireStatus): CamPodStatus {
  return {
    version: w.version ?? '',
    recording: w.recording ? { name: w.recording.name, title: w.recording.title ?? '', startedAt: w.recording.startedAt ?? '' } : null,
    cameras: (w.cameras ?? []).map(cameraInfo),
    ...(w.disk && Number.isFinite(w.disk.remaining) && w.disk.remaining! > 0 ? { remainingSeconds: Math.round(w.disk.remaining! / 1e9) } : {}),
    ...(w.disk?.warning ? { diskWarning: w.disk.warning } : {}),
  };
}

export function sessionsFromWire(list: WireSummary[], project: Project): CamPodSessionInfo[] {
  const linked = new Set((project.campod?.sessions ?? []).map((s) => s.name));
  return (list ?? []).map((s) => ({
    name: s.name,
    title: s.title ?? '',
    startedAt: s.startedAt ?? '',
    seconds: Math.round((s.duration ?? 0) / 1e9),
    bytes: s.bytes ?? 0,
    files: s.files ?? 0,
    active: !!s.active,
    linked: linked.has(s.name),
  }));
}

/** One video file to bring into the episode. */
export interface CamPodFile {
  /** Camera name in the episode ("Host", "Host (part 2)"). */
  camera: string;
  file: string;
  /** 1 = the camera's first file; more after it dropped out during the recording. */
  part: number;
}

/** The files of a recording WavePod can import, and why it leaves the others out. */
export function sessionFiles(s: WireSession): { files: CamPodFile[]; skipped: string[] } {
  const files: CamPodFile[] = [];
  const skipped: string[] = [];
  for (const c of s.cameras ?? []) {
    const list = (c.files ?? []).filter((f) => /^[^/\\]+\.mkv$/i.test(f) && !f.startsWith('.'));
    const name = (c.name || c.model || c.id).trim();
    if (!list.length) {
      skipped.push(`${name}: ${c.startError ? `did not record (${c.startError})` : 'no file'}`);
      continue;
    }
    const problem = cameraProblem({ fourcc: c.choice?.fourcc, codec: c.codec || 'copy', hasAudio: c.hasAudio });
    if (problem) {
      skipped.push(`${name}: ${problem.replace('Set it to H.264.', 'Set it to H.264 in CamPod before the next recording.')}`);
      continue;
    }
    list.forEach((file, i) => files.push({ camera: list.length > 1 ? `${name} (part ${i + 1})` : name, file, part: i + 1 }));
  }
  return { files, skipped };
}

// ---------------------------------------------------------------- the episode's CamPod recordings

/** Notes that a CamPod recording was started with the take that began at timeline frame `start`. */
export function linkSession(project: Project, link: CamPodLink): Project {
  const sessions = (project.campod?.sessions ?? []).filter((s) => s.name !== link.name);
  return { ...project, campod: { sessions: [...sessions, link] } };
}

export function linkedSession(project: Project, name: string): CamPodLink | undefined {
  return project.campod?.sessions.find((s) => s.name === name);
}

/** Where a camera's sound goes on the timeline before it is synced: where its take started. */
export function cameraStartFrame(project: Project, session: string, part: number): Frames | undefined {
  const link = linkedSession(project, session);
  return link && part === 1 ? link.start : undefined;
}

export function normalizeCamPodLinks(p: Project): void {
  const raw = (p as { campod?: { sessions?: unknown } }).campod;
  const sessions = Array.isArray(raw?.sessions)
    ? (raw.sessions as Array<Partial<CamPodLink>>)
        .filter((s) => s && typeof s.name === 'string' && /^[\w.-]{1,160}$/.test(s.name) && Number.isFinite(s.start) && s.start! >= 0)
        .map((s) => ({ name: s.name!, start: Math.round(s.start!) }))
    : [];
  if (sessions.length) p.campod = { sessions };
  else delete p.campod;
}

/** Folder (relative to the episode) the camera files of a recording are downloaded into. */
export function downloadFolder(session: string): string {
  return `video/${session.replace(/[^\w.-]/g, '_')}`;
}

// ---------------------------------------------------------------- HTTP client

export class CamPodClient {
  constructor(
    private base: string,
    private token = '',
    private fetchFn: FetchFn = fetch,
  ) {
    if (!base) throw new Error('Set up CamPod first: Edit › Settings › Cameras.');
  }

  private headers(json = false): Record<string, string> {
    return { ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}) };
  }

  /** Requests `path`; CamPod's error messages (German) are passed on as they are. */
  async call<T>(method: string, path: string, body?: unknown, timeoutMs = 8000): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}${path}`, {
        method,
        headers: this.headers(body !== undefined),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const why = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'it did not answer in time' : e instanceof Error ? e.message : String(e);
      throw new Error(`Can’t reach CamPod at ${this.base}: ${why}. Is the CamPod computer on and in the same network?`);
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // not JSON
    }
    if (res.status === 401) throw new Error('CamPod did not accept the API key. Create one on the CamPod computer (campod apikey create wavepod) and paste it into Settings › Cameras.');
    if (!res.ok) {
      const msg = (data as { error?: string } | null)?.error;
      if ((res.status === 404 || res.status === 405) && !msg) throw new Error(`CamPod at ${this.base} doesn’t know this request. Update CamPod to a version that works with WavePod.`);
      throw new Error(`CamPod: ${msg || `HTTP ${res.status}`}`);
    }
    return data as T;
  }

  async status(): Promise<CamPodStatus> {
    return statusFromWire(await this.call<WireStatus>('GET', '/api/status'));
  }

  /** Starts recording on every active camera; returns the recording's name and cameras that failed. */
  async start(title: string): Promise<{ name: string; startedAt: string; failed: string[] }> {
    // starting waits for the cameras (up to 6 s on CamPod's side)
    const r = await this.call<{ session: { name: string; startedAt?: string; cameras?: Array<{ id: string; name: string }> }; errors?: Record<string, string> }>(
      'POST',
      '/api/recording/start',
      { title: title.slice(0, 120) },
      20000,
    );
    const names = new Map((r.session.cameras ?? []).map((c) => [c.id, c.name]));
    const failed = Object.entries(r.errors ?? {}).map(([id, e]) => `${names.get(id) ?? id}: ${e}`);
    return { name: r.session.name, startedAt: r.session.startedAt ?? '', failed };
  }

  async stop(): Promise<void> {
    // stopping waits for the files to be closed (up to 20 s)
    await this.call('POST', '/api/recording/stop', undefined, 30000);
  }

  async sessions(): Promise<WireSummary[]> {
    return (await this.call<WireSummary[]>('GET', '/api/sessions')) ?? [];
  }

  /** A finished recording's session.json. CamPod answers {name, session, files}; a running one is refused (409). */
  async session(name: string): Promise<WireSession> {
    const r = await this.call<{ name: string; session?: WireSession | null } & Partial<WireSession>>('GET', `/api/sessions/${encodeURIComponent(name)}`);
    if (r && 'session' in r) {
      if (!r.session) throw new Error(`CamPod has no description (session.json) for ${name}.`);
      return { ...r.session, name: r.name ?? name };
    }
    return r as WireSession;
  }

  async setVideoCodec(cameraId: string, codec: 'h264' | 'copy'): Promise<void> {
    await this.call('PATCH', `/api/cameras/${encodeURIComponent(cameraId)}`, { videoCodec: codec });
  }

  /** The download of one recorded file, from byte `from` on (to resume). */
  async file(session: string, file: string, from = 0, signal?: AbortSignal): Promise<Response> {
    const res = await this.fetchFn(`${this.base}/api/sessions/${encodeURIComponent(session)}/files/${encodeURIComponent(file)}`, {
      headers: { ...this.headers(), ...(from > 0 ? { Range: `bytes=${from}-` } : {}) },
      signal,
    });
    if (res.status === 401) throw new Error('CamPod did not accept the API key.');
    if (res.status === 404) throw new Error(`CamPod can’t send ${file}. Update CamPod to a version that works with WavePod.`);
    if (!res.ok) throw new Error(`CamPod: HTTP ${res.status} for ${file}`);
    return res;
  }
}
