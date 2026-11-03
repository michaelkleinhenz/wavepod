import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FLAC_BLOCK, FlacWriter } from '../src/core/flac';
import { tmpDir } from './helpers';

/** A small FLAC reader for what FlacWriter produces: FIXED/VERBATIM subframes, Rice coding, all channel modes. */
function decode(buf: Buffer) {
  expect(buf.toString('latin1', 0, 4)).toBe('fLaC');
  let o = 4;
  const blocks: Array<{ type: number; data: Buffer }> = [];
  for (;;) {
    const last = buf[o] & 0x80;
    const type = buf[o] & 0x7f;
    const len = buf.readUIntBE(o + 1, 3);
    blocks.push({ type, data: buf.subarray(o + 4, o + 4 + len) });
    o += 4 + len;
    if (last) break;
  }
  const si = blocks[0].data;
  const sampleRate = si.readUIntBE(10, 3) >> 4;
  const channels = ((si[12] >> 1) & 7) + 1;
  const bps = (((si[12] & 1) << 4) | (si[13] >> 4)) + 1;
  const total = (si[13] & 0xf) * 2 ** 32 + si.readUInt32BE(14);
  let bit = o * 8;
  const read = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++, bit++) v = v * 2 + ((buf[bit >> 3] >> (7 - (bit & 7))) & 1);
    return v;
  };
  const signed = (n: number) => {
    const v = read(n);
    return v >= 2 ** (n - 1) ? v - 2 ** n : v;
  };
  const out: number[][] = Array.from({ length: channels }, () => []);
  while (bit < buf.length * 8 - 8) {
    expect(read(16)).toBe(0xfff8);
    const sizeCode = read(4);
    read(4);
    const assign = read(4);
    read(3);
    read(1);
    // frame number (UTF-8)
    let first = read(8);
    let extra = 0;
    while (first & 0x80) {
      first = (first << 1) & 0xff;
      extra++;
    }
    for (let i = 0; i < Math.max(0, extra - 1); i++) read(8);
    const n = sizeCode === 12 ? 4096 : read(16) + 1;
    read(8); // crc8
    const subs: number[][] = [];
    const nch = assign <= 7 ? assign + 1 : 2;
    for (let c = 0; c < nch; c++) {
      const b = bps + (assign === 10 && c === 1 ? 1 : 0);
      read(1);
      const type = read(6);
      read(1);
      const x: number[] = [];
      if (type === 1) for (let i = 0; i < n; i++) x.push(signed(b));
      else {
        const order = type & 7;
        for (let i = 0; i < order; i++) x.push(signed(b));
        const method = read(2);
        const pBits = method === 1 ? 5 : 4;
        const po = read(4);
        const parts = 1 << po;
        for (let j = 0; j < parts; j++) {
          const k = read(pBits);
          const count = (n >> po) - (j === 0 ? order : 0);
          for (let i = 0; i < count; i++) {
            let q = 0;
            while (read(1) === 0) q++;
            const u = q * 2 ** k + (k ? read(k) : 0);
            const r = u % 2 ? -(u + 1) / 2 : u / 2;
            const t = x.length;
            const pred = [0, x[t - 1], 2 * x[t - 1] - x[t - 2], 3 * x[t - 1] - 3 * x[t - 2] + x[t - 3], 4 * x[t - 1] - 6 * x[t - 2] + 4 * x[t - 3] - x[t - 4]][order];
            x.push(r + (order ? pred : 0));
          }
        }
      }
      subs.push(x);
    }
    if (bit % 8) read(8 - (bit % 8));
    read(16); // crc16
    if (assign === 10) {
      for (let i = 0; i < n; i++) {
        const side = subs[1][i];
        const mid = subs[0][i] * 2 + (side & 1);
        out[0].push((mid + side) / 2);
        out[1].push((mid - side) / 2);
      }
    } else subs.forEach((s, c) => out[c].push(...s));
  }
  return { sampleRate, channels, bps, total, blocks, out };
}

describe('FLAC writer', () => {
  for (const bps of [16, 24] as const) {
    it(`is lossless at ${bps} bit (stereo, odd length, clipping, silence)`, () => {
      const dir = tmpDir();
      const sr = 48000;
      const n = FLAC_BLOCK * 3 + 777;
      const l = new Float32Array(n);
      const r = new Float32Array(n);
      let seed = 7;
      const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
      for (let i = 0; i < n; i++) {
        l[i] = i < FLAC_BLOCK ? 0 : 0.4 * Math.sin(i / 30) + 0.05 * rnd();
        r[i] = i < FLAC_BLOCK ? 0 : i % 3 ? 0.4 * Math.sin(i / 30) : 0.3 * Math.sin(i / 47) + 0.05 * rnd();
      }
      l[5000] = 1.5;
      r[6000] = -1.5;
      const file = path.join(dir, 'x.flac');
      const w = new FlacWriter(file, 2, sr, bps, { title: 'T', chapters: [{ start: 0, title: 'Intro' }, { start: 61.5, title: 'Talk', url: 'https://example.com' }], cover: { mime: 'image/png', data: Buffer.from('png') } });
      for (let i = 0; i < n; i += 1000) w.write([l.subarray(i), r.subarray(i)], Math.min(1000, n - i));
      w.close();
      const d = decode(fs.readFileSync(file));
      expect(d).toMatchObject({ sampleRate: sr, channels: 2, bps, total: n });
      const max = 2 ** (bps - 1) - 1;
      const q = (x: number) => Math.max(-max - 1, Math.min(max, Math.round(x < 0 ? x * (max + 1) : x * max)));
      for (let i = 0; i < n; i++) {
        if (d.out[0][i] !== q(l[i]) || d.out[1][i] !== q(r[i])) throw new Error(`sample ${i}: ${d.out[0][i]},${d.out[1][i]} vs ${q(l[i])},${q(r[i])}`);
      }
      // tags and cover
      const vc = d.blocks.find((b) => b.type === 4)!.data.toString('utf8');
      expect(vc).toContain('TITLE=T');
      expect(vc).toContain('CHAPTER002=00:01:01.500');
      expect(vc).toContain('CHAPTER002NAME=Talk');
      expect(vc).toContain('CHAPTER002URL=https://example.com');
      expect(d.blocks.find((b) => b.type === 6)!.data.toString('latin1')).toContain('image/png');
      // and it is actually compressed
      expect(fs.statSync(file).size).toBeLessThan(n * 2 * (bps / 8) * 0.9);
    });
  }
});
