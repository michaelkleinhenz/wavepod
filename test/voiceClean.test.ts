import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFx, fxDefinition } from '../src/core/fx/definitions';
import { factoryPresets } from '../src/core/fx/presets';
import { createProcessor } from '../src/core/fx/processors';
import { VoiceClean, voiceCleanAvailable } from '../src/core/fx/voiceClean';
import { Resampler } from '../src/core/opus';
import { readWavFile } from '../src/core/wav';

const SR = 48000;

/** 4.8 s of real speech (public domain), at 48 kHz. */
function speech(): Float32Array {
  const { info, channels } = readWavFile(path.join(__dirname, 'fixtures/jfk-speech.wav'));
  const r = new Resampler(info.sampleRate, SR, 1);
  return r.process([channels[0]], channels[0].length)[0];
}

function lcg(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) >>> 0;
    return (s / 2 ** 32) * 2 - 1;
  };
}

/** Fan-like noise: rumble, hiss and a 100 Hz hum. */
function fan(n: number, seed = 5): Float32Array {
  const rnd = lcg(seed);
  let b = 0;
  let c = 0;
  return Float32Array.from({ length: n }, (_, i) => {
    const w = rnd();
    b = 0.98 * b + w * 0.2;
    c = 0.6 * c + w;
    return b + 0.3 * c + 0.2 * Math.sin((2 * Math.PI * 100 * i) / SR);
  });
}

/** A room: the direct sound plus an exponentially decaying diffuse tail with the given RT60. */
function room(x: Float32Array, rt60: number): Float32Array {
  const rnd = lcg(9);
  const len = Math.floor(rt60 * SR * 1.2);
  const h = new Float32Array(len);
  h[0] = 1;
  let lp = 0;
  for (let i = Math.floor(0.003 * SR); i < len; i++) {
    lp = 0.7 * lp + 0.3 * rnd();
    h[i] = 0.06 * lp * Math.exp((-6.9 / rt60 / SR) * i);
  }
  // FFT-free convolution, sparse enough for a test: one reflection per millisecond, scaled to
  // the energy of the full tail
  const step = 48;
  const y = Float32Array.from(x);
  for (let j = Math.floor(0.003 * SR); j < len; j += step) {
    const c = h[j] * Math.sqrt(step);
    for (let i = j; i < x.length; i++) y[i] += c * x[i - j];
  }
  return y;
}

/** Speech, a pause, speech again, … */
function withPauses(s: Float32Array, times: number, pause = 0.6): { x: Float32Array; pauses: Array<[number, number]> } {
  const gap = Math.floor(pause * SR);
  const x = new Float32Array((s.length + gap) * times);
  const pauses: Array<[number, number]> = [];
  for (let k = 0; k < times; k++) {
    x.set(s, k * (s.length + gap));
    pauses.push([k * (s.length + gap) + s.length, (k + 1) * (s.length + gap)]);
  }
  return { x, pauses };
}

function run(p: VoiceClean, params: Record<string, number>, L: Float32Array, R = Float32Array.from(L)): [Float32Array, Float32Array] {
  p.setParams({ ...createFx('voiceclean').params, ...params });
  for (let i = 0; i < L.length; i += 512) {
    const n = Math.min(512, L.length - i);
    p.process(L.subarray(i, i + n), R.subarray(i, i + n), n);
  }
  return [L, R];
}

/** Energy (dB) of the processed signal in the given input ranges, shifted by the latency. */
function levelIn(y: Float32Array, ranges: Array<[number, number]>, latency: number): number {
  let s = 0;
  let n = 0;
  for (const [a, b] of ranges) {
    for (let i = a + latency + 2400; i < Math.min(y.length, b + latency); i++) {
      s += y[i] * y[i];
      n++;
    }
  }
  return 10 * Math.log10(s / n + 1e-20);
}

function level(y: Float32Array): number {
  let s = 0;
  for (const v of y) s += v * v;
  return 10 * Math.log10(s / y.length + 1e-20);
}

