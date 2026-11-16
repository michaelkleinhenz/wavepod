import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFx } from '../src/core/fx/definitions';
import { factoryPresets } from '../src/core/fx/presets';
import { createProcessor } from '../src/core/fx/processors';
import { SpeechRestore } from '../src/core/fx/restore';
import { Biquad } from '../src/core/fx/biquad';
import { fft } from '../src/core/fft';
import { Resampler } from '../src/core/opus';
import { readWavFile } from '../src/core/wav';

const SR = 48000;

function speech(): Float32Array {
  const { info, channels } = readWavFile(path.join(__dirname, 'fixtures/jfk-speech.wav'));
  return new Resampler(info.sampleRate, SR, 1).process([channels[0]], channels[0].length)[0];
}

/**
 * A full-band synthetic voice: a gliding 100–160 Hz pitch with harmonics up to 20 kHz falling
 * like the long-term spectrum of speech, spoken in syllables, with "s" noise now and then.
 */
function synthVoice(seconds: number): Float32Array {
  const y = new Float32Array(SR * seconds);
  let s = 7;
  const rnd = () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return (s / 2 ** 32) * 2 - 1;
  };
  const hiss = new Biquad('highpass', 4000, SR, 0.7);
  let phase = 0;
  for (let i = 0; i < y.length; i++) {
    const t = i / SR;
    const f0 = 130 + 30 * Math.sin(2 * Math.PI * 0.7 * t);
    phase += f0 / SR;
    const syl = Math.max(0, Math.sin(2 * Math.PI * 4 * t)) ** 0.5;
    let v = 0;
    for (let h = 1; h * f0 < 20000; h++) v += Math.sin(2 * Math.PI * h * phase) * Math.pow(Math.min(1, 500 / (h * f0)), 1.1);
    const fric = t % 1.5 > 1.3 ? hiss.tick(rnd(), 0) * 0.05 : 0;
    y[i] = 0.02 * v * syl + fric;
  }
  return y;
}

/** 8th-order Butterworth filters, like a phone line or a call codec. */
function band(x: Float32Array, edges: Array<['highpass' | 'lowpass', number]>): Float32Array {
  const y = Float32Array.from(x);
  for (const [kind, f] of edges) {
    for (const q of [0.5098, 0.6013, 0.9, 2.5629]) new Biquad(kind, f, SR, q).process(y, y.length, 0);
  }
  return y;
}

/** Speech through a phone line: 300 Hz–3.4 kHz, with the steep edges of a codec. */
const phone = (x: Float32Array) => band(x, [['highpass', 300], ['highpass', 300], ['lowpass', 3400], ['lowpass', 3400], ['lowpass', 3400]]);

/** A wide-band call: 7 kHz, again with a codec's steep edge. */
const call = (x: Float32Array) => band(x, [['lowpass', 7000], ['lowpass', 7000], ['lowpass', 7000], ['lowpass', 7000]]);

function run(x: Float32Array, params: Record<string, number> = {}): { y: Float32Array; p: SpeechRestore } {
  const p = new SpeechRestore(SR);
  p.setParams({ ...createFx('restore').params, ...params });
  const L = Float32Array.from(x);
  const R = Float32Array.from(x);
  for (let i = 0; i < L.length; i += 480) {
    const n = Math.min(480, L.length - i);
    p.process(L.subarray(i, i + n), R.subarray(i, i + n), n);
  }
  return { y: L, p };
}

