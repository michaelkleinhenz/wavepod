// Opus export: libopus (WASM, via opusscript) in an Ogg container written here, with Vorbis-style
// tags, CHAPTERxxx chapters and the cover as METADATA_BLOCK_PICTURE. Opus runs at 48 kHz, so other
// project rates are resampled on the way in.
import * as fs from 'node:fs';
import OpusScript from 'opusscript';
import { pictureBlock, vorbisComment, type FlacTags } from './flac';

const OPUS_RATE = 48000;
/** 20 ms frames. */
const FRAME = 960;
/** Encoder lookahead at 48 kHz (what libopus reports for the AUDIO application); decoders skip it. */
const PRE_SKIP = 312;
const OPUS_SET_BITRATE = 4002;
const OPUS_SET_SIGNAL = 4024;
const OPUS_SIGNAL_MUSIC = 3002;

// ---------------------------------------------------------------- Ogg pages

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

export function oggCrc(buf: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ buf[i]) & 0xff]) >>> 0;
  return crc >>> 0;
}

/** Writes Ogg pages for one logical stream. Packets may be any size; large ones span pages. */
export class OggStream {
  private seq = 0;
  private segments: number[] = [];
  private body: Buffer[] = [];
  private granule = -1n;
  private first = true;

  constructor(private fd: number, private serial: number) {}

  /** Adds a packet; `granule` is the stream position after it (-1 for none). */
  packet(data: Buffer, granule: bigint): void {
    let left = data.length;
    let at = 0;
    for (;;) {
      // a full page: at a packet boundary it is a normal page, inside a packet the next one continues it
      if (this.segments.length === 255) this.flush(false, at > 0);
      const seg = Math.min(255, left);
      this.segments.push(seg);
      this.body.push(data.subarray(at, at + seg));
      at += seg;
      left -= seg;
      // a packet ends with a segment shorter than 255 (possibly 0)
      if (seg < 255) break;
    }
    this.granule = granule;
  }

  /** Writes out what is buffered as a page. */
  flush(eos = false, continued = false): void {
    if (!this.segments.length && !eos) return;
    const continuing = this.continuedNext;
    this.continuedNext = continued;
    const header = Buffer.alloc(27 + this.segments.length);
    header.write('OggS', 0, 'latin1');
    header[4] = 0;
    header[5] = (continuing ? 1 : 0) | (this.first ? 2 : 0) | (eos ? 4 : 0);
    // a page that ends inside a packet has no granule position of its own
    header.writeBigInt64LE(continued ? -1n : this.granule, 6);
    header.writeUInt32LE(this.serial, 14);
    header.writeUInt32LE(this.seq++, 18);
    header.writeUInt32LE(0, 22);
    header[26] = this.segments.length;
    for (let i = 0; i < this.segments.length; i++) header[27 + i] = this.segments[i];
    const page = Buffer.concat([header, ...this.body]);
    page.writeUInt32LE(oggCrc(page), 22);
    fs.writeSync(this.fd, page);
    this.first = false;
    this.segments = [];
    this.body = [];
  }

  private continuedNext = false;
}

// ---------------------------------------------------------------- resampling

/** Kernel phases per input sample in the resampler's weight table (linearly interpolated between). */
const PHASES = 256;

/** Streaming windowed-sinc resampler (any channel count), good enough to bring 44.1 kHz speech to 48 kHz. */
export class Resampler {
  private readonly ratio: number;
  private readonly taps = 16;
  private hist: Float32Array[];
  /** Position of the next output sample, in input samples relative to hist start. */
  private pos: number;
  /** Normalised kernel weights: row p (taps values) for the fractional position p / PHASES. */
  private readonly table: Float32Array;

  constructor(inRate: number, outRate: number, private channels: number) {
    this.ratio = inRate / outRate;
    this.hist = Array.from({ length: channels }, () => new Float32Array(this.taps));
    this.pos = this.taps / 2;
    // Hann-windowed sinc, lowpass at the lower Nyquist when going down in rate. Computed once: per
    // output sample only a table lookup is left, shared by all channels.
    const half = this.taps / 2;
    const cutoff = Math.min(1, 1 / this.ratio);
    this.table = new Float32Array((PHASES + 1) * this.taps);
    for (let p = 0; p <= PHASES; p++) {
      const frac = p / PHASES;
      let norm = 0;
      const row = this.table.subarray(p * this.taps, (p + 1) * this.taps);
      for (let k = -half + 1; k <= half; k++) {
        const x = k - frac;
        const w = 0.5 + 0.5 * Math.cos((Math.PI * x) / half);
        const g = w * (x === 0 ? 1 : Math.sin(Math.PI * x * cutoff) / (Math.PI * x * cutoff));
        row[k + half - 1] = g;
        norm += g;
      }
      for (let t = 0; t < this.taps; t++) row[t] /= norm;
    }
  }

