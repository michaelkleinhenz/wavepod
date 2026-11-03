import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Mixer, ReaderCache } from '../src/core/mixer';
import { addTrack, createProject, normalizeProject } from '../src/core/project';
import { writeWavFile } from '../src/core/wav';
import type { Clip } from '../src/shared/types';
import { tmpDir } from './helpers';

const SR = 8000;
const clip = (id: string, file: string, start: number, length: number): Clip => ({ id, file, start, offset: 0, length, gain: 0, fadeIn: 0, fadeOut: 0 });
const rmsDb = (x: Float32Array, a: number, b: number) => 10 * Math.log10(x.slice(a, b).reduce((s, v) => s + v * v, 0) / (b - a));

describe('ducking', () => {
  it('lowers the ducked track while the others play and brings it back in the pauses', () => {
    const dir = tmpDir();
    const music = new Float32Array(6 * SR).map((_, i) => 0.2 * Math.sin((2 * Math.PI * 200 * i) / SR));
    const voice = new Float32Array(2 * SR).map((_, i) => 0.3 * Math.sin((2 * Math.PI * 500 * i) / SR));
    writeWavFile(path.join(dir, 'music.wav'), [music], SR, 32);
    writeWavFile(path.join(dir, 'voice.wav'), [voice], SR, 32);
    let p = createProject('D', SR);
    p = addTrack(p, { name: 'Voice' });
    p = addTrack(p, { name: 'Bed', duck: { enabled: true, depth: 12 } });
    p.tracks[0].clips.push(clip('v', 'voice.wav', 2 * SR, 2 * SR)); // speech from 2 s to 4 s
    p.tracks[1].clips.push(clip('m', 'music.wav', 0, 6 * SR));
    const readers = new ReaderCache(dir);
    const mixer = new Mixer(p, readers);
    const out = [new Float32Array(6 * SR), new Float32Array(6 * SR)];
    for (let pos = 0; pos < 6 * SR; pos += 512) {
      const n = Math.min(512, 6 * SR - pos);
      const blk = [new Float32Array(n), new Float32Array(n)];
      mixer.render(pos, n, blk);
      out[0].set(blk[0], pos);
    }
    // take the voice (centre pan = unity gain, not ducked) out again to look at the bed alone
    const bed = out[0].map((v, i) => (i >= 2 * SR && i < 4 * SR ? v - voice[i - 2 * SR] : v));
    const before = rmsDb(bed, 0.5 * SR, 1.5 * SR);
    const during = rmsDb(bed, 2.6 * SR, 3.8 * SR);
    const after = rmsDb(bed, 5.3 * SR, 5.9 * SR);
    expect(before - during).toBeGreaterThan(10);
    expect(before - during).toBeLessThan(14);
    expect(Math.abs(after - before)).toBeLessThan(1);
    mixer.dispose();
    readers.closeAll();
  });

  it('keeps the setting through save and load', () => {
    let p = createProject('D', SR);
    p = addTrack(p, { name: 'Bed', duck: { enabled: true, depth: -18 } });
    const q = normalizeProject(JSON.parse(JSON.stringify(p)));
    expect(q.tracks[0].duck).toEqual({ enabled: true, depth: 18 });
  });
});
