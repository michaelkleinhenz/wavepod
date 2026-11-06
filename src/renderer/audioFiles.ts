// Decodes audio files (any format Chromium supports) and resamples to the project rate.
import { api } from './store';
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
  return Array.from({ length: channels }, (_, c) => buffer.getChannelData(c).slice());
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
