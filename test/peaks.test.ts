import { describe, expect, it } from 'vitest';
import { MipmapBuilder, PeakPyramid, chooseWaveSource, decodePeaks, encodePeaks, mixToMono, parsePeakHeader, quantize } from '../src/core/peaks';
import { formatTick } from '../src/shared/time';

describe('multi-resolution peaks', () => {
  it('builds every level from the samples', () => {
    const pb = new MipmapBuilder(4, 3, 2);
    // 20 samples: buckets of 4 at level 0, 8 at level 1, 16 at level 2
    const data = Float32Array.from({ length: 20 }, (_, i) => (i === 5 ? 1 : i === 13 ? -1 : 0.25 * Math.sin(i)));
    pb.push([data]);
    const peaks = pb.finish();
    expect(peaks.length).toBe(20);
    expect(peaks.levels.map((l) => l.samplesPerPeak)).toEqual([4, 8, 16]);
    expect(peaks.levels.map((l) => l.data.length / 2)).toEqual([5, 3, 2]);
    // every level agrees with a brute-force min/max over its span
    for (const l of peaks.levels) {
      for (let k = 0; k < l.data.length / 2; k++) {
        const span = Array.from(data.slice(k * l.samplesPerPeak, (k + 1) * l.samplesPerPeak));
        expect(l.data[k * 2]).toBe(quantize(Math.min(...span)));
        expect(l.data[k * 2 + 1]).toBe(quantize(Math.max(...span)));
      }
    }
  });

  it('averages channels to mono', () => {
    const pb = new MipmapBuilder(2, 1);
    pb.push([Float32Array.from([1, 1]), Float32Array.from([0, -1])]);
    expect(Array.from(pb.finish().levels[0].data)).toEqual([0, 64]);
    expect(Array.from(mixToMono([Float32Array.from([1, 0.5]), Float32Array.from([0, -0.5])], 2))).toEqual([0.5, 0]);
  });

  it('streams level-0 buckets and rebuilds the same pyramid from them (live waveform)', () => {
    const pb = new MipmapBuilder(8, 4, 4);
    const live = new PeakPyramid(8, 4, 4);
    let sent = 0;
    for (let chunk = 0; chunk < 50; chunk++) {
      pb.push([Float32Array.from({ length: 37 }, (_, i) => Math.sin((chunk * 37 + i) / 9) * (chunk / 50))]);
      const fresh = pb.bucketsFrom(sent);
      sent = pb.bucketCount;
      for (let i = 0; i < fresh.length; i += 2) live.push(fresh[i], fresh[i + 1]);
    }
    const done = live.levelsSnapshot(false);
    const finished = pb.pyramid.levelsSnapshot(false);
    expect(done.map((l) => Array.from(l.data))).toEqual(finished.map((l) => Array.from(l.data)));
    expect(done[1].data.length / 2).toBe(Math.floor(done[0].data.length / 2 / 4));
  });

  it('includes the unfinished tail in coarse levels when finishing', () => {
    const pb = new MipmapBuilder(2, 3, 4);
    pb.push([Float32Array.from([0, 0, 0, 0, 0, 1])]); // 3 level-0 buckets, none complete above
    const levels = pb.finish().levels;
    expect(levels.map((l) => l.data.length / 2)).toEqual([3, 1, 1]);
    expect(levels[2].data[1]).toBe(127);
  });

  it('serialises all levels and reads the layout back', () => {
    const pb = new MipmapBuilder(4, 3, 4);
    pb.push([Float32Array.from({ length: 100 }, (_, i) => (i % 7) / 7 - 0.5)]);
    const peaks = pb.finish();
    const buf = encodePeaks(peaks);
    const layout = parsePeakHeader(buf)!;
    expect(layout.length).toBe(100);
    expect(layout.levels.map((l) => l.samplesPerPeak)).toEqual([4, 16, 64]);
    for (const [i, l] of layout.levels.entries()) {
      expect(Array.from(buf.subarray(l.offset, l.offset + l.buckets * 2)).map((v) => (v << 24) >> 24)).toEqual(Array.from(peaks.levels[i].data));
    }
    const back = decodePeaks(buf)!;
    expect(back.levels.map((l) => Array.from(l.data))).toEqual(peaks.levels.map((l) => Array.from(l.data)));
  });

  it('rejects peak files from before multi-resolution peaks', () => {
    const old = Buffer.alloc(16);
    old.writeUInt32LE(256, 0);
    old.writeDoubleLE(1000, 4);
    expect(parsePeakHeader(old)).toBeNull();
    expect(decodePeaks(old)).toBeNull();
  });

  it('picks raw samples below the finest level, else the level just finer than a pixel', () => {
    const levels = [64, 256, 1024, 4096];
    expect(chooseWaveSource(0.02, levels)).toEqual({ kind: 'samples' });
    expect(chooseWaveSource(63.9, levels)).toEqual({ kind: 'samples' });
    expect(chooseWaveSource(64, levels)).toEqual({ kind: 'peaks', samplesPerPeak: 64 });
    expect(chooseWaveSource(1000, levels)).toEqual({ kind: 'peaks', samplesPerPeak: 256 });
    expect(chooseWaveSource(1e7, levels)).toEqual({ kind: 'peaks', samplesPerPeak: 4096 });
  });

  it('labels ruler ticks with the precision of the step', () => {
    expect(formatTick(62, 1)).toBe('00:01:02');
    expect(formatTick(62.25, 0.25)).toBe('00:01:02.25');
    expect(formatTick(1.0105, 0.0005)).toBe('00:00:01.0105');
    expect(formatTick(3599.99999, 0.00001)).toBe('00:59:59.99999');
  });
});
