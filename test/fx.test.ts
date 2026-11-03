import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFx, normalizeFx } from '../src/core/fx/definitions';
import { createProcessor } from '../src/core/fx/processors';
import { MASTER, addFx, fxList, moveFx, removeFx, updateFx } from '../src/core/fx/stack';
import { UltraschallDynamics, buildDynamicsTable, dynamicsCurve, dynamicsGainDb } from '../src/core/fx/ultraschallDynamics';
import { Mixer, ReaderCache } from '../src/core/mixer';
import { addTrack, createProject, normalizeProject } from '../src/core/project';
import { writeWavFile } from '../src/core/wav';
import type { FxType } from '../src/shared/types';
import { sine, tmpDir } from './helpers';

const SR = 48000;
const rms = (a: Float32Array, from = 0, to = a.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / (to - from));
};
const db = (v: number) => 20 * Math.log10(v);

function run(type: FxType, params: Record<string, number>, input: Float32Array): Float32Array {
  const p = createProcessor(type, SR);
  p.setParams({ ...createFx(type).params, ...params });
  const L = Float32Array.from(input);
  const R = Float32Array.from(input);
  for (let i = 0; i < L.length; i += 512) {
    const n = Math.min(512, L.length - i);
    p.process(L.subarray(i, i + n), R.subarray(i, i + n), n);
  }
  return L;
}

describe('Ultraschall Dynamics', () => {
  const settings = { target: -20, noiseFloor: -40, noiseGate: 30 };

  it('builds the same curve as the JSFX defaults', () => {
    const curve = new Map(dynamicsCurve(settings, 109).map(([i, o]) => [Math.round(i), o]));
    // unity at the noise floor, ~target at full scale, muted below the gate
    expect(curve.get(-40)!).toBeCloseTo(-40, 0);
    expect(curve.get(0)!).toBeGreaterThan(-21);
    expect(curve.get(0)!).toBeLessThan(-18.5);
    expect(curve.get(-80)!).toBeLessThan(-100);
    // quiet speech is raised, loud speech held back
    expect(curve.get(-30)!).toBeGreaterThan(-30);
    expect(curve.get(-10)!).toBeLessThan(-10);
    // the output never exceeds the target by much, whatever comes in
    const tab = buildDynamicsTable(settings);
    for (let d = -40; d <= 0; d += 1) expect(d + dynamicsGainDb(tab, 10 ** (d / 20))).toBeLessThan(-18.5);
  });

  it('delays by 100 ms and levels a loud and a quiet voice towards the target', () => {
    const dyn = new UltraschallDynamics(SR);
    expect(dyn.latency).toBe(4800);
    const level = (amp: number) => {
      const out = run('dynamics', settings, sine(300, 3, SR, amp));
      return db(rms(out, SR * 2, SR * 3) * Math.SQRT2); // as peak-equivalent dBFS of the sine
    };
    const loud = level(0.5); // about -6 dBFS
    const quiet = level(0.03); // about -30 dBFS
    expect(loud).toBeLessThan(-15);
    expect(quiet).toBeGreaterThan(-30);
    expect(loud - quiet).toBeLessThan(12); // 24 dB apart going in
  });
});

describe('filters', () => {
  it('high-pass removes rumble but keeps the voice', () => {
    expect(rms(run('highpass', { freq: 100, slope: 24 }, sine(30, 1, SR)), SR / 2)).toBeLessThan(0.01);
    expect(rms(run('highpass', { freq: 100, slope: 24 }, sine(1000, 1, SR)), SR / 2)).toBeGreaterThan(0.34);
  });

  it('EQ boosts the band it is set to', () => {
    const out = run('eq', { p1Freq: 1000, p1Gain: 6, p1Q: 1 }, sine(1000, 1, SR, 0.1));
    expect(db(rms(out, SR / 2) / rms(sine(1000, 1, SR, 0.1)))).toBeCloseTo(6, 0);
  });

  it('gate turns down quiet signals and passes loud ones', () => {
    expect(db(rms(run('gate', { threshold: -40, range: -30 }, sine(300, 2, SR, 0.003)), SR) / rms(sine(300, 1, SR, 0.003)))).toBeLessThan(-28);
    expect(rms(run('gate', { threshold: -40, range: -30 }, sine(300, 1, SR, 0.3)), SR / 2)).toBeCloseTo(rms(sine(300, 1, SR, 0.3)), 2);
  });

  it('compressor reduces signal above the threshold by the ratio', () => {
    const out = run('compressor', { threshold: -20, ratio: 4, knee: 0, attack: 1, release: 50, makeup: 0 }, sine(300, 1, SR, 1));
    // 0 dBFS peak, 20 dB over → 15 dB reduction
    expect(db(Math.max(...out.subarray(SR / 2).map(Math.abs)))).toBeCloseTo(-15, 0);
  });

  it('de-esser reduces loud highs but leaves lows alone', () => {
    const hi = run('deesser', { freq: 5000, threshold: -30, maxReduction: 12 }, sine(8000, 1, SR, 0.5));
    expect(db(rms(hi, SR / 2) / rms(sine(8000, 1, SR, 0.5)))).toBeLessThan(-8);
    const lo = run('deesser', { freq: 5000, threshold: -30, maxReduction: 12 }, sine(200, 1, SR, 0.5));
    expect(rms(lo, SR / 2)).toBeCloseTo(rms(sine(200, 1, SR, 0.5)), 2);
  });

  it('limiter never exceeds its ceiling', () => {
    const out = run('limiter', { ceiling: -3 }, sine(300, 1, SR, 1.5));
    expect(Math.max(...out.map(Math.abs))).toBeLessThanOrEqual(10 ** (-3 / 20) + 1e-6);
  });
});

