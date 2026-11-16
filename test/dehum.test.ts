import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFx } from '../src/core/fx/definitions';
import { factoryPresets } from '../src/core/fx/presets';
import { createProcessor } from '../src/core/fx/processors';
import { DeHum } from '../src/core/fx/dehum';
import { Resampler } from '../src/core/opus';
import { readWavFile } from '../src/core/wav';

const SR = 48000;

function speech(): Float32Array {
  const { info, channels } = readWavFile(path.join(__dirname, 'fixtures/jfk-speech.wav'));
  const one = new Resampler(info.sampleRate, SR, 1).process([channels[0]], channels[0].length)[0];
  // three times over: about 14 s
  const x = new Float32Array(one.length * 3);
  for (let k = 0; k < 3; k++) x.set(one, k * one.length);
  return x;
}

/** Buzz at f (slowly drifting by `drift` Hz) with overtones falling off. */
function hum(n: number, f: number, amp: number, drift = 0, overtones = 10): Float32Array {
  const y = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const fi = f + drift * Math.sin((2 * Math.PI * i) / (n * 2));
    ph += (2 * Math.PI * fi) / SR;
    let v = 0;
    for (let k = 1; k <= overtones; k++) v += Math.sin(k * ph + k) / k ** 0.7;
    y[i] = amp * v;
  }
  return y;
}

function run(x: Float32Array, params: Record<string, number> = {}): { y: Float32Array; p: DeHum } {
  const p = new DeHum(SR);
  p.setParams({ ...createFx('dehum').params, ...params });
  const L = Float32Array.from(x);
  const R = Float32Array.from(x);
  for (let i = 0; i < L.length; i += 480) {
    const n = Math.min(480, L.length - i);
    p.process(L.subarray(i, i + n), R.subarray(i, i + n), n);
  }
  return { y: L, p };
}

const rmsDb = (a: ArrayLike<number>, from: number, to: number) => {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return 10 * Math.log10(s / (to - from));
};

describe('De-hum', () => {
  const sp = speech();
  const n = sp.length;

  for (const f of [50.3, 59.8]) {
    it(`finds ${f} Hz hum by itself and removes it under speech`, () => {
      const h = hum(n, f, 0.02, 0.03, 8);
      const x = sp.map((v, i) => v + h[i]);
      const { y, p } = run(x);
      expect(p.freq).not.toBeNull();
      expect(Math.abs(p.freq! - f)).toBeLessThan(0.2);
      // what is left of the hum plus what was lost of the speech, once it has settled
      const res = y.map((v, i) => v - sp[i]);
      expect(rmsDb(res, 5 * SR, n) - rmsDb(h, 5 * SR, n)).toBeLessThan(-12);
    });
  }

  it('leaves speech without hum nearly alone', () => {
    const { y, p } = run(Float32Array.from(sp));
    const diff = y.map((v, i) => v - sp[i]);
    expect(rmsDb(diff, SR, n) - rmsDb(sp, SR, n)).toBeLessThan(-30);
    expect(p.latency).toBe(0);
  });

  it('removes a harsh buzz with many overtones when told to', () => {
    const h = hum(SR * 6, 60, 0.02, 0, 20);
    const few = run(h, { mains: 2, harmonics: 4 });
    const many = run(h, { mains: 2, harmonics: 20 });
    expect(rmsDb(many.y, 3 * SR, 6 * SR) - rmsDb(h, 3 * SR, 6 * SR)).toBeLessThan(-30);
    expect(rmsDb(many.y, 3 * SR, 6 * SR)).toBeLessThan(rmsDb(few.y, 3 * SR, 6 * SR) - 6);
  });

  it('plays only the hum in Hum only mode', () => {
    const h = hum(n, 50, 0.02, 0, 8);
    const x = sp.map((v, i) => v + h[i]);
    const { y } = run(x, { output: 1 });
    const diff = y.map((v, i) => v - h[i]);
    expect(rmsDb(diff, 5 * SR, n) - rmsDb(h, 5 * SR, n)).toBeLessThan(-15);
  });

  it('is a filter with presets', () => {
    expect(createProcessor('dehum', SR).latency).toBe(0);
    expect(factoryPresets('dehum').map((e) => e.preset.name)).toContain('Harsh buzz');
  });
});
