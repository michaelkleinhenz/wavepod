// Streaming WAV writer and random-access WAV reader (PCM 16/24/32 and IEEE float 32).
import * as fs from 'node:fs';
import type { BitDepth } from '../shared/types';

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

export interface WavFormat {
  channels: number;
  sampleRate: number;
  bitDepth: BitDepth;
  float: boolean;
}

/** Encodes planar float samples into an interleaved little-endian buffer. */
export function encodeInterleaved(
  channels: Float32Array[],
  frames: number,
  bitDepth: BitDepth,
  float: boolean,
): Buffer {
  const nch = channels.length;
  const bps = bitDepth / 8;
  const buf = Buffer.alloc(frames * nch * bps);
  let o = 0;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      let s = channels[c][i];
      if (float) {
        buf.writeFloatLE(s, o);
      } else {
        if (s > 1) s = 1;
        else if (s < -1) s = -1;
        if (bitDepth === 16) {
          buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), o);
        } else if (bitDepth === 24) {
          buf.writeIntLE(Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff), o, 3);
        } else {
          buf.writeInt32LE(Math.round(s < 0 ? s * 0x80000000 : s * 0x7fffffff), o);
        }
      }
      o += bps;
    }
  }
  return buf;
}

const JUNK_SIZE = 28; // room for a ds64 chunk, so a file can turn into RF64 in place
const U32_MAX = 0xffffffff;

export interface WavWriterOptions {
  /**
   * Reserve room for RF64, so recordings can grow past 4 GB: a JUNK chunk that
   * becomes the ds64 chunk once the data no longer fits a 32-bit size.
   */
  rf64?: boolean;
  /**
   * Continue an existing file of the same format instead of starting a new one
   * (a partly written last frame is dropped).
   */
  append?: boolean;
  /** For tests: replaces fs.writeSync. */
  writeSync?: (fd: number, buf: Buffer, offset: number, length: number, position: number) => number;
}

function buildHeader(fmt: WavFormat, dataBytes: number, rf64 = false): Buffer {
  const blockAlign = fmt.channels * (fmt.bitDepth / 8);
  const fmtSize = fmt.float ? 18 : 16;
  const factSize = fmt.float ? 12 : 0;
  const junkSize = rf64 ? 8 + JUNK_SIZE : 0;
  const headerSize = 12 + junkSize + 8 + fmtSize + factSize + 8;
  const riffBytes = headerSize - 8 + dataBytes;
  const big = rf64 && riffBytes > U32_MAX;
  const frames = Math.floor(dataBytes / blockAlign);
  const h = Buffer.alloc(headerSize);
  let o = 0;
  h.write(big ? 'RF64' : 'RIFF', o); o += 4;
  h.writeUInt32LE(big ? U32_MAX : Math.min(U32_MAX, riffBytes), o); o += 4;
  h.write('WAVE', o); o += 4;
  if (rf64) {
    h.write(big ? 'ds64' : 'JUNK', o); o += 4;
    h.writeUInt32LE(JUNK_SIZE, o); o += 4;
    if (big) {
      h.writeBigUInt64LE(BigInt(riffBytes), o);
      h.writeBigUInt64LE(BigInt(dataBytes), o + 8);
      h.writeBigUInt64LE(BigInt(frames), o + 16);
      h.writeUInt32LE(0, o + 24); // no table
    }
    o += JUNK_SIZE;
  }
  h.write('fmt ', o); o += 4;
  h.writeUInt32LE(fmtSize, o); o += 4;
  h.writeUInt16LE(fmt.float ? FORMAT_FLOAT : FORMAT_PCM, o); o += 2;
  h.writeUInt16LE(fmt.channels, o); o += 2;
  h.writeUInt32LE(fmt.sampleRate, o); o += 4;
  h.writeUInt32LE(fmt.sampleRate * blockAlign, o); o += 4;
  h.writeUInt16LE(blockAlign, o); o += 2;
  h.writeUInt16LE(fmt.bitDepth, o); o += 2;
  if (fmt.float) {
    h.writeUInt16LE(0, o); o += 2; // cbSize
    h.write('fact', o); o += 4;
    h.writeUInt32LE(4, o); o += 4;
    h.writeUInt32LE(big ? U32_MAX : Math.min(U32_MAX, frames), o); o += 4;
  }
  h.write('data', o); o += 4;
  h.writeUInt32LE(big ? U32_MAX : Math.min(U32_MAX, dataBytes), o);
  return h;
}

