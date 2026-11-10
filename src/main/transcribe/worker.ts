// Transcription off the main thread: turns each file into a small 16 kHz mono WAV, sends it
// to ElevenLabs speech-to-text and posts the words back as soon as a file is done.
import { parentPort, workerData } from 'node:worker_threads';
import * as path from 'node:path';
import type { FileTranscript, TranscribeProgress, TranscriptionSettings } from '../../shared/types';
import { SPEECH_RATE, pcmToWav, wavLevelCurve, wavToSpeechPcm } from '../../core/speechAudio';
import { levelCurve } from '../../core/wordLevels';
import { eventsFromScribe, wordsFromScribe } from '../../core/transcript';
import { transcribeWithScribe } from '../../core/elevenlabs';

export interface TranscribeJob {
  apiKey: string;
  base?: string;
  settings: TranscriptionSettings;
  files: Array<{
    abs: string;
    file: string;
    name: string;
    /** Only these parts of the file ([from, to) in clip-offset units, project frames): a selection. */
    spans?: Array<[number, number]>;
  }>;
  /** Project sample rate, which `spans` count in. */
  projectRate?: number;
  /** Only work out the level curves of files transcribed before WavePod kept them (no upload). */
  levelsOnly?: boolean;
}

const job = workerData as TranscribeJob;
const post = (msg: unknown) => parentPort!.postMessage(msg);
const progress = (p: TranscribeProgress) => post({ type: 'progress', progress: p });
const abort = new AbortController();
parentPort!.on('message', (msg: { type: string }) => {
  if (msg.type === 'stop') abort.abort();
});

async function run(): Promise<void> {
  if (job.levelsOnly) {
    for (let i = 0; i < job.files.length && !abort.signal.aborted; i++) {
      const f = job.files[i];
      progress({ phase: 'levels', file: i + 1, files: job.files.length, name: f.name });
      try {
        post({ type: 'levels', file: f.file, levels: wavLevelCurve(f.abs) });
      } catch {
        // missing or unreadable file: its words simply stay unfiltered
      }
    }
    post({ type: 'done', stopped: abort.signal.aborted });
    return;
  }
  const files = job.files.length;
  for (let i = 0; i < files && !abort.signal.aborted; i++) {
    const f = job.files[i];
    progress({ phase: 'preparing', file: i + 1, files, name: f.name });
    const { pcm, sampleRate, frames } = wavToSpeechPcm(f.abs);
    progress({ phase: 'transcribing', file: i + 1, files, name: f.name });
    try {
      const name = `${path.basename(f.file, path.extname(f.file))}.wav`;
      const scribe = (audio: Int16Array) => transcribeWithScribe(job.apiKey, pcmToWav(audio), name, job.settings, { base: job.base, signal: abort.signal });
      let transcript: FileTranscript;
      const base = { version: 1 as const, file: f.file, sampleRate, model: job.settings.model, created: new Date().toISOString(), levels: levelCurve(pcm, SPEECH_RATE, sampleRate) };
      if (f.spans) {
        // a selection: only its parts of the file are sent, and their words moved to where they are in it
        const scale = sampleRate / (job.projectRate || sampleRate);
        const spans = f.spans
          .map(([a, b]) => [Math.round(a * scale), Math.min(frames, Math.round(b * scale))] as [number, number])
          .filter(([a, b]) => b > a);
        const words: FileTranscript['words'] = [];
        const events: FileTranscript['words'] = [];
        let language = job.settings.language;
        for (const [a, b] of spans) {
          if (abort.signal.aborted) break;
          const res = await scribe(pcm.subarray(Math.floor((a * SPEECH_RATE) / sampleRate), Math.ceil((b * SPEECH_RATE) / sampleRate)));
          const shift = (w: FileTranscript['words'][number]) => ({ ...w, start: w.start + a, end: w.end + a });
          words.push(...wordsFromScribe(res.words ?? [], sampleRate).map(shift));
          events.push(...eventsFromScribe(res.words ?? [], sampleRate).map(shift));
          language = res.language_code ?? language;
        }
        if (abort.signal.aborted) break;
        transcript = { ...base, language, words, events, spans };
      } else {
        const res = await scribe(pcm);
        transcript = {
          ...base,
          language: res.language_code ?? job.settings.language,
          words: wordsFromScribe(res.words ?? [], sampleRate),
          events: eventsFromScribe(res.words ?? [], sampleRate),
        };
      }
      post({ type: 'file', transcript });
    } catch (e) {
      if (abort.signal.aborted) break;
      throw e;
    }
  }
  post({ type: 'done', stopped: abort.signal.aborted });
}

run().catch((e) => post({ type: 'error', message: (e as Error).message }));
