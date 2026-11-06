// Speech synthesis in the main process (experimental): voices, voice clones from a speaker's
// track, generating words at the speaker's level, and storing a generated clip with its transcript.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FileTranscript, Project, SpeechInfo, SpeechSettings, SpokenWords, TimelineWord } from '../shared/types';
import { WavReader, writeWavFile } from '../core/wav';
import { Resampler } from '../core/opus';
import { pcmToWav } from '../core/speechAudio';
import {
  TTS_MODELS,
  activeRms,
  cloneVoice,
  deleteVoice,
  listVoices,
  matchGainDb,
  normalizeSpeechSettings,
  prepareSpeech,
  speechPad,
  speechTranscript,
  synthesizeSpeech,
  voiceSampleRanges,
  type ElevenVoice,
  type SpeechEditMode,
} from '../core/speech';
import { saveTranscript } from './transcribe/store';

export interface SpeechHost {
  project(): Project;
  dir(): string;
  apiKey(): string;
  settings(): SpeechSettings;
  saveSettings(s: SpeechSettings): void;
  /** The episode's words on the timeline. */
  words(): TimelineWord[];
  /** A file's transcript was made. */
  updated(file: string, t: FileTranscript): void;
}

export interface SpeakInput {
  trackId: string;
  voiceId: string;
  text: string;
  previousText?: string;
  nextText?: string;
  mode: SpeechEditMode;
  /** Timeline position of the edit: the speaker's level is measured around it. */
  at: number;
}

// tests point it at a local mock server
const base = () => process.env.WAVEPOD_ELEVENLABS_BASE || undefined;

export class SpeechService {
  constructor(private host: SpeechHost) {}

  info(): SpeechInfo {
    return { hasKey: !!this.host.apiKey(), settings: this.host.settings(), models: TTS_MODELS };
  }

  setSettings(patch: Partial<SpeechSettings>): SpeechInfo {
    this.host.saveSettings(normalizeSpeechSettings({ ...this.host.settings(), ...patch }));
    return this.info();
  }

  private key(): string {
    const k = this.host.apiKey();
    if (!k) throw new Error('Add your ElevenLabs API key first: Edit › Settings.');
    return k;
  }

  voices(): Promise<ElevenVoice[]> {
    return listVoices(this.key(), { base: base() });
  }

