// Transcription in the main process: settings and API key, running the worker, and keeping
// the episode's transcripts on disk.
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { FileTranscript, Project, TranscribeProgress, TranscriptionInfo, TranscriptionSettings, TranscriptionSettingsInput } from '../../shared/types';
import { filesToTranscribe, isWholeTranscript, mergeTranscript, selectionToTranscribe } from '../../core/transcript';
import { SCRIBE_MODELS, TRANSCRIPT_LANGUAGES, normalizeTranscriptionSettings } from '../../core/elevenlabs';
import { deleteTranscript, loadTranscript, loadTranscripts, saveTranscript } from './store';
import type { TranscribeJob } from './worker';

export interface TranscriptionHost {
  project(): Project;
  dir(): string;
  settings(): TranscriptionSettings;
  /** The ElevenLabs API key ('' if none). */
  apiKey(): string;
  /** Stores settings, and the key when given ('' removes it). */
  saveSettings(s: TranscriptionSettings, apiKey?: string): void;
  workerPath: string;
  progress(p: TranscribeProgress): void;
  /** A file's transcript was made or removed (null). */
  updated(file: string, t: FileTranscript | null): void;
}

export interface TranscribeOptions {
  trackIds?: string[];
  redo?: boolean;
  /** Only what this timeline range plays [from, to) (frames). */
  range?: [number, number];
}

export class TranscriptionService {
  private worker: Worker | null = null;
  /** Fills in level curves for transcripts made before they were kept. */
  private levelWorker: Worker | null = null;
  private levelsTried = new Set<string>();

  constructor(private host: TranscriptionHost) {}

  get busy(): boolean {
    return !!this.worker;
  }

  info(): TranscriptionInfo {
    return { hasKey: !!this.host.apiKey(), settings: this.host.settings(), models: SCRIBE_MODELS, languages: TRANSCRIPT_LANGUAGES };
  }

  setSettings(input: TranscriptionSettingsInput): TranscriptionInfo {
    const { apiKey, ...rest } = input;
    this.host.saveSettings(normalizeTranscriptionSettings({ ...this.host.settings(), ...rest }), apiKey === undefined ? undefined : apiKey.trim());
    return this.info();
  }

  /** Transcripts of every file the episode uses, by file. */
  load(): Record<string, FileTranscript> {
    const all = loadTranscripts(this.host.dir(), this.host.project().tracks.flatMap((t) => t.clips.map((c) => c.file)));
    this.fillLevels(all);
    return all;
  }

  /** Works out the level curves older transcripts lack, in the background (they're sent as updates). */
  private fillLevels(all: Record<string, FileTranscript>): void {
    if (this.levelWorker) return;
    const dir = this.host.dir();
    const names = new Map<string, string>();
    for (const tr of this.host.project().tracks) for (const c of tr.clips) if (!names.has(c.file)) names.set(c.file, tr.name);
    const todo = Object.values(all)
      .filter((t) => !t.levels && !this.levelsTried.has(`${dir}\n${t.file}`))
      .map((t) => ({ abs: path.isAbsolute(t.file) ? t.file : path.join(dir, t.file), file: t.file, name: names.get(t.file) ?? '' }));
    if (!todo.length) return;
    for (const f of todo) this.levelsTried.add(`${dir}\n${f.file}`);
    const worker = new Worker(this.host.workerPath, { workerData: { apiKey: '', settings: this.host.settings(), files: todo, levelsOnly: true } satisfies TranscribeJob });
    this.levelWorker = worker;
    // shown in the transcript panel, unless a transcription is reporting its own progress
    const show = (p: TranscribeProgress) => {
      if (!this.busy && this.host.dir() === dir) this.host.progress(p);
    };
    const end = () => {
      if (this.levelWorker !== worker) return;
      this.levelWorker = null;
      void worker.terminate();
      show({ phase: 'done', file: todo.length, files: todo.length });
    };
    worker.on('message', (msg: { type: string; file?: string; levels?: FileTranscript['levels']; progress?: TranscribeProgress }) => {
      if (msg.type === 'progress' && msg.progress) show(msg.progress);
      else if (msg.type === 'levels' && msg.file && msg.levels) {
        const t = loadTranscript(dir, msg.file);
        // a new transcript may have been made meanwhile; it has its own curve
        if (!t || t.levels) return;
        const next = { ...t, levels: msg.levels };
        saveTranscript(dir, next);
        if (this.host.dir() === dir) this.host.updated(next.file, next);
      } else if (msg.type === 'done' || msg.type === 'error') end();
    });
    worker.on('error', end);
    worker.on('exit', end);
  }

