import { describe, expect, it } from 'vitest';
import { Mp3Encoder } from '../src/core/mp3';

/** Header fields of every MPEG audio frame in `bytes` (no ID3 tag in front). */
function frames(bytes: Uint8Array): { mode: number; kbps: number }[] {
  const KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const RATES = [44100, 48000, 32000];
  const out: { mode: number; kbps: number }[] = [];
  let at = 0;
  while (at + 4 <= bytes.length) {
    expect(bytes[at]).toBe(0xff);
    expect(bytes[at + 1] & 0xfe).toBe(0xfa); // MPEG-1 Layer III
    const kbps = KBPS[bytes[at + 2] >> 4];
    const rate = RATES[(bytes[at + 2] >> 2) & 3];
    const pad = (bytes[at + 2] >> 1) & 1;
    out.push({ mode: bytes[at + 3] >> 6, kbps });
    at += Math.floor((144000 * kbps) / rate) + pad;
  }
  return out;
}

function encode(channels: 1 | 2, kbps: number): Uint8Array {
  const rate = 48000;
  const enc = new Mp3Encoder(channels, rate, kbps);
  const parts: Uint8Array[] = [];
  const block = [new Float32Array(4096), new Float32Array(4096)];
  for (let pos = 0; pos < rate * 2; pos += 4096) {
    for (let i = 0; i < 4096; i++) {
      const t = (pos + i) / rate;
      block[0][i] = 0.3 * Math.sin(2 * Math.PI * 220 * t);
      block[1][i] = 0.28 * Math.sin(2 * Math.PI * 220 * t + 0.1);
    }
    parts.push(enc.encode(block, 4096));
  }
  parts.push(enc.flush());
  return Uint8Array.from(parts.flatMap((p) => [...p]));
}

describe('MP3 encoder', () => {
  it('writes joint stereo at the chosen constant bitrate', () => {
    // plain stereo (mode 0) halves the bits per channel; lamejs did that and it sounded like a room
    const f = frames(encode(2, 128));
    expect(f.length).toBeGreaterThan(70);
    expect(new Set(f.map((x) => x.kbps))).toEqual(new Set([128]));
    expect(f.every((x) => x.mode === 1)).toBe(true);
  });

  it('writes mono frames for a mono export', () => {
    const f = frames(encode(1, 64));
    expect(f.length).toBeGreaterThan(70);
    expect(f.every((x) => x.mode === 3 && x.kbps === 64)).toBe(true);
  });
});
