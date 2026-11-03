import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WavReader, WavWriter, parseWavHeader, readWavFile, writeWavFile } from '../src/core/wav';
import { sine, tmpDir } from './helpers';

describe('wav', () => {
  for (const bitDepth of [16, 24, 32] as const) {
    it(`round-trips ${bitDepth}-bit stereo`, () => {
      const dir = tmpDir();
      const file = path.join(dir, 'a.wav');
      const l = sine(440, 0.1, 48000, 0.8);
      const r = sine(220, 0.1, 48000, -0.5);
      writeWavFile(file, [l, r], 48000, bitDepth);
      const { info, channels } = readWavFile(file);
      expect(info.channels).toBe(2);
      expect(info.sampleRate).toBe(48000);
      expect(info.bitDepth).toBe(bitDepth);
      expect(info.float).toBe(bitDepth === 32);
      expect(info.frames).toBe(l.length);
      const tol = bitDepth === 16 ? 1e-4 : 1e-6;
      for (let i = 0; i < l.length; i += 97) {
        expect(Math.abs(channels[0][i] - l[i])).toBeLessThan(tol);
        expect(Math.abs(channels[1][i] - r[i])).toBeLessThan(tol);
      }
    });
  }

  it('streams in chunks and patches the header', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'b.wav');
    const w = new WavWriter(file, 1, 48000, 24, 1000, 3000);
    for (let i = 0; i < 20; i++) w.write([new Float32Array(480).fill(0.25)]);
    // before close, the header has been patched at least once
    const mid = fs.readFileSync(file);
    const midInfo = parseWavHeader(mid, mid.length);
    expect(midInfo.frames).toBeGreaterThan(0);
    w.close();
    const r = new WavReader(file);
    expect(r.frames).toBe(9600);
    const data = r.read(9500, 200);
    expect(data[0][0]).toBeCloseTo(0.25, 5);
    expect(data[0][99]).toBeCloseTo(0.25, 5);
    expect(data[0][100]).toBe(0); // past the end
    const before = r.read(-10, 20);
    expect(before[0][0]).toBe(0);
    expect(before[0][10]).toBeCloseTo(0.25, 5);
    r.close();
  });

  it('recovers files whose header was never finalised', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'crash.wav');
    const w = new WavWriter(file, 1, 48000, 16, 10, 1e12);
    w.write([new Float32Array(1000).fill(0.1)]);
    // simulate crash: no close(); header still says 0 bytes
    const r = new WavReader(file);
    expect(r.frames).toBe(1000);
    r.close();
  });

  it('clips out-of-range samples for integer formats', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'clip.wav');
    writeWavFile(file, [Float32Array.from([2, -2, 0.5])], 44100, 16);
    const { channels } = readWavFile(file);
    expect(channels[0][0]).toBeCloseTo(1, 3);
    expect(channels[0][1]).toBeCloseTo(-1, 3);
  });
});
