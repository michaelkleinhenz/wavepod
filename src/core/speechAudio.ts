// Prepares audio for speech-to-text: mono, 16 kHz, 16-bit WAV, small enough to upload quickly
// (an hour is about 115 MB instead of half a gigabyte for a 48 kHz / 24-bit take).
import { WavReader } from './wav';
import { Resampler } from './opus';
import { LevelMeter } from './wordLevels';
import type { TranscriptLevels } from '../shared/types';

export const SPEECH_RATE = 16000;
const BLOCK = 1 << 16;

/** Reads a WAV file as mono 16 kHz 16-bit; `sampleRate` is the file's own rate (word times count in it). */
export function wavToSpeechPcm(path: string): { pcm: Int16Array; sampleRate: number; frames: number } {
  const reader = new WavReader(path);
  try {
    const { channels, sampleRate, frames } = reader.info;
    const pcm = new Int16Array(Math.ceil((frames * SPEECH_RATE) / sampleRate) + 64);
    const resampler = sampleRate === SPEECH_RATE ? null : new Resampler(sampleRate, SPEECH_RATE, 1);
    const mono = new Float32Array(BLOCK);
    let o = 0;
    const push = (x: Float32Array, n: number) => {
      for (let i = 0; i < n && o < pcm.length; i++) {
        const s = Math.max(-1, Math.min(1, x[i]));
        pcm[o++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
    };
    for (let pos = 0; pos < frames; pos += BLOCK) {
      const n = Math.min(BLOCK, frames - pos);
      const src = reader.read(pos, n);
      for (let i = 0; i < n; i++) {
        let v = 0;
        for (let c = 0; c < channels; c++) v += src[c][i];
        mono[i] = v / channels;
      }
      if (resampler) {
        const [out] = resampler.process([mono], n);
        push(out, out.length);
      } else push(mono, n);
    }
    return { pcm: pcm.subarray(0, o), sampleRate, frames };
  } finally {
    reader.close();
  }
}

/** A complete mono 16-bit WAV file. */
export function pcmToWav(pcm: Int16Array, sampleRate = SPEECH_RATE): Buffer {
  const data = pcm.length * 2;
  const buf = Buffer.alloc(44 + data);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(36 + data, 4);
  buf.write('WAVE', 8, 'latin1');
  buf.write('fmt ', 12, 'latin1');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'latin1');
  buf.writeUInt32LE(data, 40);
  Buffer.from(pcm.buffer, pcm.byteOffset, data).copy(buf, 44);
  return buf;
}

/**
 * The level curve of a WAV file (see core/wordLevels), read straight at the file's own rate.
 * Much quicker than preparing speech audio: older transcripts get their curve this way.
 */
export function wavLevelCurve(path: string): TranscriptLevels {
  const reader = new WavReader(path);
  try {
    const { channels, sampleRate, frames } = reader.info;
    const meter = new LevelMeter(sampleRate);
    const mono = new Float32Array(BLOCK);
    let buf: Float32Array[] | undefined;
    for (let pos = 0; pos < frames; pos += BLOCK) {
      const n = Math.min(BLOCK, frames - pos);
      buf = reader.read(pos, n, buf);
      for (let i = 0; i < n; i++) {
        let v = 0;
        for (let c = 0; c < channels; c++) v += buf[c][i];
        mono[i] = v / channels;
      }
      meter.push(mono, n);
    }
    return meter.finish();
  } finally {
    reader.close();
  }
}