describe('AI voice cleanup', () => {
  it('ships its WebAssembly module', () => {
    expect(voiceCleanAvailable()).toBe(true);
  });

  it('is a filter with three levels, presets and compensated latency', () => {
    expect(fxDefinition('voiceclean').params.map((p) => p.key)).toEqual(['voice', 'ambience', 'reverb']);
    expect(factoryPresets('voiceclean').map((p) => p.preset.name)).toContain('Studio voice');
    const p = createProcessor('voiceclean', SR);
    // about 40 ms; the mixer delays the other tracks by this much
    expect(p.latency).toBe(1920);
    expect(createProcessor('voiceclean', 44100).latency).toBeGreaterThan(1700);
    p.dispose?.();
  });

  it('passes the input through unchanged (only delayed) with all three levels at 0 dB', () => {
    const s = speech();
    const noise = fan(s.length);
    const x = Float32Array.from(s, (v, i) => v + 0.05 * noise[i]);
    const p = new VoiceClean(SR);
    const [y] = run(p, { voice: 0, ambience: 0, reverb: 0 }, Float32Array.from(x));
    let err = 0;
    for (let i = 0; i + p.latency < y.length; i++) err = Math.max(err, Math.abs(y[i + p.latency] - x[i]));
    expect(err).toBeLessThan(1e-4);
    p.dispose();
  });

  it('removes background noise between and under the words and keeps the voice', () => {
    const { x: clean, pauses } = withPauses(speech(), 2);
    const noise = fan(clean.length);
    const g = Math.pow(10, level(clean) / 20) / Math.pow(10, level(noise) / 20) / Math.pow(10, 6 / 20); // 6 dB SNR
    const x = Float32Array.from(clean, (v, i) => v + g * noise[i]);
    const p = new VoiceClean(SR);
    const [y] = run(p, { voice: 0, ambience: -60, reverb: -60 }, Float32Array.from(x));
    const before = levelIn(x, pauses, 0);
    const after = levelIn(y, pauses, p.latency);
    // the pauses get at least 30 dB quieter …
    expect(before - after).toBeGreaterThan(30);
    // … while the voice keeps its level (within a few dB)
    expect(Math.abs(level(y) - level(clean))).toBeLessThan(4);
    p.dispose();
  });

  it('lets the ambience back in at the level asked for', () => {
    const { x: clean, pauses } = withPauses(speech(), 1);
    const noise = fan(clean.length).map((v) => v * 0.05);
    const x = Float32Array.from(clean, (v, i) => v + noise[i]);
    const off = new VoiceClean(SR);
    const half = new VoiceClean(SR);
    const [a] = run(off, { ambience: -60, reverb: -60 }, Float32Array.from(x));
    const [b] = run(half, { ambience: -20, reverb: -60 }, Float32Array.from(x));
    const inPause = levelIn(x, pauses, 0);
    // at −20 dB the pause is about 20 dB below the input, and well above "off"
    expect(levelIn(b, pauses, half.latency)).toBeGreaterThan(inPause - 26);
    expect(levelIn(b, pauses, half.latency)).toBeLessThan(inPause - 16);
    expect(levelIn(b, pauses, half.latency)).toBeGreaterThan(levelIn(a, pauses, off.latency) + 6);
    off.dispose();
    half.dispose();
  });

  it('learns the reverberation time of the room and takes the reverb out', { timeout: 60_000 }, () => {
    const { x: dry, pauses } = withPauses(speech(), 3);
    const wet = room(dry, 0.8);
    const keep = new VoiceClean(SR);
    const dereverb = new VoiceClean(SR);
    const [a] = run(keep, { ambience: 0, reverb: 0 }, Float32Array.from(wet));
    const [b] = run(dereverb, { ambience: 0, reverb: -60 }, Float32Array.from(wet));
    expect(dereverb.roomTime()).toBeGreaterThan(0.6);
    expect(dereverb.roomTime()).toBeLessThan(1.2);
    // the room's tail in the pauses is much quieter without the reverb
    expect(levelIn(a, pauses, keep.latency) - levelIn(b, pauses, dereverb.latency)).toBeGreaterThan(12);
    keep.dispose();
    dereverb.dispose();
  });

  it('keeps a dry recording dry', () => {
    // (the speech itself was recorded outdoors with a PA, so it has a little echo of its own)
    const { x } = withPauses(speech(), 3);
    const p = new VoiceClean(SR);
    run(p, { reverb: -60 }, Float32Array.from(x));
    expect(p.roomTime()).toBeLessThan(0.5);
    p.dispose();
  });

  it('runs a second channel only for stereo material, and remembers the room across a reset', () => {
    const s = speech();
    const p = new VoiceClean(SR);
    const [l, r] = run(p, {}, Float32Array.from(s));
    expect(Array.from(l.subarray(5000, 5100))).toEqual(Array.from(r.subarray(5000, 5100)));
    const rt = p.roomTime();
    p.reset();
    expect(p.roomTime()).toBe(rt);
    // different left and right: both channels are cleaned on their own
    const [l2, r2] = run(p, {}, Float32Array.from(s), Float32Array.from(s, (v) => v * 0.5));
    expect(level(r2.subarray(SR))).toBeLessThan(level(l2.subarray(SR)) - 4);
    p.dispose();
  });

  it('works at 44.1 and 96 kHz', () => {
    for (const sr of [44100, 96000]) {
      const n = sr * 2;
      const x = Float32Array.from({ length: n }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / sr));
      const p = new VoiceClean(sr);
      const [y] = run(p, { voice: 0, ambience: 0, reverb: 0 }, Float32Array.from(x));
      let e = 0;
      let q = 0;
      for (let i = sr / 2; i + p.latency < n; i++) {
        e += (y[i + p.latency] - x[i]) ** 2;
        q += x[i] ** 2;
      }
      // the resamplers are transparent for speech frequencies
      expect(10 * Math.log10(e / q)).toBeLessThan(-40);
      p.dispose();
    }
  });
});
