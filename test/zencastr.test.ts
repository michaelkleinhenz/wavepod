import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { fileTime, planZencastrImport, sessionTitle } from '../src/core/zencastr';
import { extractZipEntry, listZip } from '../src/core/zip';
import { tmpDir } from './helpers';

/** Writes a ZIP with the given files (deflated unless `store`). */
function writeZip(file: string, files: Record<string, Buffer>, store = false): void {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const body = store ? data : zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(20, 4);
    loc.writeUInt16LE(0x800, 6);
    loc.writeUInt16LE(store ? 0 : 8, 8);
    loc.writeUInt32LE(crc, 14);
    loc.writeUInt32LE(body.length, 18);
    loc.writeUInt32LE(data.length, 22);
    loc.writeUInt16LE(nameBuf.length, 26);
    locals.push(loc, nameBuf, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x800, 8);
    cen.writeUInt16LE(store ? 0 : 8, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...locals, cd, end]));
}

describe('zip reader', () => {
  it('lists and extracts deflated and stored entries', async () => {
    const dir = tmpDir();
    const big = Buffer.from(Uint8Array.from({ length: 200_000 }, (_, i) => (i * 7) % 251));
    for (const store of [false, true]) {
      const zip = path.join(dir, `t${store}.zip`);
      writeZip(zip, { 'a/ä.wav': big, 'b.txt': Buffer.from('hello') }, store);
      const entries = listZip(zip);
      expect(entries.map((e) => [e.name, e.size])).toEqual([['a/ä.wav', big.length], ['b.txt', 5]]);
      const out = path.join(dir, `out${store}`);
      await extractZipEntry(zip, entries[0], out);
      expect(fs.readFileSync(out).equals(big)).toBe(true);
    }
  });

  it('rejects files that are not ZIPs', () => {
    const f = path.join(tmpDir(), 'x.zip');
    fs.writeFileSync(f, 'not a zip at all');
    expect(() => listZip(f)).toThrow(/not a ZIP/);
  });
});

describe('Zencastr session ZIP', () => {
  it('takes the WAV over the MP3 and puts the soundboard on its own track (real download layout)', () => {
    const plan = planZencastrImport([
      'kleinhenz/kleinhenz_recording-1_2026-11-04_15-10-53.wav',
      'kleinhenz/kleinhenz_recording-1_2026-11-04_15-10-53.mp3',
      'recording-1_soundboard.mp3',
      'recording-1_transcription.txt',
    ]);
    expect(plan.tracks).toEqual([
      { name: 'kleinhenz', parts: [{ entry: 'kleinhenz/kleinhenz_recording-1_2026-11-04_15-10-53.wav', start: 0 }] },
      { name: 'Soundboard', soundboard: true, parts: [{ entry: 'recording-1_soundboard.mp3', start: 0 }] },
    ]);
    expect(plan.skipped).toEqual(['kleinhenz/kleinhenz_recording-1_2026-11-04_15-10-53.mp3', 'recording-1_transcription.txt']);
  });

  it('places a rejoin after the first part by the time in its file name', () => {
    const plan = planZencastrImport([
      'guest/guest_recording-1_2026-11-04_15-20-00.mp3',
      'guest/guest_recording-1_2026-11-04_15-10-00.mp3',
      'host/host_recording-1_2026-11-04_15-10-01.wav',
      'Postproductions/mix.mp3',
      'host/video.mov',
    ]);
    expect(plan.tracks.map((t) => t.name)).toEqual(['guest', 'host']);
    expect(plan.tracks[0].parts.map((p) => p.start)).toEqual([0, 600]);
    expect(plan.skipped).toEqual(['Postproductions/mix.mp3', 'host/video.mov']);
  });

  it('works out participants without folders', () => {
    const plan = planZencastrImport(['anna_recording-2_2026-01-01_10-00-00.wav', 'ben_recording-2_2026-01-01_10-00-00.wav']);
    expect(plan.tracks.map((t) => t.name)).toEqual(['anna', 'ben']);
  });

  it('reads the session name and file times', () => {
    expect(sessionTitle('kleinhenz_demo_recording-1.zip')).toBe('kleinhenz demo');
    expect(sessionTitle('/x/My Show.zip')).toBe('My Show');
    expect(fileTime('a/b_recording-1_2026-11-04_15-10-53.wav')).toBe(Date.UTC(2026, 10, 4, 15, 10, 53) / 1000);
    expect(fileTime('soundboard.mp3')).toBeNull();
  });
});
