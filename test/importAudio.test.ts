import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canStreamImport, importWav } from '../src/core/importAudio';
import { readWavFile, writeWavFile } from '../src/core/wav';
import { sine, tmpDir } from './helpers';

describe('streaming WAV import', () => {
  it('copies a WAV at the episode rate block by block, as 24-bit', () => {
    const dir = tmpDir();
    const src = path.join(dir, 'guest.wav');
    // longer than one block, and not a multiple of it
    const l = sine(440, 3.1, 48000, 0.8);
    const r = sine(220, 3.1, 48000, -0.5);
    writeWavFile(src, [l, r], 48000, 16);
    const dest = path.join(dir, 'media.wav');
    const progress: number[] = [];
    const frames = importWav(src, dest, 48000, (f) => progress.push(f));
    expect(frames).toBe(l.length);
    const { info, channels } = readWavFile(dest);
    expect(info).toMatchObject({ channels: 2, sampleRate: 48000, bitDepth: 24, frames: l.length });
    for (let i = 0; i < l.length; i += 101) {
      expect(Math.abs(channels[0][i] - l[i])).toBeLessThan(1e-4);
      expect(Math.abs(channels[1][i] - r[i])).toBeLessThan(1e-4);
    }
    expect(progress[progress.length - 1]).toBe(1);
  });

  it('resamples to the episode rate and keeps the first two channels', () => {
    const dir = tmpDir();
    const src = path.join(dir, 'zoom.wav');
    const a = sine(1000, 2, 44100, 0.5);
    const b = sine(500, 2, 44100, 0.5);
    const c = sine(250, 2, 44100, 0.5);
    writeWavFile(src, [a, b, c], 44100, 24);
    const dest = path.join(dir, 'media.wav');
    const frames = importWav(src, dest, 48000);
    expect(Math.abs(frames - 96000)).toBeLessThanOrEqual(1);
    const { info, channels } = readWavFile(dest);
    expect(info.channels).toBe(2);
    // the 1 kHz tone survives: compare with an ideal 1 kHz tone at 48 kHz in the middle of the file
    // (the resampler delays by half its window: allow a few samples of shift)
    const want = sine(1000, 2, 48000, 0.5);
    let best = Infinity;
    for (let shift = -16; shift <= 16; shift++) {
      let err = 0;
      for (let i = 20000; i < 70000; i++) err = Math.max(err, Math.abs(channels[0][i] - want[i + shift]));
      best = Math.min(best, err);
    }
    expect(best).toBeLessThan(0.02);
  });

  it('only streams WAV files it can read, and leaves nothing behind when it fails', () => {
    const dir = tmpDir();
    const mp3 = path.join(dir, 'a.mp3');
    fs.writeFileSync(mp3, Buffer.from('ID3\u0003\u0000\u0000\u0000\u0000\u0000\u0000not really'));
    expect(canStreamImport(mp3)).toBe(false);
    expect(canStreamImport(path.join(dir, 'missing.wav'))).toBe(false);
    const wav = path.join(dir, 'b.wav');
    writeWavFile(wav, [sine(440, 0.1, 48000)], 48000, 32);
    expect(canStreamImport(wav)).toBe(true);
    const dest = path.join(dir, 'out.wav');
    expect(() => importWav(mp3, dest, 48000)).toThrow();
    expect(fs.existsSync(dest)).toBe(false);
  });
});