/** Flushes a file's data (not necessarily its metadata) to the disk; ignored where unsupported. */
export function syncFd(fd: number): void {
  try {
    fs.fdatasyncSync(fd);
  } catch {
    try {
      fs.fsyncSync(fd);
    } catch {
      /* not supported here */
    }
  }
}

/** Makes a newly created or renamed file's directory entry durable (no-op where directories can't be opened). */
export function syncDir(dir: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    /* Windows can't open directories; NTFS journals the entry anyway */
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * Streams audio to disk. The header is rewritten periodically so that a file
 * from a crashed session is still playable up to the last patch.
 *
 * Audio that can't be written (disk full) stays queued: write() and flush()
 * throw, and the next flush() tries again, so nothing is lost while space is freed.
 */
export class WavWriter {
  readonly format: WavFormat;
  private fd: number;
  private headerSize: number;
  private dataBytes = 0;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private lastPatchBytes = 0;
  private closed = false;
  private rf64: boolean;
  private writeFn: NonNullable<WavWriterOptions['writeSync']>;
  /** Frames handed to write(), on disk or still queued. */
  framesWritten = 0;

  constructor(
    readonly path: string,
    channels: number,
    sampleRate: number,
    bitDepth: BitDepth = 24,
    private flushBytes = 64 * 1024,
    private patchIntervalBytes = 0,
    opts: WavWriterOptions = {},
  ) {
    const float = bitDepth === 32;
    this.format = { channels, sampleRate, bitDepth, float };
    this.rf64 = !!opts.rf64;
    this.writeFn = opts.writeSync ?? ((fd, buf, off, len, pos) => fs.writeSync(fd, buf, off, len, pos));
    if (opts.append && fs.existsSync(path)) {
      const info = repairWav(path);
      if (info.channels !== channels || info.sampleRate !== sampleRate || info.bitDepth !== bitDepth) {
        throw new Error(`${path} has a different format; can't continue it`);
      }
      this.fd = fs.openSync(path, 'r+');
      this.headerSize = info.dataOffset;
      this.dataBytes = info.frames * channels * (bitDepth / 8);
      this.lastPatchBytes = this.dataBytes;
      this.framesWritten = info.frames;
    } else {
      this.fd = fs.openSync(path, 'w');
      const header = buildHeader(this.format, 0, this.rf64);
      this.headerSize = header.length;
      fs.writeSync(this.fd, header, 0, header.length, 0);
    }
    if (!this.patchIntervalBytes) {
      // roughly once per second of audio
      this.patchIntervalBytes = sampleRate * channels * (bitDepth / 8);
    }
  }

  private get blockAlign(): number {
    return this.format.channels * (this.format.bitDepth / 8);
  }

  /** Frames that reached the file (the operating system's cache, at least). */
  get framesOnDisk(): number {
    return Math.floor(this.dataBytes / this.blockAlign);
  }

  /** Bytes accepted but not yet written. */
  get queuedBytes(): number {
    return this.pendingBytes;
  }

  /** Appends `frames` frames from planar channel data. */
  write(channels: Float32Array[], frames = channels[0]?.length ?? 0): void {
    if (this.closed) throw new Error('WavWriter is closed');
    if (channels.length !== this.format.channels) {
      throw new Error(`expected ${this.format.channels} channels, got ${channels.length}`);
    }
    if (frames <= 0) return;
    const buf = encodeInterleaved(channels, frames, this.format.bitDepth, this.format.float);
    this.pending.push(buf);
    this.pendingBytes += buf.length;
    this.framesWritten += frames;
    if (this.pendingBytes >= this.flushBytes) this.flush();
  }

  flush(): void {
    if (this.pendingBytes === 0) return;
    const all = this.pending.length === 1 ? this.pending[0] : Buffer.concat(this.pending, this.pendingBytes);
    let done = 0;
    try {
      while (done < all.length) {
        const n = this.writeFn(this.fd, all, done, all.length - done, this.headerSize + this.dataBytes);
        if (n <= 0) throw new Error('could not write to the recording file');
        done += n;
        this.dataBytes += n;
      }
    } finally {
      // keep whatever didn't make it, to try again
      const rest = done < all.length ? all.subarray(done) : null;
      this.pending = rest ? [rest] : [];
      this.pendingBytes = rest ? rest.length : 0;
    }
    if (this.dataBytes - this.lastPatchBytes >= this.patchIntervalBytes) this.patchHeader();
  }

  private patchHeader(): void {
    // only whole frames count, should a write have stopped in the middle of one
    const bytes = this.framesOnDisk * this.blockAlign;
    const header = buildHeader(this.format, bytes, this.rf64);
    fs.writeSync(this.fd, header, 0, header.length, 0);
    this.lastPatchBytes = this.dataBytes;
  }

  /** Writes what is queued, updates the header and forces both to the disk (survives power loss). */
  sync(): void {
    if (this.closed) return;
    try {
      this.flush();
    } finally {
      this.patchHeader();
      syncFd(this.fd);
    }
  }

  /** Finishes the file. Throws (and keeps the file open for another try) if queued audio can't be written. */
  close(): void {
    if (this.closed) return;
    this.flush();
    this.patchHeader();
    syncFd(this.fd);
    fs.closeSync(this.fd);
    this.closed = true;
  }

  /** Gives up on queued audio and closes the file with what is on disk. */
  abandon(): void {
    if (this.closed) return;
    this.pending = [];
    this.pendingBytes = 0;
    try {
      this.patchHeader();
      syncFd(this.fd);
    } catch {
      /* best effort */
    }
    fs.closeSync(this.fd);
    this.closed = true;
  }
}

/**
 * Repairs a WAV file a crash left behind: drops a partly written last frame and
 * writes a header that matches the audio on disk. Returns the file's format and length.
 */
export function repairWav(file: string): WavInfo {
  const fd = fs.openSync(file, 'r+');
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(size, 64 * 1024));
    fs.readSync(fd, head, 0, head.length, 0);
    const info = parseWavHeader(head, size, true);
    const blockAlign = info.channels * (info.bitDepth / 8);
    const dataBytes = info.frames * blockAlign;
    if (info.dataOffset + dataBytes < size) fs.ftruncateSync(fd, info.dataOffset + dataBytes);
    const fmt: WavFormat = { channels: info.channels, sampleRate: info.sampleRate, bitDepth: info.bitDepth, float: info.float };
    const hasRoom = head.toString('ascii', 12, 16) === 'JUNK' || head.toString('ascii', 12, 16) === 'ds64';
    const header = buildHeader(fmt, dataBytes, hasRoom);
    if (header.length === info.dataOffset) {
      fs.writeSync(fd, header, 0, header.length, 0);
    } else if (info.dataOffset + dataBytes - 8 <= U32_MAX) {
      // someone else's layout: patch just the two sizes
      const b = Buffer.alloc(4);
      b.writeUInt32LE(info.dataOffset + dataBytes - 8);
      fs.writeSync(fd, b, 0, 4, 4);
      b.writeUInt32LE(dataBytes);
      fs.writeSync(fd, b, 0, 4, info.dataOffset - 4);
    }
    syncFd(fd);
    return info;
  } finally {
    fs.closeSync(fd);
  }
}

