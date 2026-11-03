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

function buildHeader(fmt: WavFormat, dataBytes: number): Buffer {
  const blockAlign = fmt.channels * (fmt.bitDepth / 8);
  const fmtSize = fmt.float ? 18 : 16;
  const factSize = fmt.float ? 12 : 0;
  const headerSize = 12 + 8 + fmtSize + factSize + 8;
  const h = Buffer.alloc(headerSize);
  let o = 0;
  h.write('RIFF', o); o += 4;
  h.writeUInt32LE(Math.min(0xffffffff, headerSize - 8 + dataBytes), o); o += 4;
  h.write('WAVE', o); o += 4;
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
    h.writeUInt32LE(Math.floor(dataBytes / blockAlign), o); o += 4;
  }
  h.write('data', o); o += 4;
  h.writeUInt32LE(Math.min(0xffffffff, dataBytes), o);
  return h;
}

/**
 * Streams audio to disk. The header is rewritten periodically so that a file
 * from a crashed session is still playable up to the last patch.
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
  framesWritten = 0;

  constructor(
    readonly path: string,
    channels: number,
    sampleRate: number,
    bitDepth: BitDepth = 24,
    private flushBytes = 64 * 1024,
    private patchIntervalBytes = 0,
  ) {
    const float = bitDepth === 32;
    this.format = { channels, sampleRate, bitDepth, float };
    this.fd = fs.openSync(path, 'w');
    const header = buildHeader(this.format, 0);
    this.headerSize = header.length;
    fs.writeSync(this.fd, header, 0, header.length, 0);
    if (!this.patchIntervalBytes) {
      // roughly once per second of audio
      this.patchIntervalBytes = sampleRate * channels * (bitDepth / 8);
    }
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
    const all = Buffer.concat(this.pending, this.pendingBytes);
    fs.writeSync(this.fd, all, 0, all.length, this.headerSize + this.dataBytes);
    this.dataBytes += all.length;
    this.pending = [];
    this.pendingBytes = 0;
    if (this.dataBytes - this.lastPatchBytes >= this.patchIntervalBytes) this.patchHeader();
  }

  private patchHeader(): void {
    const header = buildHeader(this.format, this.dataBytes);
    fs.writeSync(this.fd, header, 0, header.length, 0);
    this.lastPatchBytes = this.dataBytes;
  }

  close(): void {
    if (this.closed) return;
    this.flush();
    this.patchHeader();
    fs.closeSync(this.fd);
    this.closed = true;
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

export function parseWavHeader(head: Buffer, fileSize: number): WavInfo {
  if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let o = 12;
  let fmt: Omit<WavFormat, 'bitDepth'> & { bitDepth: number } | null = null;
  while (o + 8 <= head.length) {
    const id = head.toString('ascii', o, o + 4);
    const size = head.readUInt32LE(o + 4);
    const body = o + 8;
    if (id === 'fmt ') {
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
      if (size > 0 && size !== 0xffffffff && size < dataBytes) dataBytes = size;
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
