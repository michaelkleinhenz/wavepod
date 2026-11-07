import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createFx, normalizeFx } from '../src/core/fx/definitions';
import { FxChain } from '../src/core/fx/chain';
import { createProcessor } from '../src/core/fx/processors';
import { CONVOLUTION_BLOCK, loadImpulse, setImpulseDir } from '../src/core/fx/convolution';
import { applyPreset, normalizePreset, presetFromFx } from '../src/core/fx/presets';
import { writeWavFile } from '../src/core/wav';
import type { Fx } from '../src/shared/types';

const SR = 48000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavepod-ir-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
setImpulseDir(dir);

/** A decaying noise IR, like a small room. */
function roomIr(seconds: number, rt60: number, seed = 1): Float32Array {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
  const n = Math.round(seconds * SR);
  const k = Math.log(1000) / (rt60 * SR);
  return Float32Array.from({ length: n }, (_, i) => rnd() * Math.exp(-k * i));
}

function convFx(file: string, params: Record<string, number> = {}): Fx {
  return { ...createFx('convolution', params), ir: { file, name: file } };
}

function run(fx: Fx, L: Float32Array, R = Float32Array.from(L), block = 480) {
  const p = createProcessor(fx.type, SR, fx);
  p.setParams(fx.params);
  for (let i = 0; i < L.length; i += block) {
    const n = Math.min(block, L.length - i);
    p.process(L.subarray(i, i + n), R.subarray(i, i + n), n);
  }
  return { L, R, latency: p.latency };
}

describe('Convolution reverb', () => {
  const mono = roomIr(0.4, 0.3);
  writeWavFile(path.join(dir, 'Room.wav'), [mono], SR, 32);
  const stereo = [roomIr(0.3, 0.25, 2), roomIr(0.3, 0.25, 3)];
  writeWavFile(path.join(dir, 'Stereo.wav'), stereo, SR, 32);

  it('matches direct convolution with the (normalised) impulse response, delayed by one partition', () => {
    const ir = loadImpulse(path.join(dir, 'Room.wav'), SR)![0];
    const n = SR / 2;
    const x = roomIr(n / SR, 10, 7).map((v) => v * 0.3);
    const { L, latency } = run(convFx('Room.wav', { dry: -60, wet: 0 }), Float32Array.from(x), undefined, 333);
    expect(latency).toBe(CONVOLUTION_BLOCK);
    let err = 0;
    let ref = 0;
    for (let t = 2000; t < 2400; t++) {
      let y = 0;
      for (let k = 0; k <= t && k < ir.length; k++) y += ir[k] * x[t - k];
      err = Math.max(err, Math.abs(L[t + latency] - y));
      ref = Math.max(ref, Math.abs(y));
    }
    expect(ref).toBeGreaterThan(0.05);
    expect(err / ref).toBeLessThan(1e-4);
  });

  it('keeps each channel of a stereo IR on its side', () => {
    const irs = loadImpulse(path.join(dir, 'Stereo.wav'), SR)!;
    const x = new Float32Array(SR / 4);
    x[100] = 1;
    const { L, R } = run(convFx('Stereo.wav', { dry: -60, wet: 0 }), Float32Array.from(x), Float32Array.from(x));
    for (const t of [0, 50, 1000, 5000]) {
      expect(L[100 + CONVOLUTION_BLOCK + t]).toBeCloseTo(irs[0][t], 4);
      expect(R[100 + CONVOLUTION_BLOCK + t]).toBeCloseTo(irs[1][t], 4);
    }
  });

  it('passes the dry signal, delayed, when the IR is missing', () => {
    const x = new Float32Array(4000);
    x[10] = 1;
    const { L } = run(convFx('Nope.wav'), Float32Array.from(x));
    expect(L[10 + CONVOLUTION_BLOCK]).toBeCloseTo(1, 6);
    expect(L.reduce((s, v) => s + Math.abs(v), 0)).toBeCloseTo(1, 6);
  });

  it('pre-delay moves the room later, length cuts the tail', () => {
    const x = new Float32Array(SR);
    x[0] = 1;
    const { L } = run(convFx('Room.wav', { dry: -60, wet: 0, predelay: 50, length: 25 }), Float32Array.from(x));
    const at = (from: number, to: number) => L.subarray(from + CONVOLUTION_BLOCK, to + CONVOLUTION_BLOCK).reduce((s, v) => s + v * v, 0);
    expect(at(0, 2390)).toBeLessThan(1e-20);
    expect(at(2400, 4000)).toBeGreaterThan(0);
    expect(at(2400 + 0.1 * SR + 10, SR / 2)).toBeLessThan(1e-20);
  });

  it('resamples an IR recorded at another rate', () => {
    writeWavFile(path.join(dir, 'Room44.wav'), [roomIr((0.5 * 44100) / SR, 0.3)], 44100, 24);
    const ir = loadImpulse(path.join(dir, 'Room44.wav'), SR)!;
    expect(Math.abs(ir[0].length - 0.5 * SR)).toBeLessThan(3);
  });

  it('a new IR on the same filter builds a new processor', () => {
    const chain = new FxChain(SR);
    const a = convFx('Room.wav', { dry: -60, wet: 0 });
    chain.sync([a]);
    chain.sync([{ ...a, ir: { file: 'Nope.wav', name: 'Nope' } }]);
    const x = new Float32Array(4000);
    x[0] = 1;
    chain.process(x, Float32Array.from(x), 4000);
    expect(x.every((v) => v === 0)).toBe(true);
  });

  it('keeps its IR through saving, presets and copying', () => {
    const fx = convFx('Room.wav', { wet: -18 });
    expect(normalizeFx(JSON.parse(JSON.stringify(fx)))?.ir).toEqual({ file: 'Room.wav', name: 'Room.wav' });
    expect(normalizeFx({ ...createFx('reverb'), ir: { file: 'x.wav', name: 'x' } })?.ir).toBeUndefined();
    const preset = normalizePreset(JSON.parse(JSON.stringify(presetFromFx(fx, 'My room'))))!;
    expect(preset.ir?.file).toBe('Room.wav');
    const other = applyPreset(createFx('convolution'), preset, { id: 'user:x', name: 'My room' });
    expect(other.ir?.file).toBe('Room.wav');
    expect(other.params.wet).toBe(-18);
  });
});

