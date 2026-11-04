// Automix: removes crosstalk between speech tracks recorded in the same room.
// Every track that takes part follows its own level; the loudest one at any moment
// stays at full level and the others are turned down by how much quieter they are,
// so a voice bleeding into a neighbour's mic disappears while two people talking at
// once both stay up. Runs in playback and export, after each track's filters, gain and pan.
import type { Track } from '../shared/types';
import { dbToGain } from '../shared/time';

export const AUTOMIX_DEFAULT_DEPTH = 18;
export const AUTOMIX_DEPTHS = [6, 12, 18, 24, 40];
/** Below this level (dBFS) on every track nobody speaks: the gains stay where they are. */
export const AUTOMIX_FLOOR_DB = -50;
/** How strongly a quieter track is turned down: 2 = 9 dB quieter than the loudest (6 dB past the tolerance) gives −12 dB. */
const SLOPE = 2;
/** A track within this many dB of the loudest counts as speaking too and stays at full level. */
const TOLERANCE_DB = 3;
/** Level follower: fast up so word onsets come through, slower down so words aren't chopped. */
const LEVEL_ATTACK_S = 0.005;
const LEVEL_RELEASE_S = 0.12;
/** Gain smoothing (in dB): opening is quick, closing slower, and short pauses don't close a track. */
const GAIN_OPEN_S = 0.01;
const GAIN_CLOSE_S = 0.1;
const HOLD_S = 0.3;

export function isAutomixed(track: Track): boolean {
  return !!track.automix?.enabled && !track.duck?.enabled;
}

/** The gain-sharing state of all automixed tracks. */
export class Automix {
  private levels: number[] = [];
  /** Current gain per track, in dB. */
  private gains: number[] = [];
  private holds: number[] = [];
  private ids: string[] = [];
  /** Timeline position the next block should start at; anything else resets the followers. */
  next = NaN;
  private readonly la: number;
  private readonly lr: number;
  private readonly go: number;
  private readonly gc: number;
  private readonly holdFrames: number;
  private readonly floor = dbToGain(AUTOMIX_FLOOR_DB);

  constructor(sampleRate: number) {
    const coef = (s: number) => 1 - Math.exp(-1 / (s * sampleRate));
    this.la = coef(LEVEL_ATTACK_S);
    this.lr = coef(LEVEL_RELEASE_S);
    this.go = coef(GAIN_OPEN_S);
    this.gc = coef(GAIN_CLOSE_S);
    this.holdFrames = Math.round(HOLD_S * sampleRate);
  }

  reset(): void {
    this.levels.fill(0);
    this.gains.fill(0);
    this.holds.fill(0);
  }

  /**
   * Fills `gains[t][0..frames)` for each track's signal `inputs[t]` (planar stereo).
   * `depths[t]` is how far (dB) track t may be turned down at most.
   */
  process(ids: string[], inputs: Float32Array[][], depths: number[], frames: number, gains: Float32Array[]): void {
    const n = ids.length;
    if (ids.join('\n') !== this.ids.join('\n')) {
      this.ids = [...ids];
      this.levels = new Array(n).fill(0);
      this.gains = new Array(n).fill(0);
      this.holds = new Array(n).fill(0);
    }
    const floors = depths.map((d) => -Math.abs(d));
    for (let i = 0; i < frames; i++) {
      let max = 0;
      for (let t = 0; t < n; t++) {
        const x = Math.max(Math.abs(inputs[t][0][i]), Math.abs(inputs[t][1][i]));
        const lv = this.levels[t];
        this.levels[t] = lv + (x - lv) * (x > lv ? this.la : this.lr);
        if (this.levels[t] > max) max = this.levels[t];
      }
      for (let t = 0; t < n; t++) {
        if (max >= this.floor) {
          // how much quieter than the loudest track, beyond the tolerance (dB, ≤ 0)
          const below = Math.min(0, 20 * Math.log10(Math.max(this.levels[t], 1e-9) / max) + TOLERANCE_DB);
          if (below >= 0) this.holds[t] = this.holdFrames;
          else if (this.holds[t] > 0) this.holds[t]--;
          const target = this.holds[t] > 0 ? 0 : Math.max(floors[t], below * SLOPE);
          const g = this.gains[t];
          this.gains[t] = g + (target - g) * (target > g ? this.go : this.gc);
        }
        gains[t][i] = dbToGain(this.gains[t]);
      }
    }
  }
}
