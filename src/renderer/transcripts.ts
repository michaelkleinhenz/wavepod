// The episode's transcripts in the renderer: loaded per episode, updated as files finish,
// and turned into timeline words (cached until the project or a transcript changes).
import type { FileTranscript, Project, TimelineWord, TranscribeProgress } from '../shared/types';
import { timelineWords } from '../core/transcript';
import { errorMessage, toast } from './dom';
import { api, store } from './store';

type Listener = () => void;

class Transcripts {
  private files = new Map<string, FileTranscript>();
  private dir = '';
  private cache: { project: Project; version: number; words: TimelineWord[] } | null = null;
  private version = 0;
  private listeners = new Set<Listener>();
  progress: TranscribeProgress | null = null;
  busy = false;

  constructor() {
    api().onTranscript(({ file, transcript }) => {
      if (transcript) this.files.set(file, transcript);
      else this.files.delete(file);
      this.changed();
    });
    api().onTranscribeProgress((p) => {
      this.progress = p.phase === 'done' ? null : p;
      this.emit();
    });
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private changed(): void {
    this.version++;
    this.emit();
  }

  /** Loads the transcripts when the episode changed (cheap otherwise). */
  async ensureLoaded(force = false): Promise<void> {
    if (!force && this.dir === store.dir) return;
    this.dir = store.dir;
    try {
      const all = await api().loadTranscripts();
      this.files = new Map(Object.entries(all));
    } catch {
      this.files.clear();
    }
    this.changed();
  }

  get count(): number {
    return this.files.size;
  }

  /** True if every speech track's files have a transcript. */
  get complete(): boolean {
    return store.project.tracks.filter((t) => t.kind !== 'soundboard').every((t) => t.clips.every((c) => this.files.has(c.file)));
  }

  words(): TimelineWord[] {
    const p = store.project;
    if (this.cache && this.cache.project === p && this.cache.version === this.version) return this.cache.words;
    const words = timelineWords(p, this.files);
    this.cache = { project: p, version: this.version, words };
    return words;
  }

  /** Transcribes what's missing (or everything again with redo). */
  async transcribe(redo = false): Promise<void> {
    if (this.busy) return;
    const info = await api().getTranscriptionInfo();
    if (!info.hasKey) {
      toast('Add your ElevenLabs API key first: Edit › Settings', 'error');
      window.dispatchEvent(new CustomEvent('wavepod:open-settings'));
      return;
    }
    if (!store.project.tracks.some((t) => t.kind !== 'soundboard' && t.clips.length)) return toast('There is nothing to transcribe yet');
    this.busy = true;
    this.emit();
    try {
      const r = await api().transcribe({ redo });
      if (r.stopped) toast(`Transcription stopped${r.transcribed ? ` after ${r.transcribed} file${r.transcribed === 1 ? '' : 's'}` : ''}`);
      else if (!r.transcribed) toast('Everything is transcribed already');
      else toast(`Transcribed ${r.transcribed} file${r.transcribed === 1 ? '' : 's'}`);
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      this.busy = false;
      this.progress = null;
      this.emit();
    }
  }

  stop(): void {
    void api().stopTranscribing();
  }
}

let instance: Transcripts | null = null;

/** The shared transcript state (created on first use, after the API is there). */
export function transcripts(): Transcripts {
  instance ??= new Transcripts();
  return instance;
}
