// Minimal FLAC encoder (pure TypeScript): fixed linear predictors (order 0–4), partitioned Rice
// coding, left/right or mid/side stereo, Vorbis comments with chapters and an embedded cover.
// Not as small as libFLAC at -8, but lossless and a lot smaller than WAV.
import * as fs from 'node:fs';
import type { Chapter } from './chapters';
import { formatTimestamp } from '../shared/time';

export const FLAC_BLOCK = 4096;

class BitWriter {
  buf = new Uint8Array(1 << 16);
  len = 0; // bytes complete
  private acc = 0; // pending bits (msb first)
  private nacc = 0;

  private grow(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + extra) size *= 2;
    const n = new Uint8Array(size);
    n.set(this.buf.subarray(0, this.len));
    this.buf = n;
  }

  /** Writes the low `n` bits of `v` (n ≤ 32; v may exceed 2^31). */
  bits(v: number, n: number): void {
    if (n > 24) {
      this.bits(Math.floor(v / 0x1000000) & ((1 << (n - 24)) - 1), n - 24);
      this.bits(v % 0x1000000 >>> 0, 24);
      return;
    }
    this.grow(8);
    this.acc = (this.acc * (1 << n) + (v & ((1 << n) - 1))) >>> 0;
    this.nacc += n;
    while (this.nacc >= 8) {
      this.nacc -= 8;
      this.buf[this.len++] = (this.acc >>> this.nacc) & 0xff;
      this.acc &= (1 << this.nacc) - 1;
    }
  }

  /** `q` zero bits followed by a one. */
  unary(q: number): void {
    while (q >= 24) {
      this.bits(0, 24);
      q -= 24;
    }
    this.bits(1, q + 1);
  }

  signed(v: number, n: number): void {
    this.bits(v < 0 ? v + 2 ** n : v, n);
  }

  alignByte(): void {
    if (this.nacc) this.bits(0, 8 - this.nacc);
  }

  reset(): void {
    this.len = 0;
    this.acc = 0;
    this.nacc = 0;
  }
}

const CRC8 = new Uint8Array(256);
const CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  CRC8[i] = c;
  let d = i << 8;
  for (let k = 0; k < 8; k++) d = d & 0x8000 ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff;
  CRC16[i] = d;
}
function crc8(b: Uint8Array, from: number, to: number): number {
  let c = 0;
  for (let i = from; i < to; i++) c = CRC8[c ^ b[i]];
  return c;
}
function crc16(b: Uint8Array, from: number, to: number): number {
  let c = 0;
  for (let i = from; i < to; i++) c = ((c << 8) & 0xffff) ^ CRC16[(c >> 8) ^ b[i]];
  return c;
}

const zigzag = (r: number) => (r >= 0 ? 2 * r : -2 * r - 1);

/** Residual of the fixed predictor of `order` (0–4) for samples [order, n). */
function fixedResidual(x: Int32Array, n: number, order: number, out: Float64Array): void {
  for (let i = order; i < n; i++) {
    switch (order) {
      case 0: out[i] = x[i]; break;
      case 1: out[i] = x[i] - x[i - 1]; break;
      case 2: out[i] = x[i] - 2 * x[i - 1] + x[i - 2]; break;
      case 3: out[i] = x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3]; break;
      default: out[i] = x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4];
    }
  }
}

interface RicePlan {
  bits: number;
  partitionOrder: number;
  params: number[];
}

function riceBits(sum: number, count: number, k: number): number {
  // unary part ≈ sum >> k, plus 1 stop bit and k low bits per value
  return Math.floor(sum / 2 ** k) + count * (1 + k);
}

const MAX_PARTITION_ORDER = 6;

