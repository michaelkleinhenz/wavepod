import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { alignClip, bestLag } from '../src/core/align';
import { addTrack, createProject } from '../src/core/project';
import { writeWavFile } from '../src/core/wav';
import { tmpDir } from './helpers';

/** Speech-like test signal: noise bursts with pauses. */
function speechy(n: number, sr: number, seed: number): Float32Array {
  const x = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 16807) % 2147483647;
    const syllable = Math.sin((2 * Math.PI * i) / (sr * 0.31)) > 0.2 && Math.sin((2 * Math.PI * i) / (sr * 2.3)) > -0.6;
    x[i] = syllable ? (s / 2147483647 - 0.5) * 0.6 : 0;
  }
  return x;
}

describe('double-ender alignment', () => {
  it('finds a lag by cross-correlation', () => {
    const ref = speechy(20000, 2000, 3);
    const probe = ref.slice(7000, 12000);
    const r = bestLag(ref, probe);
    expect(r.lag).toBe(7000);
    expect(r.confidence).toBeGreaterThan(0.99);
  });

  it('moves a guest’s local recording onto the remote track', () => {
    const dir = tmpDir();
    const sr = 16000;
    const call = speechy(120 * sr, sr, 11); // what the remote track recorded (the guest over the call)
    // the guest's own recording started 4.25 s before the call recording, and sounds a bit different
    const lead = Math.round(4.25 * sr);
    const local = new Float32Array(call.length + lead);
    let s = 5;
    for (let i = 0; i < local.length; i++) {
      s = (s * 48271) % 2147483647;
      local[i] = (i >= lead ? call[i - lead] * 1.7 : 0) + (s / 2147483647 - 0.5) * 0.02;
    }
    writeWavFile(path.join(dir, 'remote.wav'), [call], sr, 32);
    writeWavFile(path.join(dir, 'local.wav'), [local], sr, 32);
    let p = createProject('A', sr);
    p = addTrack(p, { name: 'Remote' });
    p = addTrack(p, { name: 'Guest local' });
    p.tracks[0].clips.push({ id: 'r', file: 'remote.wav', start: 10 * sr, offset: 0, length: call.length, gain: 0, fadeIn: 0, fadeOut: 0 });
    // imported somewhere near, but not lined up
    p.tracks[1].clips.push({ id: 'l', file: 'local.wav', start: 20 * sr, offset: 0, length: local.length, gain: 0, fadeIn: 0, fadeOut: 0 });
    const r = alignClip(p, dir, 'l', p.tracks[0].id);
    // local sample `lead` = remote sample 0 at 10 s, so local starts at 10 s - 4.25 s
    const expected = 10 * sr - lead;
    expect(Math.abs(r.start - expected)).toBeLessThanOrEqual(8); // within half a millisecond
    expect(r.shift).toBe(r.start - 20 * sr);
    expect(r.confidence).toBeGreaterThan(0.5);
  });

  it('rejects aligning a clip to its own track', () => {
    let p = createProject('A', 1000);
    p = addTrack(p, { name: 'T' });
    p.tracks[0].clips.push({ id: 'c', file: 'x.wav', start: 0, offset: 0, length: 10, gain: 0, fadeIn: 0, fadeOut: 0 });
    expect(() => alignClip(p, tmpDir(), 'c', p.tracks[0].id)).toThrow(/different track/);
  });
});
