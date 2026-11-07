// Imports a WAV file into an episode's media folder block by block, so a file of any length
// (a two-hour guest track, an RF64 recording) never has to fit into memory at once. Runs in a
// worker thread. Other formats are decoded by the window, which streams the result in chunks.
import * as fs from 'node:fs';
import { WavReader, WavWriter } from './wav';
import { Resampler } from './opus';

/** Frames read per block. */
const BLOCK = 1 << 16;
/** Imports keep at most this many channels (mono or stereo), like decoded files. */
export const IMPORT_MAX_CHANNELS = 2;

/** True if WavePod can stream-import `file`: a PCM or float WAV/RF64 with a sample format it reads. */
export function canStreamImport(file: string): boolean {
  let r: WavReader | null = null;
  try {
    r = new WavReader(file);
    const { bitDepth, float, channels } = r.info;
    return channels >= 1 && (float ? bitDepth === 32 : bitDepth === 16 || bitDepth === 24 || bitDepth === 32);
  } catch {
    return false;
  } finally {
    r?.close();
  }
}

/**
 * Copies the WAV `src` to `dest` as a 24-bit WAV at `sampleRate`, keeping the first two channels.
 * Returns the number of frames written. A failed import leaves no file behind.
 */
export function importWav(src: string, dest: string, sampleRate: number, onProgress?: (fraction: number) => void): number {
  const reader = new WavReader(src);
  let writer: WavWriter | null = null;
  try {
    const channels = Math.min(IMPORT_MAX_CHANNELS, reader.info.channels);
    const resampler = reader.info.sampleRate === sampleRate ? null : new Resampler(reader.info.sampleRate, sampleRate, channels);
    writer = new WavWriter(dest, channels, sampleRate, 24, 1 << 20, 0, { rf64: true });
    const total = reader.frames;
    let buf: Float32Array[] | undefined;
    let lastReport = -1;
    for (let pos = 0; pos < total; pos += BLOCK) {
      const n = Math.min(BLOCK, total - pos);
      buf = reader.read(pos, n, buf);
      const block = buf.slice(0, channels).map((c) => c.subarray(0, n));
      writer.write(resampler ? resampler.process(block, n) : block);
      const pct = Math.floor(((pos + n) / total) * 100);
      if (onProgress && pct !== lastReport) {
        lastReport = pct;
        onProgress(pct / 100);
      }
    }
    // the resampler holds back half its window: flush it with silence, and keep only what the input covers
    if (resampler) {
      const expected = Math.round((total * sampleRate) / reader.info.sampleRate);
      const tail = resampler.process(Array.from({ length: channels }, () => new Float32Array(32)), 32);
      const missing = expected - writer.framesWritten;
      if (missing > 0) writer.write(tail.map((c) => c.subarray(0, Math.min(missing, c.length))));
    }
    const frames = writer.framesWritten;
    writer.close();
    writer = null;
    return frames;
  } catch (e) {
    try {
      writer?.close();
    } catch {
      /* the file goes anyway */
    }
    fs.rmSync(dest, { force: true });
    throw e;
  } finally {
    reader.close();
  }
}