/** Best partition order (0–6) and Rice parameters for a residual. */
function planRice(res: Float64Array, n: number, order: number): RicePlan {
  // zigzag sums of the finest partitions that fit, then pairwise for coarser orders
  let top = 0;
  while (top < MAX_PARTITION_ORDER && n % (1 << (top + 1)) === 0 && n >> (top + 1) > order) top++;
  const per = n >> top;
  let sums: number[] = [];
  for (let j = 0; j < 1 << top; j++) {
    let sum = 0;
    for (let i = j === 0 ? order : j * per; i < (j + 1) * per; i++) {
      const r = res[i];
      sum += r >= 0 ? 2 * r : -2 * r - 1;
    }
    sums.push(sum);
  }
  let best: RicePlan | null = null;
  for (let p = top; p >= 0; p--) {
    const size = n >> p;
    let bits = 0;
    const params: number[] = [];
    sums.forEach((sum, j) => {
      const count = size - (j === 0 ? order : 0);
      const mean = count ? sum / count : 0;
      let k = mean > 1 ? Math.min(30, Math.floor(Math.log2(mean))) : 0;
      let b = riceBits(sum, count, k);
      for (const kk of [k - 1, k + 1]) {
        if (kk < 0 || kk > 30) continue;
        const bb = riceBits(sum, count, kk);
        if (bb < b) {
          b = bb;
          k = kk;
        }
      }
      params.push(k);
      bits += 5 + b;
    });
    if (!best || bits < best.bits) best = { bits, partitionOrder: p, params };
    const next: number[] = [];
    for (let j = 0; j < sums.length; j += 2) next.push(sums[j] + (sums[j + 1] ?? 0));
    sums = next;
  }
  return best!;
}

interface SubframePlan {
  order: number;
  rice: RicePlan;
  bits: number;
}

function planSubframe(x: Int32Array, n: number, bps: number, res: Float64Array[]): SubframePlan {
  let best: SubframePlan | null = null;
  for (let order = 0; order <= Math.min(4, n - 1); order++) {
    fixedResidual(x, n, order, res[order]);
    const rice = planRice(res[order], n, order);
    const bits = 8 + order * bps + 2 + 4 + rice.bits;
    if (!best || bits < best.bits) best = { order, rice, bits };
  }
  return best!;
}

function writeSubframe(w: BitWriter, x: Int32Array, n: number, bps: number, plan: SubframePlan, res: Float64Array): void {
  const verbatimBits = 8 + n * bps;
  if (plan.bits >= verbatimBits) {
    w.bits(0b00000010, 8); // VERBATIM
    for (let i = 0; i < n; i++) w.signed(x[i], bps);
    return;
  }
  w.bits(0b00010000 | (plan.order << 1), 8); // FIXED, order, no wasted bits
  for (let i = 0; i < plan.order; i++) w.signed(x[i], bps);
  w.bits(1, 2); // RICE2: 5-bit parameters
  w.bits(plan.rice.partitionOrder, 4);
  const parts = 1 << plan.rice.partitionOrder;
  const per = n / parts;
  for (let j = 0; j < parts; j++) {
    const k = plan.rice.params[j];
    w.bits(k, 5);
    const from = j === 0 ? plan.order : j * per;
    const to = (j + 1) * per;
    const div = 2 ** k;
    for (let i = from; i < to; i++) {
      const u = zigzag(res[i]);
      w.unary(Math.floor(u / div));
      if (k) w.bits(u % div, k);
    }
  }
}

function utf8Number(w: BitWriter, v: number): void {
  if (v < 0x80) return w.bits(v, 8);
  const bytes: number[] = [];
  let lead = 0xc0;
  let limit = 0x800;
  let extra = 1;
  while (v >= limit) {
    extra++;
    limit *= 32;
    lead = (lead >> 1) | 0x80;
  }
  let rest = v;
  for (let i = 0; i < extra; i++) {
    bytes.unshift(0x80 | (rest & 0x3f));
    rest = Math.floor(rest / 64);
  }
  w.bits(lead | rest, 8);
  for (const b of bytes) w.bits(b, 8);
}

export interface FlacTags {
  title?: string;
  artist?: string;
  album?: string;
  date?: string;
  track?: string;
  description?: string;
  genre?: string;
  chapters?: Chapter[];
  /** Front cover. */
  cover?: { mime: string; data: Buffer };
}

