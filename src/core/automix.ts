// Automix: removes crosstalk between speech tracks recorded in the same room.
// Every track that takes part follows its own level; the loudest one at any moment
// stays at full level and the others are turned down by how much quieter they are,
// so a voice bleeding into a neighbour's mic disappears while two people talking at
// once both stay up. A track only opens fully once it has stayed close to the loudest one for
// a moment (or is clearly the loudest): a single word that bleeds in louder than usual must not
// bring the other speaker's crosstalk and room sound through. Runs in playback and export, after each track's filters, gain and pan.
import type { Track } from '../shared/types';
import { dbToGain } from '../shared/time';

export const AUTOMIX_DEFAULT_DEPTH = 18;
export const AUTOMIX_DEPTHS = [6, 12, 18, 24, 40];
/** Below this level (dBFS) on every track nobody speaks: the gains stay where they are. */
export const AUTOMIX_FLOOR_DB = -50;
/** How strongly a quieter track is turned down: 2 = 9 dB quieter than the loudest (6 dB past the tolerance) gives −12 dB. */
const SLOPE = 2;
/** A track within this many dB of the loudest other track may be speaking too (double talk). */
const TOLERANCE_DB = 3;
/**
 * Being within the tolerance only counts as speaking once it lasts this long. A word that
 * bleeds into a neighbour's mic a little louder than usual reaches the tolerance for a moment
 * only; real speech stays there for whole syllables.
 */
const CLAIM_S = 0.04;
/** A track this many dB louder than every other one is speaking right away (no waiting). */
const LEAD_DB = 6;
/** Until a track has proven it speaks, it stays at least this far down (dB). */
const UNCLAIMED_DB = -9;
/** The pause hold ends as soon as another track is this many dB louder: that's not a pause, someone else talks. */
const OUTVOICED_DB = 6;
/** Level follower (on the signal's power): fast up so word onsets come through, slower down so words aren't chopped. */
const LEVEL_ATTACK_S = 0.01;
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
  /** How long (frames) each track has been within the tolerance of the loudest other one. */
  private near: number[] = [];
  private ids: string[] = [];
  /** Timeline position the next block should start at; anything else resets the followers. */
  next = NaN;
  private readonly la: number;
  private readonly lr: number;
  private readonly go: number;
  private readonly gc: number;
  private readonly holdFrames: number;
  private readonly claimFrames: number;
  /** The floor as power. */
  private readonly floor = dbToGain(AUTOMIX_FLOOR_DB) ** 2;

  constructor(sampleRate: number) {
    const coef = (s: number) => 1 - Math.exp(-1 / (s * sampleRate));
    this.la = coef(LEVEL_ATTACK_S);
    this.lr = coef(LEVEL_RELEASE_S);
    this.go = coef(GAIN_OPEN_S);
    this.gc = coef(GAIN_CLOSE_S);
    this.holdFrames = Math.round(HOLD_S * sampleRate);
    this.claimFrames = Math.round(CLAIM_S * sampleRate);
  }

  reset(): void {
    this.levels.fill(0);
    this.gains.fill(0);
    this.holds.fill(0);
    this.near.fill(0);
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
      this.near = new Array(n).fill(0);
    }
    const floors = depths.map((d) => -Math.abs(d));
    for (let i = 0; i < frames; i++) {
      // the two loudest tracks, so each track can be compared with the loudest *other* one
      let max = 0;
      let second = 0;
      let top = -1;
      for (let t = 0; t < n; t++) {
        const l = inputs[t][0][i];
        const r = inputs[t][1][i];
        const x = (l * l + r * r) / 2;
        const lv = this.levels[t];
        const v = (this.levels[t] = lv + (x - lv) * (x > lv ? this.la : this.lr));
        if (v > max) {
          second = max;
          max = v;
          top = t;
        } else if (v > second) second = v;
      }
      for (let t = 0; t < n; t++) {
        if (max >= this.floor) {
          // how much louder (> 0) or quieter (< 0) than the loudest other track, in dB
          const other = Math.max(t === top ? second : max, 1e-12);
          const lead = 10 * Math.log10(Math.max(this.levels[t], 1e-12) / other);
          if (lead >= -TOLERANCE_DB) this.near[t]++;
          else this.near[t] = 0;
          if (lead >= LEAD_DB || this.near[t] >= this.claimFrames)
            this.holds[t] = this.holdFrames;
          else if (lead <= -OUTVOICED_DB) this.holds[t] = 0;
          else if (this.holds[t] > 0) this.holds[t]--;
          let target: number;
          if (this.holds[t] > 0) target = 0;
          else target = Math.max(floors[t], Math.min(UNCLAIMED_DB, Math.min(0, lead + TOLERANCE_DB) * SLOPE));
          const g = this.gains[t];
          this.gains[t] = g + (target - g) * (target > g ? this.go : this.gc);
        }
        gains[t][i] = dbToGain(this.gains[t]);
      }
    }
  }
}
