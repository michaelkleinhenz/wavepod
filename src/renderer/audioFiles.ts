// Decodes audio files (any format Chromium supports) and resamples to the project rate.
import { api } from './store';

export async function decodeFile(path: string, sampleRate: number): Promise<Float32Array[]> {
  const bytes = await api().readFile(path);
  const ctx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    decoded = await ctx.decodeAudioData(copy);
  } finally {
    void ctx.close();
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