/** A Vorbis comment block (FLAC, and the body of Opus' OpusTags); `extra` entries are appended as they are. */
export function vorbisComment(tags: FlacTags, extra: string[] = []): Buffer {
  const entries: string[] = [];
  const add = (k: string, v?: string) => v && entries.push(`${k}=${v}`);
  add('TITLE', tags.title);
  add('ARTIST', tags.artist);
  add('ALBUM', tags.album);
  add('DATE', tags.date);
  add('TRACKNUMBER', tags.track);
  add('DESCRIPTION', tags.description);
  add('GENRE', tags.genre);
  // chapters in the CHAPTERxxx convention (read by many players and taggers)
  (tags.chapters ?? []).forEach((c, i) => {
    const id = `CHAPTER${String(i + 1).padStart(3, '0')}`;
    add(id, formatTimestamp(c.start));
    add(`${id}NAME`, c.title);
    add(`${id}URL`, c.url);
  });
  entries.push(...extra);
  const vendor = Buffer.from('WavePod', 'utf8');
  const parts: Buffer[] = [];
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  parts.push(u32(vendor.length), vendor, u32(entries.length));
  for (const e of entries) {
    const b = Buffer.from(e, 'utf8');
    parts.push(u32(b.length), b);
  }
  return Buffer.concat(parts);
}

/** A FLAC PICTURE block body (front cover); Opus carries it base64-encoded as METADATA_BLOCK_PICTURE. */
export function pictureBlock(cover: { mime: string; data: Buffer }): Buffer {
  const mime = Buffer.from(cover.mime, 'latin1');
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  // type 3 = front cover; width/height/depth/colours 0 = unknown
  return Buffer.concat([u32(3), u32(mime.length), mime, u32(0), u32(0), u32(0), u32(0), u32(0), u32(cover.data.length), cover.data]);
}

function blockHeader(type: number, last: boolean, length: number): Buffer {
  const b = Buffer.alloc(4);
  b[0] = (last ? 0x80 : 0) | type;
  b.writeUIntBE(length, 1, 3);
  return b;
}

const residualSet = () => Array.from({ length: 5 }, () => new Float64Array(FLAC_BLOCK));

/** Streams planar float audio into a FLAC file (16 or 24 bit, mono or stereo). */
export class FlacWriter {
  private fd: number;
  private pending: Int32Array[];
  private pendingLen = 0;
  private frameNo = 0;
  private total = 0;
  private minFrame = Infinity;
  private maxFrame = 0;
  private w = new BitWriter();
  /** Residuals per predictor order: left (or mono), right, mid, side. */
  private resL = residualSet();
  private resR = residualSet();
  private resM = residualSet();
  private resS = residualSet();
  private mid = new Int32Array(FLAC_BLOCK);
  private side = new Int32Array(FLAC_BLOCK);
  private streamInfoPos = 8;
  private readonly scale: number;

  constructor(
    readonly path: string,
    readonly channels: 1 | 2,
    readonly sampleRate: number,
    readonly bps: 16 | 24,
    tags: FlacTags = {},
  ) {
    this.scale = 2 ** (bps - 1);
    this.pending = Array.from({ length: channels }, () => new Int32Array(FLAC_BLOCK));
    this.fd = fs.openSync(path, 'w');
    const blocks: Array<[number, Buffer]> = [[0, Buffer.alloc(34)], [4, vorbisComment(tags)]];
    if (tags.cover) blocks.push([6, pictureBlock(tags.cover)]);
    blocks.push([1, Buffer.alloc(1024)]); // padding for later tag edits
    const out: Buffer[] = [Buffer.from('fLaC', 'latin1')];
    blocks.forEach(([type, data], i) => out.push(blockHeader(type, i === blocks.length - 1, data.length), data));
    fs.writeSync(this.fd, Buffer.concat(out));
  }

  write(src: Float32Array[], frames: number): void {
    const max = this.scale - 1;
    const min = -this.scale;
    for (let i = 0; i < frames; ) {
      const n = Math.min(frames - i, FLAC_BLOCK - this.pendingLen);
      for (let c = 0; c < this.channels; c++) {
        const s = src[Math.min(c, src.length - 1)];
        const d = this.pending[c];
        for (let k = 0; k < n; k++) {
          // same scaling as the WAV writer, so a FLAC and a WAV of one export hold identical samples
          const x = s[i + k];
          const v = Math.round(x < 0 ? x * this.scale : x * max);
          d[this.pendingLen + k] = v > max ? max : v < min ? min : v;
        }
      }
      this.pendingLen += n;
      i += n;
      if (this.pendingLen === FLAC_BLOCK) this.flushFrame();
    }
  }

