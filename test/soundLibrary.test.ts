import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addFavourites,
  favouriteEntries,
  favouritePathOf,
  favouriteRef,
  fillClips,
  isLibraryAudio,
  matchRanges,
  moveFavourite,
  normalizeFavourites,
  normalizeName,
  searchLibrary,
  soundFileTitle,
  type LibraryEntry,
} from '../src/core/soundLibrary';
import { libraryFilePath, scanLibrary } from '../src/main/soundLibrary';

const lib = (...paths: string[]): LibraryEntry[] => paths.map((p) => ({ path: p, size: 1 }));

describe('sound library search', () => {
  const files = lib(
    'Doors/Door_Creak_01.wav',
    'Doors/door-slam-heavy.wav',
    'Doors/Doorbell ding dong.mp3',
    'Ambience/Indoor room tone.flac',
    'Ambience/Forest/birds morning.wav',
    'Ambience/Forest/wind in trees.ogg',
    'Foley/Schritte Kies.wav',
    'Foley/Tür knarrt.wav',
  );

  it('matches word beginnings in file names, any order, case and accents ignored', () => {
    const names = (q: string) => searchLibrary(files, q).results.map((e) => e.path);
    expect(names('door')).toEqual(['Doors/Door_Creak_01.wav', 'Doors/door-slam-heavy.wav', 'Doors/Doorbell ding dong.mp3']);
    expect(names('door')).not.toContain('Ambience/Indoor room tone.flac');
    expect(names('creak door')).toEqual(['Doors/Door_Creak_01.wav']);
    expect(names('tur')).toEqual(['Foley/Tür knarrt.wav']);
    expect(names('TÜR KNARR')).toEqual(['Foley/Tür knarrt.wav']);
  });

  it('also matches folder names, ranked below file name matches', () => {
    const r = searchLibrary(files, 'forest').results.map((e) => e.path);
    expect(r).toEqual(['Ambience/Forest/birds morning.wav', 'Ambience/Forest/wind in trees.ogg']);
    expect(searchLibrary(files, 'forest wind').results.map((e) => e.path)).toEqual(['Ambience/Forest/wind in trees.ogg']);
  });

  it('lists everything for an empty query, and counts beyond the limit', () => {
    expect(searchLibrary(files, '  ').total).toBe(files.length);
    const r = searchLibrary(files, 'a', 1);
    expect(r.results).toHaveLength(1);
    expect(r.total).toBeGreaterThan(1);
  });

  it('marks the matched word beginnings', () => {
    expect(matchRanges('Door_Creak_01', 'creak')).toEqual([[5, 10]]);
    expect(matchRanges('Tür knarrt', 'tur kn')).toEqual([[0, 3], [4, 6]]);
    expect(normalizeName('Straße_Nacht-02')).toBe('strasse nacht 02');
  });

  it('knows audio files', () => {
    expect(isLibraryAudio('a.WAV')).toBe(true);
    expect(isLibraryAudio('a.aiff')).toBe(true);
    expect(isLibraryAudio('notes.txt')).toBe(false);
    expect(isLibraryAudio('.wav')).toBe(false);
  });
});

describe('fill selection', () => {
  let n = 0;
  const id = () => `c${n++}`;

  it('repeats a sound over the range with matching crossfades, the last one cut at the end', () => {
    const clips = fillClips({ file: 'media/wind.wav', length: 1000, start: 500, end: 3000, crossfade: 100, id });
    expect(clips.map((c) => c.start)).toEqual([500, 1400, 2300]);
    expect(clips.map((c) => c.length)).toEqual([1000, 1000, 700]);
    // each overlap is covered by a fade out and a fade in of the same length
    expect(clips[0].fadeOut).toBe(100);
    expect(clips[1].fadeIn).toBe(100);
    expect(clips[2].start + clips[2].length).toBe(3000);
    expect(clips[0].fadeIn).toBeLessThanOrEqual(50);
  });

  it('a range shorter than the sound gives one trimmed clip', () => {
    const clips = fillClips({ file: 'f', length: 1000, start: 0, end: 400, crossfade: 100, id });
    expect(clips).toHaveLength(1);
    expect(clips[0].length).toBe(400);
    expect(fillClips({ file: 'f', length: 1000, start: 10, end: 10, crossfade: 0, id })).toEqual([]);
  });
});

