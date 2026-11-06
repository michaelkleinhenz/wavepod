import { describe, expect, it } from 'vitest';
import { decodeAiff, isAiff } from '../src/core/aiff';

/** 80-bit extended for integer sample rates. */
function extended(rate: number): number[] {
  const exp = Math.floor(Math.log2(rate));
  const mant = BigInt(Math.round(rate * 2 ** (63 - exp)));
  const out = [((exp + 16383) >> 8) & 0x7f, (exp + 16383) & 0xff];
  for (let i = 7; i >= 0; i--) out.push(Number((mant >> BigInt(i * 8)) & 0xffn));
  return out;
}

function chunk(id: string, body: number[]): number[] {
  const n = body.length;
  return [...id].map((c) => c.charCodeAt(0)).concat([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255], body, n & 1 ? [0] : []);
}

function u16(n: number) {
  return [(n >> 8) & 255, n & 255];
}
function u32(n: number) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

function aiff(opts: { channels: number; bits: number; rate: number; samples: number[]; aifc?: string; little?: boolean }): ArrayBuffer {
  const bytes = Math.ceil(opts.bits / 8);
  const frames = opts.samples.length / opts.channels;
  const data: number[] = [];
  for (const s of opts.samples) {
    const v = Math.round(s * 2 ** (bytes * 8 - 1));
    const be: number[] = [];
    for (let i = bytes - 1; i >= 0; i--) be.push((v >> (i * 8)) & 255);
    data.push(...(opts.little ? be.reverse() : be));
  }
  const comm = [...u16(opts.channels), ...u32(frames), ...u16(opts.bits), ...extended(opts.rate)];
  if (opts.aifc) comm.push(...[...opts.aifc].map((c) => c.charCodeAt(0)), 0);
  const body = [...(opts.aifc ? 'AIFC' : 'AIFF')].map((c) => c.charCodeAt(0)).concat(chunk('COMM', comm), chunk('SSND', [...u32(0), ...u32(0), ...data]));
  return new Uint8Array([...'FORM'].map((c) => c.charCodeAt(0)).concat(u32(body.length), body)).buffer;
}

describe('AIFF decoding', () => {
  it('recognises AIFF and AIFF-C, not WAV', () => {
    expect(isAiff(aiff({ channels: 1, bits: 16, rate: 44100, samples: [0] }))).toBe(true);
    expect(isAiff(aiff({ channels: 1, bits: 16, rate: 44100, samples: [0], aifc: 'NONE' }))).toBe(true);
    expect(isAiff(new TextEncoder().encode('RIFF....WAVEfmt ').buffer)).toBe(false);
  });

  it('reads 16-bit stereo with its sample rate', () => {
    const a = decodeAiff(aiff({ channels: 2, bits: 16, rate: 48000, samples: [0.5, -0.5, 0.25, -0.25] }));
    expect(a.sampleRate).toBe(48000);
    expect(a.channels).toHaveLength(2);
    expect(Array.from(a.channels[0])).toEqual([0.5, 0.25]);
    expect(Array.from(a.channels[1])).toEqual([-0.5, -0.25]);
  });

  it('reads 24-bit mono at 44.1 kHz', () => {
    const a = decodeAiff(aiff({ channels: 1, bits: 24, rate: 44100, samples: [0.5, -0.75, 0] }));
    expect(a.sampleRate).toBe(44100);
    expect(Array.from(a.channels[0])).toEqual([0.5, -0.75, 0]);
  });

  it("reads little-endian AIFF-C ('sowt')", () => {
    const a = decodeAiff(aiff({ channels: 1, bits: 16, rate: 44100, samples: [0.5, -0.5], aifc: 'sowt', little: true }));
    expect(Array.from(a.channels[0])).toEqual([0.5, -0.5]);
  });

  it('rejects compressed AIFF-C', () => {
    expect(() => decodeAiff(aiff({ channels: 1, bits: 16, rate: 44100, samples: [0], aifc: 'ima4' }))).toThrow(/not supported/);
  });
});
