// Soundboard jingles on the timeline: the Soundboard track and the clips a triggered jingle becomes.
import type { Clip, Frames, Project } from '../shared/types';
import { uid } from '../shared/time';
import { addTrack } from './project';

export const SOUNDBOARD_TRACK_ID = 'soundboard';
/** Longest soft fade-in, in seconds. */
export const JINGLE_FADE_IN_SECONDS = 5;
/** Fade-out when a jingle is stopped by clicking it again. */
export const JINGLE_STOP_SECONDS = 1;
/** Fade-out when all jingles are stopped at once (Esc). */
export const JINGLE_PANIC_SECONDS = 0.05;

export function soundboardTrack(project: Project) {
  return project.tracks.find((t) => t.kind === 'soundboard');
}

/** Returns the project with a Soundboard track (added at the bottom if missing). */
export function ensureSoundboardTrack(project: Project): Project {
  if (soundboardTrack(project)) return project;
  return addTrack(project, { id: SOUNDBOARD_TRACK_ID, kind: 'soundboard', name: 'Soundboard', color: '#90a4ae' });
}

/** Media file a soundboard slot is rendered to, so that its clips can be played and exported like any take. */
export function jingleMediaFile(slotId: string, sampleRate: number): string {
  return `media/jingle-${slotId.replace(/[^\w-]/g, '_')}-${sampleRate}.wav`;
}

export function jingleFadeInFrames(fileLength: Frames, sampleRate: number): Frames {
  return Math.min(Math.round(JINGLE_FADE_IN_SECONDS * sampleRate), Math.floor(fileLength / 2));
}

export interface JinglePlay {
  file: string;
  fileLength: Frames;
  /** Timeline position of the trigger. */
  start: Frames;
  /** Frames played in total (may span several loop passes). */
  played: Frames;
  gain: number;
  fadeIn: Frames;
  /** Fade-out at the end, when the jingle was stopped before it finished. */
  fadeOut: Frames;
}

/** Turns one played jingle into clips: one per loop pass, with fade-in on the first and fade-out on the last. */
export function jingleClips(j: JinglePlay): Clip[] {
  const clips: Clip[] = [];
  if (j.fileLength <= 0) return clips;
  for (let done = 0; done < j.played; ) {
    const length = Math.min(j.fileLength, j.played - done);
    clips.push({ id: uid('clp'), file: j.file, start: j.start + done, offset: 0, length, gain: j.gain, fadeIn: 0, fadeOut: 0 });
    done += length;
  }
  if (clips.length) {
    const first = clips[0];
    first.fadeIn = Math.min(j.fadeIn, Math.floor(first.length / 2));
    const last = clips[clips.length - 1];
    last.fadeOut = Math.min(j.fadeOut, Math.floor(last.length / 2));
  }
  return clips;
}