  /** Throws the transcripts of these tracks' files away (all tracks if none given). */
  remove(trackIds?: string[]): number {
    const dir = this.host.dir();
    let n = 0;
    for (const t of this.host.project().tracks) {
      if (trackIds && !trackIds.includes(t.id)) continue;
      for (const c of t.clips) {
        if (!loadTranscript(dir, c.file)) continue;
        deleteTranscript(dir, c.file);
        this.host.updated(c.file, null);
        n++;
      }
    }
    return n;
  }

  stop(): void {
    this.worker?.postMessage({ type: 'stop' });
  }

  /**
   * Transcribes the files of the given tracks (all speech tracks if none) that have no transcript
   * yet, or all of them with `redo`. With a `range` (timeline frames), only the parts of the files
   * that range plays and that aren't transcribed yet.
   */
  async transcribe(opts: TranscribeOptions = {}): Promise<{ transcribed: number; stopped: boolean }> {
    if (this.busy) throw new Error('A transcription is already running.');
    const apiKey = this.host.apiKey();
    if (!apiKey) throw new Error('Add your ElevenLabs API key first: Settings › Transcription.');
    const project = this.host.project();
    const dir = this.host.dir();
    const todo: Array<{ file: string; trackId: string; spans?: Array<[number, number]> }> = opts.range
      ? selectionToTranscribe(project, opts.range, (f) => loadTranscript(dir, f), opts.trackIds)
      : filesToTranscribe(project, (f) => !opts.redo && isWholeTranscript(loadTranscript(dir, f)), opts.trackIds);
    if (!todo.length) return { transcribed: 0, stopped: false };
    const names = new Map(project.tracks.map((t) => [t.id, t.name]));
    const job: TranscribeJob = {
      apiKey,
      // tests point it at a local mock server
      base: process.env.WAVEPOD_ELEVENLABS_BASE || undefined,
      settings: this.host.settings(),
      files: todo.map((t) => ({ abs: path.isAbsolute(t.file) ? t.file : path.join(dir, t.file), file: t.file, name: names.get(t.trackId) ?? '', ...(t.spans ? { spans: t.spans } : {}) })),
      projectRate: project.sampleRate,
    };
    let transcribed = 0;
    return new Promise((resolve, reject) => {
      const worker = new Worker(this.host.workerPath, { workerData: job });
      this.worker = worker;
      const finish = (fn: () => void) => {
        this.worker = null;
        void worker.terminate();
        this.host.progress({ phase: 'done', file: todo.length, files: todo.length });
        fn();
      };
      worker.on('message', (msg: { type: string; progress?: TranscribeProgress; transcript?: FileTranscript; stopped?: boolean; message?: string }) => {
        if (msg.type === 'progress') this.host.progress(msg.progress!);
        else if (msg.type === 'file') {
          // the episode may have been switched meanwhile: the transcript belongs to the folder it started in
          // a selection's parts join what the file's transcript already has
          const t = msg.transcript!.spans ? mergeTranscript(loadTranscript(dir, msg.transcript!.file), msg.transcript!) : msg.transcript!;
          saveTranscript(dir, t);
          transcribed++;
          if (this.host.dir() === dir) this.host.updated(t.file, t);
        } else if (msg.type === 'done') finish(() => resolve({ transcribed, stopped: !!msg.stopped }));
        else if (msg.type === 'error') finish(() => reject(new Error(msg.message)));
      });
      worker.on('error', (e) => finish(() => reject(e)));
      worker.on('exit', (code) => {
        if (this.worker === worker) finish(() => (code === 0 ? resolve({ transcribed, stopped: true }) : reject(new Error(`Speech recognition stopped unexpectedly (${code}).`))));
      });
    });
  }
}
