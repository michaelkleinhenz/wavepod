import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Mixer, ReaderCache } from '../src/core/mixer';
import { addTrack, createProject } from '../src/core/project';
import { writeWavFile } from '../src/core/wav';
import { tmpDir } from './helpers';

describe('track playback meters', () => {
  it('reports what each track plays back, only while metering', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'media'));
    writeWavFile(path.join(dir, 'media/dc.wav'), [new Float32Array(48000).fill(0.5)], 48000);
    let p = addTrack(addTrack(createProject('M', 48000), { name: 'Host', pan: 0 }), { name: 'Guest', pan: 0 });
    p.tracks[0].clips.push({ id: 'c', file: 'media/dc.wav', start: 0, offset: 0, length: 48000, gain: 0, fadeIn: 0, fadeOut: 0 });
    p.tracks[0].gain = -6;
    const readers = new ReaderCache(dir);
    const buf = [new Float32Array(1024), new Float32Array(1024)];
    const mixer = new Mixer(p, readers);
    mixer.render(0, 1024, buf);
    expect(mixer.takeTrackPeaks()).toEqual({});
    mixer.metering = true;
    mixer.render(0, 1024, buf);
    const peaks = mixer.takeTrackPeaks();
    readers.closeAll();
    expect(peaks[p.tracks[0].id]).toBeCloseTo(buf[0][100], 5);
    expect(peaks[p.tracks[0].id]).toBeGreaterThan(0.1);
    expect(peaks[p.tracks[1].id]).toBe(0);
    expect(mixer.takeTrackPeaks()).toEqual({});
  });
});
