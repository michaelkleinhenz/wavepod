// Ducking: a track (typically the Soundboard or a music bed) gets quieter while the other tracks play.
import type { Track } from '../shared/types';
import { dbToGain } from '../shared/time';

export const DUCK_DEFAULT_DEPTH = 12;
/** Level of the other tracks (dBFS) above which they count as speaking. */
export const DUCK_THRESHOLD_DB = -40;
const ATTACK_S = 0.08;
const RELEASE_S = 0.6;
/** Speech pauses shorter than this don't let the ducked track come back up. */
const HOLD_S = 0.4;

export function isDucked(track: Track): boolean {
  return !!track.duck?.enabled;
}

/** Follows the level of the other tracks and turns it into a gain for the ducked ones. */
export class Ducker {
  private gain = 1;
  private hold = 0;
  private readonly attack: number;
  private readonly release: number;
  private readonly holdFrames: number;
  private readonly threshold = dbToGain(DUCK_THRESHOLD_DB);
  /** Timeline position the next block should start at; anything else resets the follower. */
  next = NaN;

  constructor(sampleRate: number) {
    this.attack = 1 - Math.exp(-1 / (ATTACK_S * sampleRate));
    this.release = 1 - Math.exp(-1 / (RELEASE_S * sampleRate));
    this.holdFrames = Math.round(HOLD_S * sampleRate);
  }

  reset(): void {
    this.gain = 1;
    this.hold = 0;
  }

  /** Fills `gains[0..frames)` from the sidechain (the other tracks, planar stereo). */
  process(side: Float32Array[], frames: number, depthDb: number, gains: Float32Array): void {
    const floor = dbToGain(-Math.abs(depthDb));
    const [l, r] = side;
    for (let i = 0; i < frames; i++) {
      const level = Math.max(Math.abs(l[i]), Math.abs(r[i]));
      if (level > this.threshold) this.hold = this.holdFrames;
      else if (this.hold > 0) this.hold--;
      const target = this.hold > 0 ? floor : 1;
      this.gain += (target - this.gain) * (target < this.gain ? this.attack : this.release);
      gains[i] = this.gain;
    }
  }
}
