import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFx, normalizeFx } from '../src/core/fx/definitions';
import { applyPreset, factoryPresets, presetFromFx } from '../src/core/fx/presets';
import { createProcessor } from '../src/core/fx/processors';
import { FxChain } from '../src/core/fx/chain';
import { MATCH_BANDS, MatchEq, SpectrumCollector, fitBells, matchGains, shapeCurve } from '../src/core/fx/matchEq';
import { Resampler } from '../src/core/opus';
import { readWavFile, writeWavFile } from '../src/core/wav';
import { learnMatch } from '../src/core/matchLearn';
import { addTrack, createProject } from '../src/core/project';
import { tmpDir } from './helpers';

const SR = 48000;

function speech(): Float32Array {
  const { info, channels } = readWavFile(path.join(__dirname, 'fixtures/jfk-speech.wav'));
  return new Resampler(info.sampleRate, SR, 1).process([channels[0]], channels[0].length)[0];
}

function through(type: 'eq' | 'matcheq', x: Float32Array, params: Record<string, number>, fx = createFx(type, params)): Float32Array {
  const p = createProcessor(type, SR, fx);
  p.setParams(fx.params);
  const L = Float32Array.from(x);
  const R = Float32Array.from(x);
  for (let i = 0; i < L.length; i += 480) {
    const n = Math.min(480, L.length - i);
    p.process(L.subarray(i, i + n), R.subarray(i, i + n), n);
  }
  return L;
}

function bands(x: Float32Array): number[] {
  const c = new SpectrumCollector(SR);
  c.push(x);
  return c.result();
}