/** Energy (dB) between f1 and f2 over the whole signal, from 4096-point frames. */
function bandDb(x: Float32Array, f1: number, f2: number, from = 0): number {
  const N = 4096;
  let s = 0;
  for (let o = Math.round(from * SR); o + N <= x.length; o += N) {
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[o + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
    fft(re, im);
    for (let k = Math.ceil((f1 * N) / SR); k <= Math.floor((f2 * N) / SR); k++) s += re[k] * re[k] + im[k] * im[k];
  }
  return 10 * Math.log10(s + 1e-30);
}

describe('Speech restoration', () => {
  const voice = speech();
  const full = synthVoice(8);

  it('finds the band limits of a phone line and of a video call', () => {
    const tel = run(phone(full)).p;
    expect(Math.abs(tel.high - 3400)).toBeLessThan(400);
    expect(Math.abs(tel.low - 300)).toBeLessThan(100);
    // a wide-band call: cut at 7 kHz, but the lows are all there
    const wide = run(call(full)).p;
    expect(Math.abs(wide.high - 7000)).toBeLessThan(600);
    expect(wide.low).toBe(0);
  });

  it('rebuilds the missing highs and lows of a phone call close to the original', () => {
    const tel = phone(full);
    const { y, p } = run(tel);
    expect(Math.abs(p.high - 3400)).toBeLessThan(400);
    expect(p.low).toBeGreaterThan(0);
    const start = 3; // after the limits are found
    const orig = { hi: bandDb(full, 4500, 8000, start), lo: bandDb(full, 100, 200, start), mid: bandDb(full, 500, 3000, start) };
    const before = { hi: bandDb(tel, 4500, 8000, start), lo: bandDb(tel, 100, 200, start) };
    const after = { hi: bandDb(y, 4500, 8000, start), lo: bandDb(y, 100, 200, start), mid: bandDb(y, 500, 3000, start) };
    // the phone line took 30 dB and more away
    expect(orig.hi - before.hi).toBeGreaterThan(30);
    expect(orig.lo - before.lo).toBeGreaterThan(20);
    // back to near the original level, not beyond it
    expect(after.hi).toBeGreaterThan(orig.hi - 8);
    expect(after.hi).toBeLessThan(orig.hi + 3);
    expect(after.lo).toBeGreaterThan(orig.lo - 8);
    expect(after.lo).toBeLessThan(orig.lo + 3);
    // the voice that was there stays as it was
    expect(Math.abs(after.mid - orig.mid)).toBeLessThan(1.5);
  });

  it('adds the air above a video call', () => {
    const wide = call(full);
    const { y, p } = run(wide);
    expect(Math.abs(p.high - 7000)).toBeLessThan(600);
    const orig = bandDb(full, 8000, 14000, 3);
    expect(bandDb(wide, 8000, 14000, 3)).toBeLessThan(orig - 25);
    expect(bandDb(y, 8000, 14000, 3)).toBeGreaterThan(orig - 8);
    expect(bandDb(y, 8000, 14000, 3)).toBeLessThan(orig + 3);
  });

  it('works on real speech through a phone line', () => {
    const tel = phone(voice);
    const { y, p } = run(tel);
    // this old recording's own highs already fade from 2 kHz, so the edge is found a little lower
    expect(p.high).toBeGreaterThan(2700);
    expect(p.high).toBeLessThan(3800);
    expect(Math.abs(p.low - 300)).toBeLessThan(100);
    expect(bandDb(y, 4500, 8000, 3)).toBeGreaterThan(bandDb(tel, 4500, 8000, 3) + 15);
    expect(Math.abs(bandDb(y, 500, 3000) - bandDb(tel, 500, 3000))).toBeLessThan(1.5);
  });

  it('follows the level of the highs setting', () => {
    const tel = phone(full);
    const soft = bandDb(run(tel, { source: 1, highs: -6 }).y, 4000, 7500);
    const loud = bandDb(run(tel, { source: 1, highs: 4 }).y, 4000, 7500);
    expect(loud - soft).toBeGreaterThan(7);
    expect(loud - soft).toBeLessThan(13);
    // off: nothing is added up there
    const off = bandDb(run(tel, { source: 1, highs: -18, lows: -18 }).y, 4000, 7500);
    expect(off).toBeLessThan(bandDb(tel, 4000, 7500) + 0.5);
  });

  it('leaves a full-band voice alone', () => {
    // white-ish full-band signal: nothing is missing, so nothing is added
    let s = 1;
    const x = new Float32Array(SR * 4).map(() => {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      return ((s / 2 ** 32) * 2 - 1) * 0.1;
    });
    const { y, p } = run(x);
    expect(p.high).toBe(0);
    expect(p.low).toBe(0);
    for (let i = 0; i < x.length; i++) expect(y[i]).toBe(x[i]);
  });

  it('can play only what it adds', () => {
    const tel = phone(full);
    const { y } = run(tel, { source: 1, output: 1 });
    expect(bandDb(y, 500, 2500)).toBeLessThan(bandDb(tel, 500, 2500) - 15);
    expect(bandDb(y, 4000, 7500)).toBeGreaterThan(bandDb(tel, 4000, 7500) + 15);
  });

  it('is wired up as a filter with presets', () => {
    expect(createProcessor('restore', SR).latency).toBe(0);
    const names = factoryPresets('restore').map((e) => e.preset.name);
    expect(names).toContain('Phone call');
    expect(names.length).toBeGreaterThanOrEqual(5);
  });
});
