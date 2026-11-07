import { afterEach, describe, expect, it } from 'vitest';
import { MixMinusBuffer, mixMinusLeavesOutSomething, mixMinusSources } from '../src/core/mixMinus';
import { AudioEngine, VIRTUAL_API } from '../src/main/audio/engine';
import { addTrack, createProject } from '../src/core/project';
import type { Project } from '../src/shared/types';
import { tmpDir } from './helpers';

function studio(): Project {
  let p = createProject('Show', 48000);
  p = addTrack(p, { name: 'Host', inputChannels: [0], armed: true });
  p = addTrack(p, { name: 'Co-host', inputChannels: [1] });
  p = addTrack(p, { name: 'Zoom guest', inputChannels: [2, 3] });
  return p;
}

/** One interleaved input buffer: channel c carries the constant value c + 1 (scaled). */
function input(frames: number, nch: number, value = (c: number) => (c + 1) / 100): Float32Array {
  const buf = new Float32Array(frames * nch);
  for (let i = 0; i < frames; i++) for (let c = 0; c < nch; c++) buf[i * nch + c] = value(c);
  return buf;
}

describe('mix-minus sources', () => {
  it('takes every input a track records from, minus the guest', () => {
    const p = studio();
    expect(mixMinusSources(p.tracks, 16, [])).toEqual([
      { channel: 0, left: 1, right: 1 },
      { channel: 1, left: 1, right: 1 },
      { channel: 2, left: 1, right: 0 },
      { channel: 3, left: 0, right: 1 },
    ]);
    expect(mixMinusSources(p.tracks, 16, [2, 3]).map((s) => s.channel)).toEqual([0, 1]);
    // inputs no track uses (e.g. a device's stereo mix with the guest in it) stay out
    expect(mixMinusSources(p.tracks, 16, []).some((s) => s.channel > 3)).toBe(false);
    // and inputs the device doesn't have
    expect(mixMinusSources(p.tracks, 2, []).map((s) => s.channel)).toEqual([0, 1]);
    expect(mixMinusLeavesOutSomething(p.tracks, [])).toBe(false);
    expect(mixMinusLeavesOutSomething(p.tracks, [3])).toBe(true);
  });

  it('ignores the soundboard track and shared inputs', () => {
    let p = studio();
    p = addTrack(p, { name: 'Host again', inputChannels: [0] });
    p.tracks.push({ ...p.tracks[0], id: 'sb', kind: 'soundboard', inputChannels: [5] });
    expect(mixMinusSources(p.tracks, 16, [2, 3]).map((s) => s.channel)).toEqual([0, 1]);
  });
});

describe('MixMinusBuffer', () => {
  const sources = [
    { channel: 0, left: 1, right: 1 },
    { channel: 2, left: 1, right: 0 },
  ];

  it('mixes the chosen inputs and hands them over in order', () => {
    const b = new MixMinusBuffer(1024, 512);
    b.write(input(100, 4), 4, sources);
    expect(b.buffered).toBe(100);
    const L = new Float32Array(150);
    const R = new Float32Array(150);
    expect(b.readInto(150, L, R)).toBe(100);
    expect(L[0]).toBeCloseTo(0.01 + 0.03, 6);
    expect(R[0]).toBeCloseTo(0.01, 6);
    expect(L[120]).toBe(0); // ran dry: silence, not old audio
    expect(b.buffered).toBe(0);
  });

  it('keeps the delay bounded when the output falls behind', () => {
    const b = new MixMinusBuffer(1000, 400);
    let n = 0;
    for (let k = 0; k < 30; k++) b.write(input(100, 4, () => n++ / 1e6), 4, [{ channel: 0, left: 1, right: 0 }]);
    expect(b.buffered).toBeLessThanOrEqual(1000);
    expect(b.buffered).toBeGreaterThan(0);
    // what is left is the newest audio, in order
    const L = new Float32Array(b.buffered);
    const got = b.readInto(L.length, L, new Float32Array(L.length));
    for (let i = 1; i < got; i++) expect(L[i]).toBeGreaterThan(L[i - 1]);
    expect(L[got - 1] * 1e6).toBeCloseTo(n - 4, 0);
  });

  it('wraps around the ring without losing frames', () => {
    const b = new MixMinusBuffer(256, 128);
    const L = new Float32Array(100);
    const R = new Float32Array(100);
    for (let k = 0; k < 20; k++) {
      b.write(input(100, 4), 4, sources);
      L.fill(0);
      expect(b.readInto(100, L, R)).toBe(100);
      expect(L.every((v) => Math.abs(v - 0.04) < 1e-6)).toBe(true);
    }
  });
});

describe('AudioEngine mix-minus', () => {
  let engine: AudioEngine;
  afterEach(() => engine?.dispose());

  it('sends the live microphones to the second output without the guest', () => {
    engine = new AudioEngine(null);
    engine.applyConfig({
      api: VIRTUAL_API,
      inputDeviceId: 1,
      outputDeviceId: 2,
      sampleRate: 48000,
      bufferSize: 480,
      outputFirstChannel: 0,
      output2FirstChannel: 2,
      output2Source: 'mixminus',
      mixMinusExclude: [2, 3],
    });
    engine.setProject(studio(), tmpDir());
    const e = engine as unknown as { onInput(b: Float32Array): void; onOutput(n: number, nch: number): Float32Array; input: { channels: number } };
    const nch = e.input.channels;
    const render = () => {
      const out = e.onOutput(480, 4);
      return [0, 1, 2, 3].map((ch) => out[100 * 4 + ch]);
    };
    // host 0.1 on input 1, co-host 0.2 on input 2, the guest's call 0.5 on inputs 3 and 4
    const live = () => input(480, nch, (c) => [0.1, 0.2, 0.5, 0.5][c] ?? 0.9);
    e.onInput(live());
    let [mainL, mainR, guestL, guestR] = render();
    expect(mainL).toBe(0); // the headphones don't get the live inputs (the interface monitors them)
    expect(mainR).toBe(0);
    expect(guestL).toBeCloseTo(0.3, 5); // host + co-host, no guest, no unused inputs
    expect(guestR).toBeCloseTo(0.3, 5);

    // changing who is left out doesn't stop a recording or reopen the device
    engine.record();
    expect(engine.transportState).toBe('recording');
    engine.applyConfig({ mixMinusExclude: [0] });
    expect(engine.transportState).toBe('recording');
    e.onInput(live());
    [, , guestL, guestR] = render();
    expect(guestL).toBeCloseTo(0.2 + 0.5, 5);
    expect(guestR).toBeCloseTo(0.2 + 0.5, 5);
    engine.stop();

    // the soundboard is in the guest feed too
    engine.loadSound('s', [new Float32Array(48000).fill(0.25)]);
    engine.playSound('s');
    [mainL, , guestL] = render();
    expect(mainL).toBeCloseTo(0.25, 2);
    expect(guestL).toBeCloseTo(0.25, 2); // no input queued this time: only the jingle
  });

  it('carries nothing live on other second-output modes', () => {
    engine = new AudioEngine(null);
    engine.applyConfig({ api: VIRTUAL_API, inputDeviceId: 1, outputDeviceId: 2, sampleRate: 48000, bufferSize: 480, outputFirstChannel: 0, output2FirstChannel: 2, output2Source: 'master' });
    engine.setProject(studio(), tmpDir());
    const e = engine as unknown as { onInput(b: Float32Array): void; onOutput(n: number, nch: number): Float32Array; input: { channels: number } };
    e.onInput(input(480, e.input.channels));
    const out = e.onOutput(480, 4);
    expect(out[100 * 4 + 2]).toBe(0);
  });
});
