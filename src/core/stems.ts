// Dialogue / music / effects stems (DME): which stem each track belongs to, and the stem files.
import type { StemGroup, Track } from '../shared/types';

/** The three stems broadcasters and festivals ask for, in delivery order. */
export const STEM_GROUPS: ReadonlyArray<{ id: Exclude<StemGroup, 'none'>; label: string; file: string }> = [
  { id: 'dialogue', label: 'Dialogue', file: 'dialogue' },
  { id: 'music', label: 'Music', file: 'music' },
  { id: 'effects', label: 'Effects', file: 'effects' },
];

export const STEM_CHOICES: ReadonlyArray<{ id: StemGroup; label: string }> = [...STEM_GROUPS, { id: 'none', label: 'Leave out' }];

const MUSIC_NAME = /music|musik|bed|jingle|intro|outro|theme|score|song/i;
const DIALOGUE_NAME = /dialog|voice|stimme|sprecher|cast|speech/i;
const EFFECTS_NAME = /\bsfx\b|\bfx\b|effect|effekt|ger[äa]usch|atmo|ambien|foley|noise/i;

/**
 * The stem a track goes to: what the user chose, otherwise a guess from the track: music beds
 * (ducked tracks) and music-sounding names to music, effect-sounding names to effects,
 * everything else (the microphones) to dialogue. A folder named like a stem ("Dialogue", "SFX",
 * "Music") sends its tracks there.
 */
export function trackStem(track: Track, folderName?: string): StemGroup {
  if (track.stem) return track.stem;
  if (folderName) {
    if (MUSIC_NAME.test(folderName)) return 'music';
    if (EFFECTS_NAME.test(folderName)) return 'effects';
    if (DIALOGUE_NAME.test(folderName)) return 'dialogue';
  }
  if (MUSIC_NAME.test(track.name)) return 'music';
  if (EFFECTS_NAME.test(track.name)) return 'effects';
  if (track.duck?.enabled || track.kind === 'soundboard') return 'music';
  return 'dialogue';
}

/** Index into STEM_GROUPS, or -1 for a track left out of the stems. */
export function stemIndex(track: Track, folderName?: string): number {
  const g = trackStem(track, folderName);
  return STEM_GROUPS.findIndex((s) => s.id === g);
}

/** Path of one DME stem file ("<base>-dialogue.wav"); `me` is the music & effects mix. */
export function stemFilePath(outputBase: string, group: Exclude<StemGroup, 'none'> | 'me', ext: string): string {
  return `${outputBase}-${group === 'me' ? 'music-and-effects' : group}.${ext}`;
}