  private flushFrame(): void {
    const n = this.pendingLen;
    if (!n) return;
    const w = this.w;
    w.reset();
    w.bits(0xfff8, 16); // sync, fixed block size
    const sizeCode = n === FLAC_BLOCK ? 12 : 7;
    const rateCode = this.sampleRate === 44100 ? 9 : this.sampleRate === 48000 ? 10 : this.sampleRate === 96000 ? 11 : 0;
    w.bits(sizeCode, 4);
    w.bits(rateCode, 4);
    const bpsCode = this.bps === 16 ? 4 : 6;
    let plans: SubframePlan[];
    let assignment: number;
    if (this.channels === 2) {
      const [l, r] = this.pending;
      for (let i = 0; i < n; i++) {
        this.side[i] = l[i] - r[i];
        this.mid[i] = (l[i] + r[i]) >> 1;
      }
      const pl = planSubframe(l, n, this.bps, this.resL);
      const pr = planSubframe(r, n, this.bps, this.resR);
      const pm = planSubframe(this.mid, n, this.bps, this.resM);
      const ps = planSubframe(this.side, n, this.bps + 1, this.resS);
      if (pm.bits + ps.bits < pl.bits + pr.bits) {
        assignment = 10;
        plans = [pm, ps];
      } else {
        assignment = 1;
        plans = [pl, pr];
      }
    } else {
      assignment = 0;
      plans = [planSubframe(this.pending[0], n, this.bps, this.resL)];
    }
    w.bits(assignment, 4);
    w.bits(bpsCode, 3);
    w.bits(0, 1);
    utf8Number(w, this.frameNo);
    if (sizeCode === 7) w.bits(n - 1, 16);
    w.bits(crc8(w.buf, 0, w.len), 8);
    if (assignment === 10) {
      writeSubframe(w, this.mid, n, this.bps, plans[0], this.resM[plans[0].order]);
      writeSubframe(w, this.side, n, this.bps + 1, plans[1], this.resS[plans[1].order]);
    } else if (assignment === 1) {
      writeSubframe(w, this.pending[0], n, this.bps, plans[0], this.resL[plans[0].order]);
      writeSubframe(w, this.pending[1], n, this.bps, plans[1], this.resR[plans[1].order]);
    } else {
      writeSubframe(w, this.pending[0], n, this.bps, plans[0], this.resL[plans[0].order]);
    }
    w.alignByte();
    const crc = crc16(w.buf, 0, w.len);
    w.bits(crc, 16);
    fs.writeSync(this.fd, w.buf, 0, w.len);
    this.minFrame = Math.min(this.minFrame, w.len);
    this.maxFrame = Math.max(this.maxFrame, w.len);
    this.total += n;
    this.frameNo++;
    this.pendingLen = 0;
  }

  /** Writes the last frame and fills in STREAMINFO. */
  close(): void {
    this.flushFrame();
    const si = Buffer.alloc(34);
    si.writeUInt16BE(FLAC_BLOCK, 0); // min block size (the last block may be shorter, which FLAC allows)
    si.writeUInt16BE(FLAC_BLOCK, 2);
    si.writeUIntBE(Number.isFinite(this.minFrame) ? this.minFrame : 0, 4, 3);
    si.writeUIntBE(this.maxFrame, 7, 3);
    // 20 bits sample rate, 3 bits channels-1, 5 bits bps-1, 36 bits total samples
    const hi = this.sampleRate * 16 + (this.channels - 1) * 2 + ((this.bps - 1) >> 4);
    si.writeUIntBE(hi, 10, 3);
    const totalHi = Math.floor(this.total / 2 ** 32) & 0xf;
    si[13] = (((this.bps - 1) & 0xf) << 4) | totalHi;
    si.writeUInt32BE(this.total >>> 0, 14);
    // MD5 left as zero: "not computed", which decoders accept
    fs.writeSync(this.fd, si, 0, 34, this.streamInfoPos);
    fs.closeSync(this.fd);
  }
}
