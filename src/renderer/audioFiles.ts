// Decodes audio files (any format Chromium supports) and resamples to the project rate.
import { api } from './store';
import type { ImportedAudio } from '../shared/api';
import { decodeAiff, isAiff } from '../core/aiff';

export async function decodeFile(path: string, sampleRate: number): Promise<Float32Array[]> {
  const bytes = await api().readFile(path);
  return decodeBytes(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, sampleRate);
}

/** Decodes an encoded audio file's bytes and resamples to `sampleRate`. */
export async function decodeBytes(data: ArrayBuffer, sampleRate: number): Promise<Float32Array[]> {
  let decoded: AudioBuffer;
  if (isAiff(data)) {
    // Chromium does not decode AIFF
    const aiff = decodeAiff(data);
    const n = Math.min(2, aiff.channels.length);
    decoded = new AudioBuffer({ numberOfChannels: n, length: Math.max(1, aiff.channels[0].length), sampleRate: aiff.sampleRate });
    for (let c = 0; c < n; c++) decoded.copyToChannel(aiff.channels[c] as Float32Array<ArrayBuffer>, c);
  } else {
    const ctx = new AudioContext();
    try {
      decoded = await ctx.decodeAudioData(data);
    } catch {
      throw new Error('not an audio file WavePod can read (WAV, AIFF, MP3, FLAC, Ogg, Opus, M4A/AAC)');
    } finally {
      void ctx.close();
    }
  }
  const channels = Math.min(2, decoded.numberOfChannels);
  let buffer = decoded;
  if (decoded.sampleRate !== sampleRate) {
    const length = Math.ceil(decoded.duration * sampleRate);
    const off = new OfflineAudioContext(channels, length, sampleRate);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    buffer = await off.startRendering();
  }
  // the buffer's own arrays: a copy would double the memory a long file needs
  return Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
}

/** Frames per message when sending decoded audio to the main process (about 5 s at 48 kHz). */
const UPLOAD_CHUNK = 1 << 18;

/** Writes decoded audio into the episode's media folder, sent in chunks so hours of audio fit. */
export async function uploadDecoded(name: string, channels: Float32Array[], sampleRate: number): Promise<ImportedAudio> {
  const id = await api().importAudioBegin(name, channels.length, sampleRate);
  try {
    const n = channels[0]?.length ?? 0;
    // slice(), not subarray(): a view would send its whole underlying buffer every time
    for (let pos = 0; pos < n; pos += UPLOAD_CHUNK) await api().importAudioChunk(id, channels.map((c) => c.slice(pos, Math.min(n, pos + UPLOAD_CHUNK))));
  } catch (e) {
    await api().importAudioEnd(id, true).catch(() => undefined);
    throw e;
  }
  return (await api().importAudioEnd(id))!;
}

/**
 * Imports an audio file into the episode's media folder: a file on disk (`path`, or a dropped `file`
 * that has one) that is a WAV is copied by the main process without passing through the window;
 * anything else is decoded here and streamed over.
 */
export async function importAudioSource(src: { path?: string; file?: File; name: string }, sampleRate: number): Promise<ImportedAudio> {
  const path = src.path || (src.file ? api().pathForFile(src.file) : '');
  if (path) {
    const streamed = await api().importAudioFile(path, src.name, sampleRate);
    if (streamed) return streamed;
  }
  const channels = path ? await decodeFile(path, sampleRate) : await decodeBytes(await src.file!.arrayBuffer(), sampleRate);
  return uploadDecoded(src.name, channels, sampleRate);
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