  /** Clones the voice of a track's speaker from up to 90 s of their transcribed speech. */
  async clone(trackId: string): Promise<{ id: string; name: string; seconds: number }> {
    const key = this.key();
    const project = this.host.project();
    const track = project.tracks.find((t) => t.id === trackId);
    if (!track) throw new Error('That track is gone.');
    const dir = this.host.dir();
    const readers = new Map<string, WavReader>();
    const reader = (file: string) => {
      let r = readers.get(file);
      if (!r) readers.set(file, (r = new WavReader(this.abs(dir, file))));
      return r;
    };
    try {
      const ranges = voiceSampleRanges(project, this.host.words(), trackId, (f) => reader(f).info.sampleRate);
      if (!ranges.length) throw new Error(`There is no transcribed speech on ${track.name} to learn the voice from. Transcribe the episode first.`);
      // one mono file at the recording's rate, a short silence between the pieces
      const rate = reader(ranges[0].file).info.sampleRate;
      const gap = Math.round(rate * 0.25);
      const parts: Float32Array[] = [];
      let total = 0;
      for (const r of ranges) {
        const rd = reader(r.file);
        let x = mono(rd.read(r.from, r.to - r.from));
        if (rd.info.sampleRate !== rate) x = resample(x, rd.info.sampleRate, rate);
        parts.push(x, new Float32Array(gap));
        total += x.length + gap;
      }
      const all = new Float32Array(total);
      let o = 0;
      for (const x of parts) {
        all.set(x, o);
        o += x.length;
      }
      // normalise the sample to -3 dBFS peak: quiet recordings clone worse
      let peak = 0;
      for (const v of all) peak = Math.max(peak, Math.abs(v));
      const g = peak > 0 ? 0.7 / peak : 1;
      const pcm = new Int16Array(all.length);
      for (let i = 0; i < all.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(all[i] * g * 32767)));
      const name = `WavePod · ${track.name}`;
      const id = await cloneVoice(key, name, pcmToWav(pcm, rate), `Cloned by WavePod from the track "${track.name}" of "${project.metadata.title || project.name}".`, { base: base() });
      return { id, name, seconds: Math.round(all.length / rate) };
    } finally {
      for (const r of readers.values()) r.close();
    }
  }

  deleteVoice(voiceId: string): Promise<void> {
    return deleteVoice(this.key(), voiceId, { base: base() });
  }

  /** Says the words in the voice, at the project rate, trimmed, at the speaker's level. */
  async speak(input: SpeakInput): Promise<SpokenWords> {
    const text = input.text.trim();
    if (!text) throw new Error('Type the words to say.');
    if (text.length > 400) throw new Error('That is a lot of text: speech synthesis is meant for a few words.');
    const settings = this.host.settings();
    const { samples, sampleRate } = await synthesizeSpeech(
      this.key(),
      { voiceId: input.voiceId, text, previousText: input.previousText, nextText: input.nextText },
      settings,
      { base: base() },
    );
    if (!samples.length) throw new Error('ElevenLabs sent back no audio.');
    const project = this.host.project();
    const sr = project.sampleRate;
    const x = sampleRate === sr ? samples : resample(samples, sampleRate, sr);
    const padSeconds = speechPad(input.mode);
    const out = prepareSpeech(x, sr, padSeconds);
    const ref = this.speakerRms(input.trackId, input.at);
    return { samples: out, gain: matchGainDb(ref, activeRms(out, sr)), pad: Math.round(padSeconds * sr) };
  }

  /** Writes the generated words to media/ with a transcript of their own. */
  store(text: string, spoken: { samples: Float32Array; pad: number }): { file: string; length: number } {
    const dir = this.host.dir();
    const project = this.host.project();
    const media = path.join(dir, 'media');
    fs.mkdirSync(media, { recursive: true });
    const slug =
      text
        .trim()
        .slice(0, 24)
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '') || 'words';
    let rel = `media/tts-${slug}.wav`;
    for (let i = 2; fs.existsSync(path.join(dir, rel)); i++) rel = `media/tts-${slug}-${i}.wav`;
    writeWavFile(path.join(dir, rel), [spoken.samples], project.sampleRate, 24);
    const t = speechTranscript(rel, text.trim(), project.sampleRate, spoken.samples.length, spoken.pad);
    saveTranscript(dir, t);
    this.host.updated(rel, t);
    return { file: rel, length: spoken.samples.length };
  }

  private abs(dir: string, file: string): string {
    return path.isAbsolute(file) ? file : path.join(dir, file);
  }

  /** Level of the speaker's words within 20 s of `at` (with clip gain), RMS of the loud parts. */
  private speakerRms(trackId: string, at: number): number {
    const project = this.host.project();
    const sr = project.sampleRate;
    const track = project.tracks.find((t) => t.id === trackId);
    if (!track) return 0;
    const clips = new Map(track.clips.map((c) => [c.id, c]));
    const words = this.host.words().filter((w) => w.trackId === trackId && !w.filler && !w.muted && Math.abs(w.start - at) < sr * 20);
    // the closest 40 words are plenty
    words.sort((a, b) => Math.abs(a.start - at) - Math.abs(b.start - at));
    const dir = this.host.dir();
    const readers = new Map<string, WavReader>();
    const parts: Float32Array[] = [];
    try {
      for (const w of words.slice(0, 40)) {
        const c = clips.get(w.clipId);
        if (!c) continue;
        let r = readers.get(c.file);
        if (!r) {
          try {
            readers.set(c.file, (r = new WavReader(this.abs(dir, c.file))));
          } catch {
            continue;
          }
        }
        const scale = sr / r.info.sampleRate;
        const from = Math.round((w.start - c.start + c.offset) / scale);
        const to = Math.round((w.end - c.start + c.offset) / scale);
        if (to <= from) continue;
        let x = mono(r.read(from, to - from));
        if (r.info.sampleRate !== sr) x = resample(x, r.info.sampleRate, sr);
        const g = 10 ** (c.gain / 20);
        if (g !== 1) for (let i = 0; i < x.length; i++) x[i] *= g;
        parts.push(x);
      }
    } finally {
      for (const r of readers.values()) r.close();
    }
    const total = parts.reduce((n, p) => n + p.length, 0);
    if (!total) return 0;
    const all = new Float32Array(total);
    let o = 0;
    for (const p of parts) {
      all.set(p, o);
      o += p.length;
    }
    return activeRms(all, sr);
  }
}

function mono(ch: Float32Array[]): Float32Array {
  if (ch.length === 1) return ch[0].slice();
  const out = new Float32Array(ch[0].length);
  for (const c of ch) for (let i = 0; i < out.length; i++) out[i] += c[i] / ch.length;
  return out;
}

function resample(x: Float32Array, from: number, to: number): Float32Array {
  const r = new Resampler(from, to, 1);
  // a few zeros at the end push the last samples through the filter
  const padded = new Float32Array(x.length + 32);
  padded.set(x);
  const [out] = r.process([padded], padded.length);
  return out.subarray(0, Math.round((x.length * to) / from));
}
