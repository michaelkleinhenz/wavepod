import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import OpusScript from 'opusscript';
import { describe, expect, it } from 'vitest';
import { OpusWriter, Resampler, oggCrc } from '../src/core/opus';
import { tmpDir } from './helpers';

/** Splits an Ogg file into packets (checking each page's CRC) and returns them with the last granule. */
function readOgg(buf: Buffer): { packets: Buffer[]; lastGranule: bigint; pages: number } {
  const packets: Buffer[] = [];
  let partial: Buffer[] = [];
  let at = 0;
  let lastGranule = 0n;
  let pages = 0;
  while (at < buf.length) {
    expect(buf.toString('latin1', at, at + 4)).toBe('OggS');
    const nseg = buf[at + 26];
    const segs = buf.subarray(at + 27, at + 27 + nseg);
    const bodyLen = segs.reduce((a, b) => a + b, 0);
    const page = Buffer.from(buf.subarray(at, at + 27 + nseg + bodyLen));
    const crc = page.readUInt32LE(22);
    page.writeUInt32LE(0, 22);
    expect(oggCrc(page)).toBe(crc);
    lastGranule = buf.readBigInt64LE(at + 6);
    let p = at + 27 + nseg;
    for (const s of segs) {
      partial.push(buf.subarray(p, p + s));
      p += s;
      if (s < 255) {
        packets.push(Buffer.concat(partial));
        partial = [];
      }
    }
    at = p;
    pages++;
  }
  return { packets, lastGranule, pages };
}

describe('Opus export', () => {
  it('resamples 44.1 kHz to 48 kHz keeping a tone', () => {
    const r = new Resampler(44100, 48000, 1);
    const n = 44100;
    const x = Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 1000 * i) / 44100) * 0.5);
    const out: number[] = [];
    for (let i = 0; i < n; i += 4096) out.push(...r.process([x.subarray(i)], Math.min(4096, n - i))[0]);
    expect(Math.abs(out.length - 48000)).toBeLessThan(40);
    // compare with the ideal 1 kHz sine at 48 kHz (allowing for the filter delay)
    const mid = out.slice(10000, 40000);
    const rms = Math.sqrt(mid.reduce((a, v) => a + v * v, 0) / mid.length);
    expect(rms).toBeCloseTo(0.5 / Math.SQRT2, 2);
  });

  it('writes a valid Ogg Opus file with tags, chapters and cover', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'ep.opus');
    const sr = 44100;
    const w = new OpusWriter(file, sr, 64, {
      title: 'Episode',
      artist: 'Me',
      genre: 'Technology',
      chapters: [{ start: 0, title: 'Intro' }, { start: 1.5, title: 'Talk' }],
      cover: { mime: 'image/png', data: Buffer.alloc(70000, 7) },
    });
    const n = sr * 3;
    const block = 4410;
    for (let i = 0; i < n; i += block) {
      const l = Float32Array.from({ length: block }, (_, k) => 0.3 * Math.sin((2 * Math.PI * 440 * (i + k)) / sr));
      w.write([l, l], block);
    }
    w.close();
    const { packets, lastGranule, pages } = readOgg(fs.readFileSync(file));
    expect(packets[0].toString('latin1', 0, 8)).toBe('OpusHead');
    expect(packets[0].readUInt32LE(12)).toBe(44100);
    const tags = packets[1].toString('utf8');
    expect(tags.startsWith('OpusTags')).toBe(true);
    expect(tags).toContain('CHAPTER002NAME=Talk');
    expect(tags).toContain('GENRE=Technology');
    expect(tags).toContain('METADATA_BLOCK_PICTURE=');
    expect(pages).toBeGreaterThan(3); // the cover spans pages
    // the end: pre-skip + 3 s at 48 kHz
    expect(Number(lastGranule) - 312).toBeGreaterThanOrEqual(48000 * 3 - 20);
    expect(Number(lastGranule) - 312).toBeLessThanOrEqual(48000 * 3 + 20);
    // decodes back to the tone at about the level it had
    const dec = new OpusScript(48000, 2);
    const pcm: number[] = [];
    for (const p of packets.slice(2)) {
      const out = dec.decode(p);
      const s = new Int16Array(out.buffer, out.byteOffset, out.length / 2);
      for (let i = 0; i < s.length; i += 2) pcm.push(s[i] / 32768);
    }
    dec.delete();
    const mid = pcm.slice(48000, 96000);
    const rms = Math.sqrt(mid.reduce((a, v) => a + v * v, 0) / mid.length);
    expect(rms).toBeGreaterThan(0.18);
    expect(rms).toBeLessThan(0.24);
  });

  it('is read by ffprobe when it is installed', () => {
    let ok = true;
    try {
      execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    } catch {
      ok = false;
    }
    if (!ok) return;
    const dir = tmpDir();
    const file = path.join(dir, 'x.opus');
    const w = new OpusWriter(file, 48000, 48, { title: 'T', chapters: [{ start: 0, title: 'A' }] });
    const l = new Float32Array(48000 * 2).map((_, i) => 0.2 * Math.sin(i / 10));
    w.write([l, l], l.length);
    w.close();
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream_tags', '-of', 'json', file]).toString();
    const info = JSON.parse(out);
    expect(Number(info.format.duration)).toBeCloseTo(2, 1);
    expect(info.streams[0].tags.TITLE ?? info.streams[0].tags.title).toBe('T');
    execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-']);
  });
});
