import { describe, expect, it } from 'vitest';
import { checkStamp, parseStamp, projectFingerprint, type ExportStamp } from '../src/core/exportStamp';
import { addTrack, createProject } from '../src/core/project';
import type { Project } from '../src/shared/types';

function episode(): Project {
  const p = addTrack(createProject('Episode', 8000), { name: 'Host' });
  p.metadata = { ...p.metadata, title: 'Episode 1', episode: '1' };
  p.tracks[0].clips.push({ id: 'a', file: 'media/a.wav', start: 0, offset: 0, length: 8000, gain: 0, fadeIn: 0, fadeOut: 0 });
  p.markers = [{ id: 'm', kind: 'chapter', position: 0, title: 'Intro' } as Project['markers'][number]];
  return p;
}

const copy = (p: Project): Project => JSON.parse(JSON.stringify(p));

describe('export stamp', () => {
  it('gives the same fingerprint for the same episode, whatever the key order', () => {
    const p = episode();
    const q = copy(p);
    const { title, ...rest } = q.metadata;
    q.metadata = { ...rest, title };
    expect(projectFingerprint(q)).toBe(projectFingerprint(p));
  });

  it('changes when the audio, the chapters or the tags change', () => {
    const p = episode();
    const f = projectFingerprint(p);
    const gain = copy(p);
    gain.tracks[0].clips[0].gain = -3;
    const moved = copy(p);
    moved.tracks[0].clips[0].start = 100;
    const muted = copy(p);
    muted.tracks[0].mute = true;
    const chapter = copy(p);
    chapter.markers[0].title = 'Start';
    const title = copy(p);
    title.metadata.title = 'Episode 1: Tools';
    const master = copy(p);
    master.masterGain = -1;
    for (const q of [gain, moved, muted, chapter, title, master]) expect(projectFingerprint(q)).not.toBe(f);
  });

  it('ignores what does not go into the MP3', () => {
    const p = episode();
    const q = copy(p);
    q.tracks[0].color = '#123456';
    q.tracks[0].armed = !q.tracks[0].armed;
    q.metadata.showNotes = 'Links';
    q.metadata.publishDate = '2026-12-31T12:00';
    q.metadata.explicit = true;
    q.exportSettings = { ...(q.exportSettings ?? ({} as NonNullable<Project['exportSettings']>)), mp3Bitrate: 192 };
    q.soundcheckIgnored = ['x'];
    expect(projectFingerprint(q)).toBe(projectFingerprint(p));
  });

  it('is current only while the file and the episode are unchanged', () => {
    const p = episode();
    const stamp: ExportStamp = { path: '/x/Episode 1.mp3', size: 1000, mtimeMs: 5000, fingerprint: projectFingerprint(p), at: 5000 };
    expect(checkStamp(stamp, p, { size: 1000, mtimeMs: 5000 }).current).toBe(true);
    expect(checkStamp(stamp, p, null)).toMatchObject({ current: false, reason: expect.stringMatching(/not there/) });
    expect(checkStamp(stamp, p, { size: 999, mtimeMs: 5000 })).toMatchObject({ current: false, reason: expect.stringMatching(/replaced/) });
    const edited = copy(p);
    edited.tracks[0].clips[0].length = 4000;
    expect(checkStamp(stamp, edited, { size: 1000, mtimeMs: 5000 })).toMatchObject({ current: false, reason: expect.stringMatching(/episode was changed/) });
  });

  it('reads only stamps of MP3 files', () => {
    expect(parseStamp({ path: '/a.mp3', size: 1, mtimeMs: 2, fingerprint: 'f', at: 3 })).toEqual({ path: '/a.mp3', size: 1, mtimeMs: 2, fingerprint: 'f', at: 3 });
    expect(parseStamp({ path: '/a.wav', size: 1, mtimeMs: 2, fingerprint: 'f' })).toBeNull();
    expect(parseStamp({ path: '/a.mp3' })).toBeNull();
    expect(parseStamp(null)).toBeNull();
  });
});
