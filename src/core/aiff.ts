// AIFF / AIFF-C decoding. Chromium's decoder (decodeAudioData) does not read AIFF, which is
// common on the Mac (Logic, GarageBand, many sound effect libraries), so it is parsed here.
// Supports uncompressed PCM (8/16/24/32-bit, big- or little-endian 'sowt') and 32/64-bit float.

export interface AiffAudio {
  sampleRate: number;
  channels: Float32Array[];
}

/** Whether the bytes start like an AIFF or AIFF-C file. */
export function isAiff(data: ArrayBuffer): boolean {
  if (data.byteLength < 12) return false;
  const b = new Uint8Array(data, 0, 12);
  const id = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  return id(0) === 'FORM' && (id(8) === 'AIFF' || id(8) === 'AIFC');
}

/** 80-bit IEEE 754 extended precision (big-endian), as used for the AIFF sample rate. */
function readExtended(v: DataView, o: number): number {
  const exp = v.getUint16(o) & 0x7fff;
  const sign = v.getUint16(o) & 0x8000 ? -1 : 1;
  const hi = v.getUint32(o + 2);
  const lo = v.getUint32(o + 6);
  if (exp === 0 && hi === 0 && lo === 0) return 0;
  return sign * (hi * 2 ** (exp - 16383 - 31) + lo * 2 ** (exp - 16383 - 63));
}

export function decodeAiff(data: ArrayBuffer): AiffAudio {
  if (!isAiff(data)) throw new Error('Not an AIFF file');
  const v = new DataView(data);
  const aifc = String.fromCharCode(...new Uint8Array(data, 8, 4)) === 'AIFC';
  let comm: { channels: number; frames: number; bits: number; rate: number; compression: string } | null = null;
  let ssnd: { start: number; size: number } | null = null;
  let o = 12;
  const end = Math.min(data.byteLength, 8 + v.getUint32(4));
  while (o + 8 <= end) {
    const id = String.fromCharCode(...new Uint8Array(data, o, 4));
    const size = v.getUint32(o + 4);
    const body = o + 8;
    if (id === 'COMM') {
      comm = {
        channels: v.getUint16(body),
        frames: v.getUint32(body + 2),
        bits: v.getUint16(body + 6),
        rate: readExtended(v, body + 8),
        compression: aifc && size >= 22 ? String.fromCharCode(...new Uint8Array(data, body + 18, 4)) : 'NONE',
      };
    } else if (id === 'SSND') {
      const offset = v.getUint32(body);
      // a file cut short while recording: take what is there
      ssnd = { start: body + 8 + offset, size: Math.min(size - 8 - offset, data.byteLength - (body + 8 + offset)) };
    }
    o = body + size + (size & 1);
  }
  if (!comm) throw new Error('AIFF file has no format chunk');
  if (!ssnd) throw new Error('AIFF file has no sound data');
  const { channels: nch, bits, rate, compression } = comm;
  if (!nch || !rate) throw new Error('AIFF file has an invalid format');
  const comp = compression.toLowerCase();
  const float = comp === 'fl32' || comp === 'fl64';
  const little = comp === 'sowt';
  if (comp !== 'none' && comp !== 'twos' && !float && !little) throw new Error(`Compressed AIFF-C (${compression.trim()}) is not supported`);
  const bytes = float ? (comp === 'fl64' ? 8 : 4) : Math.ceil(bits / 8);
  if (!float && (bytes < 1 || bytes > 4)) throw new Error(`${bits}-bit AIFF is not supported`);
  const frames = Math.min(comm.frames, Math.floor(ssnd.size / (bytes * nch)));
  const out = Array.from({ length: nch }, () => new Float32Array(frames));
  const scale = 1 / 2 ** (bytes * 8 - 1);
  let p = ssnd.start;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++, p += bytes) {
      let s: number;
      if (comp === 'fl32') s = v.getFloat32(p);
      else if (comp === 'fl64') s = v.getFloat64(p);
      else if (bytes === 1) s = v.getInt8(p) * scale;
      else if (bytes === 2) s = v.getInt16(p, little) * scale;
      else if (bytes === 3) {
        const [a, b, d] = little ? [v.getUint8(p + 2), v.getUint8(p + 1), v.getUint8(p)] : [v.getUint8(p), v.getUint8(p + 1), v.getUint8(p + 2)];
        s = (((a << 24) | (b << 16) | (d << 8)) >> 8) * scale;
      } else s = v.getInt32(p, little) * scale;
      out[c][i] = s;
    }
  }
  return { sampleRate: rate, channels: out };
}