/** Writes a complete file from planar float data. */
export function writeWavFile(path: string, channels: Float32Array[], sampleRate: number, bitDepth: BitDepth = 24): void {
  const w = new WavWriter(path, channels.length, sampleRate, bitDepth, 1 << 20);
  w.write(channels);
  w.close();
}

export interface WavInfo extends WavFormat {
  dataOffset: number;
  frames: number;
}

/**
 * Reads a WAV header (RIFF, or RF64/BW64 for files over 4 GB). With `trustFileSize`
 * the data runs to the end of the file whatever the header says, for files a crash left behind.
 */
export function parseWavHeader(head: Buffer, fileSize: number, trustFileSize = false): WavInfo {
  const riff = head.toString('ascii', 0, 4);
  if ((riff !== 'RIFF' && riff !== 'RF64' && riff !== 'BW64') || head.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let ds64Data: number | null = null;
  let o = 12;
  let fmt: Omit<WavFormat, 'bitDepth'> & { bitDepth: number } | null = null;
  while (o + 8 <= head.length) {
    const id = head.toString('ascii', o, o + 4);
    const size = head.readUInt32LE(o + 4);
    const body = o + 8;
    if (id === 'ds64' && size >= 24) {
      ds64Data = Number(head.readBigUInt64LE(body + 8));
    } else if (id === 'fmt ') {
      let tag = head.readUInt16LE(body);
      const channels = head.readUInt16LE(body + 2);
      const sampleRate = head.readUInt32LE(body + 4);
      const bitDepth = head.readUInt16LE(body + 14);
      if (tag === FORMAT_EXTENSIBLE && size >= 40) tag = head.readUInt16LE(body + 24);
      if (tag !== FORMAT_PCM && tag !== FORMAT_FLOAT) throw new Error(`unsupported WAV format tag ${tag}`);
      fmt = { channels, sampleRate, bitDepth, float: tag === FORMAT_FLOAT };
    } else if (id === 'data') {
      if (!fmt) throw new Error('data chunk before fmt chunk');
      if (![16, 24, 32].includes(fmt.bitDepth)) throw new Error(`unsupported bit depth ${fmt.bitDepth}`);
      if (fmt.float && fmt.bitDepth !== 32) throw new Error('only 32-bit float is supported');
      const blockAlign = fmt.channels * (fmt.bitDepth / 8);
      // Trust the actual file size over the header (crash recovery, >4 GB files).
      let dataBytes = fileSize - body;
      const declared = size === U32_MAX && ds64Data !== null ? ds64Data : size;
      if (!trustFileSize && declared > 0 && declared !== U32_MAX && declared < dataBytes) dataBytes = declared;
      return {
        ...fmt,
        bitDepth: fmt.bitDepth as BitDepth,
        dataOffset: body,
        frames: Math.floor(dataBytes / blockAlign),
      };
    }
    o = body + size + (size & 1);
  }
  throw new Error('no data chunk found in header');
}

export class WavReader {
  readonly info: WavInfo;
  private fd: number;
  private scratch = Buffer.alloc(0);

  constructor(readonly path: string) {
    this.fd = fs.openSync(path, 'r');
    const size = fs.fstatSync(this.fd).size;
    const head = Buffer.alloc(Math.min(size, 64 * 1024));
    fs.readSync(this.fd, head, 0, head.length, 0);
    this.info = parseWavHeader(head, size);
  }

  get frames(): number {
    return this.info.frames;
  }

  /**
   * Reads `count` frames starting at `start` into planar float arrays. Frames
   * outside the file are zero. Reuses `out` when it is large enough.
   */
  read(start: number, count: number, out?: Float32Array[]): Float32Array[] {
    const { channels, bitDepth, float, dataOffset, frames } = this.info;
    const result =
      out && out.length >= channels && out[0].length >= count
        ? out
        : Array.from({ length: channels }, () => new Float32Array(count));
    for (const ch of result) ch.fill(0, 0, count);
    const from = Math.max(0, start);
    const to = Math.min(frames, start + count);
    if (to <= from) return result;
    const bps = bitDepth / 8;
    const blockAlign = channels * bps;
    const bytes = (to - from) * blockAlign;
    if (this.scratch.length < bytes) this.scratch = Buffer.alloc(bytes);
    fs.readSync(this.fd, this.scratch, 0, bytes, dataOffset + from * blockAlign);
    const buf = this.scratch;
    let o = 0;
    const base = from - start;
    for (let i = 0; i < to - from; i++) {
      for (let c = 0; c < channels; c++) {
        let v: number;
        if (float) v = buf.readFloatLE(o);
        else if (bitDepth === 16) v = buf.readInt16LE(o) / 0x8000;
        else if (bitDepth === 24) v = buf.readIntLE(o, 3) / 0x800000;
        else v = buf.readInt32LE(o) / 0x80000000;
        result[c][base + i] = v;
        o += bps;
      }
    }
    return result;
  }

  close(): void {
    fs.closeSync(this.fd);
  }
}

export function readWavFile(path: string): { info: WavInfo; channels: Float32Array[] } {
  const r = new WavReader(path);
  try {
    return { info: r.info, channels: r.read(0, r.frames) };
  } finally {
    r.close();
  }
}