describe('Impulse responses folder', () => {
  it('copies WAV files in, lists them with subfolders, and refuses other formats', async () => {
    const { importImpulse, listImpulses } = await import('../src/main/impulseStore');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wavepod-irs-'));
    const outside = path.join(dir, 'Hall take 1.wav');
    writeWavFile(outside, [roomIr(0.2, 0.5)], 44100, 24);
    expect(importImpulse(root, outside)).toEqual({ file: 'Hall take 1.wav', name: 'Hall take 1' });
    // the same file again is not duplicated; a different one with the same name is numbered
    expect(importImpulse(root, outside).file).toBe('Hall take 1.wav');
    writeWavFile(outside, [roomIr(0.3, 0.5)], 44100, 24);
    expect(importImpulse(root, outside).file).toBe('Hall take 1 2.wav');
    fs.mkdirSync(path.join(root, 'Cars'));
    writeWavFile(path.join(root, 'Cars', 'Van.wav'), [roomIr(0.1, 0.05), roomIr(0.1, 0.05)], 48000, 16);
    fs.writeFileSync(path.join(root, 'notes.txt'), 'x');
    const list = listImpulses(root);
    expect(list.map((f) => f.file)).toEqual(['Cars/Van.wav', 'Hall take 1.wav', 'Hall take 1 2.wav']);
    expect(list[0]).toMatchObject({ channels: 2, sampleRate: 48000 });
    expect(importImpulse(root, path.join(root, 'Cars', 'Van.wav')).file).toBe('Cars/Van.wav');
    expect(() => importImpulse(root, path.join(root, 'notes.txt'))).toThrow(/WAV or AIFF/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