  /** Resamples `n` frames; returns the output frames. */
  process(input: Float32Array[], n: number): Float32Array[] {
    const taps = this.taps;
    const half = taps / 2;
    // the working buffer: history then the new block
    const buf = this.hist.map((h, c) => {
      const b = new Float32Array(h.length + n);
      b.set(h);
      b.set(input[c].subarray(0, n), h.length);
      return b;
    });
    const len = buf[0].length;
    const count = Math.max(0, Math.ceil((len - half - this.pos) / this.ratio) + 1);
    const out = Array.from({ length: this.channels }, () => new Float32Array(count));
    const weights = new Float32Array(taps);
    const table = this.table;
    let produced = 0;
    while (this.pos + half < len) {
      const base = Math.floor(this.pos);
      const ph = (this.pos - base) * PHASES;
      const p0 = Math.floor(ph);
      const t = ph - p0;
      const r0 = p0 * taps;
      const r1 = r0 + taps;
      for (let k = 0; k < taps; k++) weights[k] = table[r0 + k] + (table[r1 + k] - table[r0 + k]) * t;
      const first = base - half + 1;
      for (let c = 0; c < this.channels; c++) {
        const b = buf[c];
        let acc = 0;
        for (let k = 0; k < taps; k++) acc += b[first + k] * weights[k];
        out[c][produced] = acc;
      }
      produced++;
      this.pos += this.ratio;
    }
    // keep the last `taps` samples as history
    const keepFrom = len - taps;
    this.hist = buf.map((b) => b.slice(keepFrom));
    this.pos -= keepFrom;
    return out.map((o) => (produced === o.length ? o : o.slice(0, produced)));
  }
}

// ---------------------------------------------------------------- writer

export class OpusWriter {
  readonly path: string;
  private fd: number;
  private ogg: OggStream;
  private enc: OpusScript;
  private resampler: Resampler | null;
  private pcm: Int16Array;
  private fill = 0;
  /** 48 kHz samples taken in, and encoded (incl. padding). */
  private samplesIn = 0;
  private samplesEncoded = 0;
  private sinceFlush = 0;

  constructor(path: string, inputRate: number, bitrateKbps: number, tags: FlacTags, readonly channels: 1 | 2 = 2) {
    this.path = path;
    this.pcm = new Int16Array(FRAME * channels);
    this.fd = fs.openSync(path, 'w');
    this.ogg = new OggStream(this.fd, (Math.random() * 0xffffffff) >>> 0);
    this.enc = new OpusScript(OPUS_RATE, channels, OpusScript.Application.AUDIO);
    this.enc.encoderCTL(OPUS_SET_BITRATE, Math.round(bitrateKbps * 1000));
    this.enc.encoderCTL(OPUS_SET_SIGNAL, OPUS_SIGNAL_MUSIC);
    this.resampler = inputRate === OPUS_RATE ? null : new Resampler(inputRate, OPUS_RATE, channels);

    const head = Buffer.alloc(19);
    head.write('OpusHead', 0, 'latin1');
    head[8] = 1; // version
    head[9] = channels;
    head.writeUInt16LE(PRE_SKIP, 10);
    head.writeUInt32LE(inputRate, 12);
    head.writeInt16LE(0, 16); // output gain
    head[18] = 0; // mapping family: mono/stereo
    this.ogg.packet(head, 0n);
    this.ogg.flush();
    const extra = tags.cover ? [`METADATA_BLOCK_PICTURE=${pictureBlock(tags.cover).toString('base64')}`] : [];
    this.ogg.packet(Buffer.concat([Buffer.from('OpusTags', 'latin1'), vorbisComment(tags, extra)]), 0n);
    this.ogg.flush();
  }

  /** Takes `n` frames at the input rate (one array per channel), float −1…1. */
  write(src: Float32Array[], n: number): void {
    const ch = this.channels;
    let x = ch === 1 ? [src[0]] : [src[0], src[1] ?? src[0]];
    let count = n;
    if (this.resampler) {
      x = this.resampler.process(x, n);
      count = x[0].length;
    }
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < ch; c++) this.pcm[this.fill * ch + c] = toI16(x[c][i]);
      this.samplesIn++;
      if (++this.fill === FRAME) this.encodeFrame();
    }
  }

  private encodeFrame(): void {
    const packet = this.enc.encode(Buffer.from(this.pcm.buffer, this.pcm.byteOffset, this.pcm.byteLength), FRAME);
    this.samplesEncoded += FRAME;
    this.fill = 0;
    this.ogg.packet(packet, BigInt(PRE_SKIP + this.samplesEncoded));
    // about one page per second
    if (++this.sinceFlush >= 50) {
      this.ogg.flush();
      this.sinceFlush = 0;
    }
  }

  close(): void {
    // pad the last frame plus the encoder's lookahead with silence so nothing is cut off
    const total = this.samplesIn;
    let pad = PRE_SKIP + (FRAME - this.fill) % FRAME;
    while (pad > 0 || this.fill > 0) {
      for (let c = 0; c < this.channels; c++) this.pcm[this.fill * this.channels + c] = 0;
      pad--;
      if (++this.fill === FRAME) {
        const packet = this.enc.encode(Buffer.from(this.pcm.buffer, this.pcm.byteOffset, this.pcm.byteLength), FRAME);
        this.samplesEncoded += FRAME;
        this.fill = 0;
        // the last granule marks the real end; players drop the padding after it
        this.ogg.packet(packet, BigInt(PRE_SKIP + Math.min(this.samplesEncoded, total)));
      }
    }
    this.ogg.flush(true);
    fs.closeSync(this.fd);
    this.enc.delete();
  }
}

function toI16(s: number): number {
  if (s > 1) s = 1;
  else if (s < -1) s = -1;
  return s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
}
