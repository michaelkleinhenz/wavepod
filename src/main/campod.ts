// Main-process side of CamPod: the settings (token stored like the API keys), starting and stopping
// the cameras with WavePod's recording, and downloading a recording's camera files into the episode.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { CamPodEvent, CamPodImportFile, CamPodInfo, CamPodLink, CamPodSettingsInput, Project } from '../shared/types';
import { CamPodClient, cameraStartFrame, downloadFolder, normalizeCamPodUrl, sessionFiles, type StoredCamPod } from '../core/campod';
import { decodeKey, encodeKey } from './auphonic';

export function camPodInfo(s: StoredCamPod): CamPodInfo {
  return { url: s.url, hasToken: !!decodeKey(s.token), followRecording: s.followRecording };
}

export function updateCamPodSettings(s: StoredCamPod, input: CamPodSettingsInput): StoredCamPod {
  return {
    url: input.url === undefined ? s.url : normalizeCamPodUrl(input.url),
    token: input.token === undefined ? s.token : encodeKey(input.token.trim()),
    followRecording: input.followRecording ?? s.followRecording,
  };
}

export function camPodClient(s: StoredCamPod): CamPodClient {
  return new CamPodClient(s.url, decodeKey(s.token));
}

/**
 * Follows WavePod's recording: starts CamPod when a recording starts (named after the episode) and
 * stops it when the recording ends. Problems are reported to the window and never touch the sound
 * recording.
 */
export class CamPodFollower {
  /** The CamPod recording this take started (once CamPod answered). */
  private running: { name: string; start: number; linked?: boolean } | null = null;
  private starting: Promise<void> | null = null;
  /** The take ended before CamPod answered: stop as soon as it has started. */
  private stopWanted = false;
  /** Recordings to note in the episode when the take is merged. */
  private finished: CamPodLink[] = [];

  constructor(
    private settings: () => StoredCamPod,
    private notify: (e: CamPodEvent) => void,
  ) {}

  /** A recording started at timeline frame `start` (not a punch-in or loop pass). */
  recordingStarted(title: string, start: number): void {
    const s = this.settings();
    if (!s.url || !s.followRecording || this.starting || this.running) return;
    this.stopWanted = false;
    const client = camPodClient(s);
    this.starting = client
      .start(title || 'WavePod')
      .then(async (r) => {
        this.running = { name: r.name, start };
        this.notify({ kind: 'started', name: r.name, failed: r.failed });
        if (this.stopWanted) await this.stop(client);
      })
      .catch((e) => this.notify({ kind: 'error', message: `The cameras did not start: ${e instanceof Error ? e.message : String(e)}` }))
      .finally(() => (this.starting = null));
  }

  /** The recording ended (stopped, failed or the app quits). */
  recordingStopped(): void {
    if (this.starting) {
      this.stopWanted = true;
      return;
    }
    if (this.running) void this.stop(camPodClient(this.settings()));
  }

  /** Resolves once a stop asked for has reached CamPod (or failed), e.g. before the app quits. */
  async settle(): Promise<void> {
    if (this.starting) {
      this.stopWanted = true;
      await this.starting;
    }
    if (this.running) await this.stop(camPodClient(this.settings()));
    await this.stopping;
  }

  private stopping: Promise<void> = Promise.resolve();

  private stop(client: CamPodClient): Promise<void> {
    this.stopping = this.doStop(client);
    return this.stopping;
  }

  private async doStop(client: CamPodClient): Promise<void> {
    const run = this.running;
    if (!run) return;
    this.running = null;
    if (!run.linked) this.finished.push({ name: run.name, start: run.start });
    try {
      await client.stop();
      this.notify({ kind: 'stopped', name: run.name });
    } catch (e) {
      this.notify({ kind: 'error', message: `The cameras did not stop: ${e instanceof Error ? e.message : String(e)}. Stop them on the CamPod page.` });
    }
  }

  /** CamPod recordings to note in the episode now (each once). */
  takeLinks(): CamPodLink[] {
    const out = this.finished;
    this.finished = [];
    // a take that is still running on CamPod (its answer came late) is noted too
    if (this.running && !this.running.linked) {
      this.running.linked = true;
      out.push({ name: this.running.name, start: this.running.start });
    }
    return out;
  }

  get busy(): boolean {
    return !!this.running || !!this.starting;
  }
}

/** Downloads a CamPod recording's camera files into the episode folder. */
export class CamPodDownloader {
  private abort: AbortController | null = null;

  cancel(): void {
    this.abort?.abort();
  }

  async download(s: StoredCamPod, project: Project, dir: string, session: string, notify: (e: CamPodEvent) => void): Promise<{ files: CamPodImportFile[]; skipped: string[] }> {
    if (this.abort) throw new Error('A CamPod download is already running.');
    const client = camPodClient(s);
    const info = await client.session(session);
    if (!info.stoppedAt) throw new Error('This recording is still running on CamPod. Stop it first.');
    const { files, skipped } = sessionFiles(info);
    if (!files.length) return { files: [], skipped };
    const rel = downloadFolder(session);
    const folder = path.join(dir, rel);
    fs.mkdirSync(folder, { recursive: true });
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const out: CamPodImportFile[] = [];
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const dest = path.join(folder, f.file);
        const report = (fraction: number) => notify({ kind: 'download', file: f.file, index: i, count: files.length, fraction });
        await downloadFile(client, session, f.file, dest, report, signal);
        const start = cameraStartFrame(project, session, f.part);
        out.push({ camera: f.camera, path: `${rel}/${f.file}`, ...(start !== undefined ? { start } : {}) });
      }
    } catch (e) {
      if (signal.aborted) throw new Error('cancelled');
      throw e;
    } finally {
      this.abort = null;
    }
    return { files: out, skipped };
  }
}

/**
 * One file: written to `<dest>.part` and renamed when complete. A `.part` left by an interrupted
 * download is resumed; a complete file of the right size is kept as it is.
 */
async function downloadFile(client: CamPodClient, session: string, file: string, dest: string, progress: (f: number) => void, signal: AbortSignal): Promise<void> {
  const part = `${dest}.part`;
  const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  const res = await client.file(session, file, have, signal);
  const resumed = res.status === 206;
  const length = Number(res.headers.get('content-length')) || 0;
  const total = (resumed ? have : 0) + length;
  if (fs.existsSync(dest) && total > 0 && fs.statSync(dest).size === total) {
    await res.body?.cancel();
    progress(1);
    return;
  }
  if (!res.body) throw new Error(`CamPod sent nothing for ${file}`);
  let done = resumed ? have : 0;
  let last = 0;
  const body = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>);
  body.on('data', (chunk: Buffer) => {
    done += chunk.length;
    const now = Date.now();
    if (total && now - last > 200) {
      last = now;
      progress(Math.min(1, done / total));
    }
  });
  await pipeline(body, fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' }), { signal });
  if (total && fs.statSync(part).size !== total) throw new Error(`The download of ${file} was cut short. Import again to continue it.`);
  fs.renameSync(part, dest);
  progress(1);
}