describe('library folder scan', () => {
  it('finds audio files in subfolders, skips hidden ones and other files, and stays inside the folder', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavepod-lib-'));
    try {
      fs.mkdirSync(path.join(dir, 'Doors', 'Old'), { recursive: true });
      fs.mkdirSync(path.join(dir, '.cache'));
      fs.writeFileSync(path.join(dir, 'Doors', 'creak.wav'), 'x');
      fs.writeFileSync(path.join(dir, 'Doors', 'Old', 'slam.mp3'), 'xx');
      fs.writeFileSync(path.join(dir, 'Doors', 'readme.txt'), 'x');
      fs.writeFileSync(path.join(dir, '.cache', 'hidden.wav'), 'x');
      fs.writeFileSync(path.join(dir, 'rain.flac'), 'xxx');
      const info = await scanLibrary(dir);
      expect(info.files.map((f) => f.path)).toEqual(['rain.flac', 'Doors/creak.wav', 'Doors/Old/slam.mp3']);
      expect(info.files[0].size).toBe(3);
      expect(libraryFilePath(dir, 'Doors/creak.wav')).toBe(path.join(dir, 'Doors', 'creak.wav'));
      expect(() => libraryFilePath(dir, '../outside.wav')).toThrow();
      expect((await scanLibrary(path.join(dir, 'missing'))).error).toBeTruthy();
      expect((await scanLibrary('')).files).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('favourite sounds', () => {
  it('reads favourites from settings: valid entries, each file once, names from the file', () => {
    expect(normalizeFavourites(null)).toEqual([]);
    expect(
      normalizeFavourites([
        { path: '/sfx/Intermission Jingle.wav', name: '  ' },
        { path: '/sfx/Intermission Jingle.wav', name: 'dupe' },
        { path: 'C:\\Sounds\\Outro v1.2.mp3' },
        { name: 'no path' },
        'junk',
        { path: '/sfx/sting.wav', name: 'Sting' },
      ]),
    ).toEqual([
      { path: '/sfx/Intermission Jingle.wav', name: 'Intermission Jingle' },
      { path: 'C:\\Sounds\\Outro v1.2.mp3', name: 'Outro v1.2' },
      { path: '/sfx/sting.wav', name: 'Sting' },
    ]);
    expect(soundFileTitle('C:\\a\\b.flac')).toBe('b');
  });

  it('adds new files at the end and keeps existing ones where they are', () => {
    const list = [{ path: '/a.wav', name: 'My intro' }];
    const r = addFavourites(list, ['/b.wav', '/a.wav', '/c.wav']);
    expect(r.added).toBe(2);
    expect(r.list).toEqual([
      { path: '/a.wav', name: 'My intro' },
      { path: '/b.wav', name: 'b' },
      { path: '/c.wav', name: 'c' },
    ]);
  });

  it('moves favourites within the list', () => {
    const list = ['/a', '/b', '/c'].map((path) => ({ path, name: path }));
    expect(moveFavourite(list, 2, -1).map((f) => f.path)).toEqual(['/a', '/c', '/b']);
    expect(moveFavourite(list, 0, -1)).toBe(list);
    expect(moveFavourite(list, 1, 5).map((f) => f.path)).toEqual(['/a', '/c', '/b']);
  });

  it('refs tell favourites from library paths', () => {
    expect(favouritePathOf(favouriteRef('/x/y.wav'))).toBe('/x/y.wav');
    expect(favouritePathOf('Doors/creak.wav')).toBeNull();
  });

  it('searches favourites by their own name and their file name', () => {
    const entries = favouriteEntries([
      { path: '/jingles/stinger_02.wav', name: 'Break jingle' },
      { path: '/sfx/room.wav', name: 'Room tone' },
    ]);
    expect(searchLibrary(entries, 'jingle').results.map((e) => e.title)).toEqual(['Break jingle']);
    expect(searchLibrary(entries, 'stinger').results.map((e) => e.title)).toEqual(['Break jingle']);
    expect(searchLibrary(entries, '').results).toHaveLength(2);
  });
});
