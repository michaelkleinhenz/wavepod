// Minimal ZIP reader for imports (Zencastr session downloads): lists the entries from the
// central directory and extracts stored or deflated entries to disk, streaming, so that
// hour-long WAVs never sit in memory. Supports ZIP64 sizes and offsets.
import * as fs from 'node:fs';
import * as zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';

export interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflate. */
  method: number;
  compressedSize: number;
  size: number;
  /** Offset of the local file header. */
  headerOffset: number;
  isDirectory: boolean;
}

const EOCD_SIG = 0x06054b50;
const EOCD64_LOC_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function readAt(fd: number, pos: number, len: number): Buffer {
  const buf = Buffer.alloc(len);
  let done = 0;
  while (done < len) {
    const n = fs.readSync(fd, buf, done, len - done, pos + done);
    if (n <= 0) break;
    done += n;
  }
  return done === len ? buf : buf.subarray(0, done);
}

function u64(buf: Buffer, at: number): number {
  return Number(buf.readBigUInt64LE(at));
}

/** Lists the entries of the ZIP file at `file`. Throws if it isn't a ZIP. */
export function listZip(file: string): ZipEntry[] {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    // the end-of-central-directory record is in the last 22 + 65535 (comment) bytes
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = readAt(fd, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('This is not a ZIP file.');
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if ((count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) && eocd >= 20 && tail.readUInt32LE(eocd - 20) === EOCD64_LOC_SIG) {
      const rec = readAt(fd, u64(tail, eocd - 20 + 8), 56);
      if (rec.readUInt32LE(0) === EOCD64_SIG) {
        count = u64(rec, 32);
        cdSize = u64(rec, 40);
        cdOffset = u64(rec, 48);
      }
    }
    const cd = readAt(fd, cdOffset, cdSize);
    const entries: ZipEntry[] = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== CEN_SIG) throw new Error('The ZIP file is damaged.');
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      let compressedSize = cd.readUInt32LE(p + 20);
      let fileSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let headerOffset = cd.readUInt32LE(p + 42);
      const rawName = cd.subarray(p + 46, p + 46 + nameLen);
      // bit 11: UTF-8 names; otherwise CP437, which matches UTF-8 for plain ASCII
      const name = (flags & 0x800 ? rawName.toString('utf8') : rawName.toString('latin1')).replace(/\\/g, '/');
      // ZIP64 extra field: the values that are 0xffffffff above follow in this order
      let e = p + 46 + nameLen;
      const extraEnd = e + extraLen;
      while (e + 4 <= extraEnd) {
        const id = cd.readUInt16LE(e);
        const len = cd.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (fileSize === 0xffffffff) (fileSize = u64(cd, q)), (q += 8);
          if (compressedSize === 0xffffffff) (compressedSize = u64(cd, q)), (q += 8);
          if (headerOffset === 0xffffffff) headerOffset = u64(cd, q);
        }
        e += 4 + len;
      }
      entries.push({ name, method, compressedSize, size: fileSize, headerOffset, isDirectory: name.endsWith('/') });
      p = extraEnd + commentLen;
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

/** Writes one entry of the ZIP at `file` to `dest`. */
export async function extractZipEntry(file: string, entry: ZipEntry, dest: string): Promise<void> {
  if (entry.method !== 0 && entry.method !== 8) throw new Error(`${entry.name}: unsupported compression (method ${entry.method}).`);
  const fd = fs.openSync(file, 'r');
  let dataStart: number;
  try {
    const loc = readAt(fd, entry.headerOffset, 30);
    if (loc.length < 30 || loc.readUInt32LE(0) !== LOC_SIG) throw new Error('The ZIP file is damaged.');
    dataStart = entry.headerOffset + 30 + loc.readUInt16LE(26) + loc.readUInt16LE(28);
  } finally {
    fs.closeSync(fd);
  }
  const out = fs.createWriteStream(dest);
  if (entry.compressedSize === 0) {
    out.end();
    await new Promise<void>((resolve, reject) => out.on('finish', resolve).on('error', reject));
    return;
  }
  const input = fs.createReadStream(file, { start: dataStart, end: dataStart + entry.compressedSize - 1 });
  if (entry.method === 0) await pipeline(input, out);
  else await pipeline(input, zlib.createInflateRaw(), out);
}
