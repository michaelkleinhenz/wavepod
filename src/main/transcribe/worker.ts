// Transcription off the main thread: turns each file into a small 16 kHz mono WAV, sends it
// to ElevenLabs speech-to-text and posts the words back as soon as a file is done.
import { parentPort, workerData } from 'node:worker_threads';
import * as path from 'node:path';
import type { FileTranscript, TranscribeProgress, TranscriptionSettings } from '../../shared/types';
import { SPEECH_RATE, pcmToWav, wavLevelCurve, wavToSpeechPcm } from '../../core/speechAudio';
import { levelCurve } from '../../core/wordLevels';
import { wordsFromScribe } from '../../core/transcript';
import { transcribeWithScribe } from '../../core/elevenlabs';

export interface TranscribeJob {
  apiKey: string;
  base?: string;
  settings: TranscriptionSettings;
  files: Array<{ abs: string; file: string; name: string }>;
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
    const { pcm, sampleRate } = wavToSpeechPcm(f.abs);
    const wav = pcmToWav(pcm);
    progress({ phase: 'transcribing', file: i + 1, files, name: f.name });
    try {
      const res = await transcribeWithScribe(job.apiKey, wav, `${path.basename(f.file, path.extname(f.file))}.wav`, job.settings, { base: job.base, signal: abort.signal });
      const transcript: FileTranscript = {
        version: 1,
        file: f.file,
        sampleRate,
        language: res.language_code ?? job.settings.language,
        model: job.settings.model,
        created: new Date().toISOString(),
        words: wordsFromScribe(res.words ?? [], sampleRate),
        levels: levelCurve(pcm, SPEECH_RATE, sampleRate),
      };
      post({ type: 'file', transcript });
    } catch (e) {
      if (abort.signal.aborted) break;
      throw e;
    }
  }
  post({ type: 'done', stopped: abort.signal.aborted });
}

run().catch((e) => post({ type: 'error', message: (e as Error).message }));
