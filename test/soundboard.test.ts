import { describe, expect, it } from 'vitest';
import { createProject } from '../src/core/project';
import { SOUNDBOARD_TRACK_ID, ensureSoundboardTrack, jingleClips, jingleFadeInFrames, soundboardTrack } from '../src/core/soundboard';
import { normalizeProject } from '../src/core/project';

describe('soundboard track', () => {
  it('is added once and survives saving', () => {
    const p = ensureSoundboardTrack(createProject());
    expect(p.tracks).toHaveLength(1);
    expect(soundboardTrack(p)?.id).toBe(SOUNDBOARD_TRACK_ID);
    expect(ensureSoundboardTrack(p)).toBe(p);
    const reloaded = normalizeProject(JSON.parse(JSON.stringify(p)));
    expect(soundboardTrack(reloaded)?.kind).toBe('soundboard');
  });
});

describe('jingleClips', () => {
  const base = { file: 'media/j.wav', fileLength: 1000, start: 5000, gain: -3, fadeIn: 0, fadeOut: 0 };

  it('makes one clip for a jingle that played to the end', () => {
    const [c, ...rest] = jingleClips({ ...base, played: 1000 });
    expect(rest).toHaveLength(0);
    expect(c).toMatchObject({ file: 'media/j.wav', start: 5000, offset: 0, length: 1000, gain: -3, fadeIn: 0, fadeOut: 0 });
  });

  it('trims a stopped jingle and keeps its fades', () => {
    const [c] = jingleClips({ ...base, played: 600, fadeIn: 200, fadeOut: 100 });
    expect(c).toMatchObject({ length: 600, fadeIn: 200, fadeOut: 100 });
  });

  it('splits a looping jingle into one clip per pass', () => {
    const clips = jingleClips({ ...base, played: 2500, fadeIn: 300, fadeOut: 50 });
    expect(clips.map((c) => [c.start, c.length])).toEqual([
      [5000, 1000],
      [6000, 1000],
      [7000, 500],
    ]);
    expect(clips[0].fadeIn).toBe(300);
    expect(clips[1]).toMatchObject({ fadeIn: 0, fadeOut: 0 });
    expect(clips[2].fadeOut).toBe(50);
  });

  it('caps the fade-in at 5 s and half the jingle', () => {
    expect(jingleFadeInFrames(48000 * 60, 48000)).toBe(48000 * 5);
    expect(jingleFadeInFrames(48000 * 2, 48000)).toBe(48000);
  });
});