describe('Voice match', () => {
  const ref = speech();
  // the "guest": the same voice through a thin, honky mic
  const src = through('eq', ref, { lsFreq: 250, lsGain: -8, p1Freq: 900, p1Gain: 6, p1Q: 1.5, hsFreq: 6000, hsGain: -4 });

  it('learns the difference between two voices as a curve', () => {
    const g = matchGains(bands(ref), bands(src));
    const at = (f: number) => g[MATCH_BANDS.findIndex((c) => c >= f)];
    expect(g).toHaveLength(MATCH_BANDS.length);
    // low end was cut, so it is raised; the honk at 900 Hz is lowered
    expect(at(100)).toBeGreaterThan(at(1000) + 6);
    expect(at(900)).toBeLessThan(at(2000) - 3);
    for (const v of g) expect(Math.abs(v)).toBeLessThanOrEqual(12);
  });

  it('brings the voice close to the reference', () => {
    const fx = { ...createFx('matcheq', { amount: 100, detail: 2 }), match: { gains: matchGains(bands(ref), bands(src)), reference: 'Host' } };
    const out = through('matcheq', src, fx.params, fx);
    const r = bands(ref);
    const before = bands(src);
    const after = bands(out);
    // compare shapes only: the level difference is taken out (it is not matched)
    const use = MATCH_BANDS.map((f) => f >= 80 && f <= 7000); // the fixture has no content above 8 kHz
    const shapeErr = (x: number[]) => {
      const d = MATCH_BANDS.map((_, b) => 10 * Math.log10(x[b] / r[b]));
      const sel = d.filter((_, b) => use[b]);
      const mean = sel.reduce((a, v) => a + v, 0) / sel.length;
      return sel.reduce((a, v) => a + Math.abs(v - mean), 0) / sel.length;
    };
    const errBefore = shapeErr(before);
    const errAfter = shapeErr(after);
    expect(errBefore).toBeGreaterThan(2);
    expect(errAfter).toBeLessThan(errBefore / 3);
  });

  it('fits bells that add up to the wanted curve', () => {
    const target = MATCH_BANDS.map((f) => (f > 300 && f < 3000 ? 6 * Math.sin(Math.log2(f / 300)) : 0));
    const shaped = shapeCurve(target, 2, 1);
    const g = fitBells(shaped, SR);
    expect(g.length).toBe(MATCH_BANDS.length);
    const fx = { ...createFx('matcheq', { amount: 100, detail: 2 }), match: { gains: target, reference: '' } };
    const p = new MatchEq(SR, fx.match);
    p.setParams(fx.params);
    // a sine at a band centre comes out at about the curve's gain there
    const b = MATCH_BANDS.findIndex((f) => f >= 1000);
    const n = SR;
    const L = Float32Array.from({ length: n }, (_, i) => 0.1 * Math.sin((2 * Math.PI * MATCH_BANDS[b] * i) / SR));
    const R = Float32Array.from(L);
    p.process(L, R, n);
    let e = 0;
    for (let i = n / 2; i < n; i++) e += L[i] * L[i];
    const gainDb = 10 * Math.log10(e / (n / 2) / 0.005);
    expect(Math.abs(gainDb - shaped[b])).toBeLessThan(0.5);
  });

  it('does nothing until learned, and keeps the curve in presets and copies', () => {
    const plain = createFx('matcheq');
    const x = Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i / 7));
    expect(Array.from(through('matcheq', x, plain.params, plain))).toEqual(Array.from(x));
    const learned = normalizeFx({ ...plain, match: { gains: MATCH_BANDS.map(() => 30), reference: 'Host' } })!;
    expect(learned.match!.gains[0]).toBe(24);
    const preset = presetFromFx(learned, 'Guest on the SM7B');
    expect(preset.match!.reference).toBe('Host');
    const applied = applyPreset(plain, preset, { id: 'user:x', name: 'Guest on the SM7B' });
    expect(applied.match).toEqual(learned.match);
    // factory presets keep the learned curve
    const factory = factoryPresets('matcheq').find((e) => e.preset.name === 'Subtle')!;
    expect(applyPreset(learned, factory.preset, { id: factory.id, name: 'Subtle' }).match).toEqual(learned.match);
  });

  it('rebuilds the running filter when a new curve is learned', () => {
    const chain = new FxChain(SR);
    const fx = { ...createFx('matcheq', { amount: 100 }), match: { gains: MATCH_BANDS.map(() => 0), reference: '' } };
    chain.sync([fx]);
    const a = (chain as unknown as { slots: Array<{ proc: unknown }> }).slots[0].proc;
    chain.sync([{ ...fx, match: { gains: MATCH_BANDS.map((_, i) => (i === 10 ? 3 : 0)), reference: '' } }]);
    const b = (chain as unknown as { slots: Array<{ proc: unknown }> }).slots[0].proc;
    expect(b).not.toBe(a);
  });

  it('learns from the clips on two tracks', () => {
    const dir = tmpDir();
    writeWavFile(path.join(dir, 'host.wav'), [ref], SR);
    writeWavFile(path.join(dir, 'guest.wav'), [src], SR);
    let p = addTrack(addTrack(createProject('E', SR), { name: 'Host' }), { name: 'Guest' });
    p.tracks[0].clips.push({ id: 'h', file: 'host.wav', start: 0, offset: 0, length: ref.length, gain: 0, fadeIn: 0, fadeOut: 0 });
    p.tracks[1].clips.push({ id: 'g', file: 'guest.wav', start: 0, offset: 0, length: src.length, gain: 0, fadeIn: 0, fadeOut: 0 });
    const r = learnMatch(p, dir, ['g'], ['h']);
    expect(r.sourceSeconds).toBeGreaterThan(2);
    const direct = matchGains(bands(ref), bands(src));
    MATCH_BANDS.forEach((f, b) => {
      if (f >= 100 && f <= 4000) expect(Math.abs(r.gains[b] - direct[b])).toBeLessThan(1);
    });
    // too little speech is an error the user can understand
    p = { ...p, tracks: p.tracks.map((t, i) => (i === 1 ? { ...t, clips: [{ ...t.clips[0], length: SR }] } : t)) };
    expect(() => learnMatch(p, dir, ['g'], ['h'])).toThrow(/too little speech/);
  });
});
