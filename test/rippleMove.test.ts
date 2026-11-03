import { describe, expect, it } from 'vitest';
import { rippleMinDelta, rippleMove, rippleSet } from '../src/core/rippleMove';
import type { Clip, Project } from '../src/shared/types';

const clip = (id: string, start: number, length = 10): Clip => ({ id, file: 'a.wav', start, offset: 0, length, gain: 0, fadeIn: 0, fadeOut: 0 });
const track = (id: string, clips: Clip[], muteRegions?: [number, number][]) =>
  ({ id, name: id, color: '#fff', inputChannels: [], armed: false, mute: false, solo: false, gain: 0, pan: 0, clips, muteRegions }) as Project['tracks'][number];

function project(): Project {
  return {
    version: 1, name: 'p', sampleRate: 48000, bitDepth: 24, masterGain: 0, soundboard: [],
    tracks: [track('t1', [clip('a', 0), clip('b', 20), clip('c', 40)], [[5, 8], [45, 48]]), track('t2', [clip('d', 10), clip('e', 30)], [[35, 36]])],
    markers: [{ id: 'm1', kind: 'chapter', position: 15, title: '1' }, { id: 'm2', kind: 'chapter', position: 25, title: '2' }],
    metadata: { title: '', podcast: '', author: '', episode: '', description: '', year: '' },
  } as Project;
}

describe('ripple moves', () => {
  it('track scope moves the clip and later clips on its track only', () => {
    const p = project();
    const set = rippleSet(p, ['b'], 'track');
    expect([...set.clipIds].sort()).toEqual(['b', 'c']);
    expect(set.markerIds.size).toBe(0);
    const q = rippleMove(p, set, 5);
    expect(q.tracks[0].clips.map((c) => c.start)).toEqual([0, 25, 45]);
    expect(q.tracks[1].clips.map((c) => c.start)).toEqual([10, 30]);
    expect(q.tracks[0].muteRegions).toEqual([[5, 8], [50, 53]]);
    expect(q.tracks[1].muteRegions).toEqual([[35, 36]]);
    expect(q.markers.map((m) => m.position)).toEqual([15, 25]);
  });

  it('all scope moves later clips on every track, markers and mute regions', () => {
    const p = project();
    const set = rippleSet(p, ['b'], 'all');
    expect([...set.clipIds].sort()).toEqual(['b', 'c', 'e']);
    const q = rippleMove(p, set, -3);
    expect(q.tracks[0].clips.map((c) => c.start)).toEqual([0, 17, 37]);
    expect(q.tracks[1].clips.map((c) => c.start)).toEqual([10, 27]);
    expect(q.markers.map((m) => m.position)).toEqual([15, 22]);
    expect(q.tracks[1].muteRegions).toEqual([[32, 33]]);
  });

  it('never moves anything before zero', () => {
    const p = project();
    const set = rippleSet(p, ['b'], 'all');
    expect(rippleMinDelta(p, set)).toBe(-20);
    const q = rippleMove(p, set, -100);
    expect(q.tracks[0].clips.map((c) => c.start)).toEqual([0, 0, 20]);
  });
});