describe('filter stacks', () => {
  it('adds, edits, reorders and removes filters on tracks and the master', () => {
    let p = addTrack(createProject(), { name: 'Host' });
    const id = p.tracks[0].id;
    p = addFx(p, id, 'highpass').project;
    p = addFx(p, id, 'compressor').project;
    p = addFx(p, id, 'dynamics').project;
    p = addFx(p, MASTER, 'limiter').project;
    const [hp, comp, dyn] = fxList(p, id);
    p = moveFx(p, id, dyn.id, 0);
    expect(fxList(p, id).map((f) => f.type)).toEqual(['dynamics', 'highpass', 'compressor']);
    p = updateFx(p, id, comp.id, { enabled: false, params: { ratio: 6 } });
    expect(fxList(p, id)[2]).toMatchObject({ enabled: false, params: { ratio: 6, threshold: -20 } });
    p = removeFx(p, id, hp.id);
    expect(fxList(p, id)).toHaveLength(2);
    expect(fxList(p, MASTER).map((f) => f.type)).toEqual(['limiter']);
    const reloaded = normalizeProject(JSON.parse(JSON.stringify(p)));
    expect(reloaded.tracks[0].fx).toEqual(p.tracks[0].fx);
    expect(reloaded.masterFx).toEqual(p.masterFx);
    expect(normalizeFx({ type: 'limiter', params: { ceiling: 99 } })!.params.ceiling).toBe(0);
    expect(normalizeFx({ type: 'nope' as FxType })).toBeNull();
  });

  it('compensates filter latency so audio stays in place on the timeline', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'media'));
    // 1 s silence, then a 1 s tone
    const tone = new Float32Array(SR * 2);
    tone.set(sine(300, 1, SR, 0.3), SR);
    writeWavFile(path.join(dir, 'media/t.wav'), [tone], SR);
    let p = addTrack(createProject('L', SR), { name: 'Host' });
    p.tracks[0].clips.push({ id: 'c', file: 'media/t.wav', start: 0, offset: 0, length: SR * 2, gain: 0, fadeIn: 0, fadeOut: 0 });
    p = addFx(p, p.tracks[0].id, 'dynamics', 0).project;
    p = addFx(p, MASTER, 'dynamics').project; // latency on the master too
    const readers = new ReaderCache(dir);
    const mixer = new Mixer(p, readers);
    const out = [new Float32Array(SR * 2), new Float32Array(SR * 2)];
    const block = [new Float32Array(512), new Float32Array(512)];
    for (let pos = 0; pos < SR * 2; pos += 512) {
      const n = Math.min(512, SR * 2 - pos);
      mixer.render(pos, n, block);
      out[0].set(block[0].subarray(0, n), pos);
    }
    readers.closeAll();
    const onset = out[0].findIndex((v) => Math.abs(v) > 1e-4);
    expect(Math.abs(onset - SR)).toBeLessThan(64);
    // seeking (a jump) re-primes and gives the same audio
    const again = [new Float32Array(512), new Float32Array(512)];
    const m2 = new Mixer(p, new ReaderCache(dir));
    m2.render(SR + 24000, 512, again);
    expect(rms(again[0])).toBeGreaterThan(0.01);
  });
});
