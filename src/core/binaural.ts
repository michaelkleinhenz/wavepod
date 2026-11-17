// Binaural rendering of a voice on the 3D stage: mono in, a headphone pair out that the ear hears
// as coming from a direction, height and distance. It uses a structural head model (Brown & Duda,
// "A structural model for binaural sound synthesis", 1998) rather than measured HRTF sets, so it
// needs no data files and moves smoothly:
//  - Interaural time difference: each ear is delayed by the extra path around a spherical head
//    (Woodworth), up to about 0.65 ms for a voice at the side.
//  - Head shadow: a first-order filter per ear lifts the highs on the near side and dulls them on
//    the far side, depending on how directly the sound meets that ear.
//  - Pinna and torso cues for front/back and height: voices behind lose some highs, the pinna
//    notch rises with height, voices above get a little brighter.
//  - Distance (unless a Room & distance filter does it): the same level, air and proximity bass
//    as the Room & distance filter's direct sound.
// In speakers mode the same object pans instead (angle → pan), keeping the distance cues.
import type { StagePosition } from '../shared/types';
import { Biquad } from './fx/biquad';
import { distanceBassDb, distanceGainDb, distanceHighCut } from './fx/distance';
import { panGains } from './dsp';

/** Head radius (m) and speed of sound (m/s) of the spherical head model. */
const HEAD_RADIUS = 0.0875;
const SOUND_SPEED = 343;
/** Parameters are updated every this many frames; delays and gains glide in between. */
const SUB_BLOCK = 32;
/** Brown & Duda head-shadow constants: weakest shadow factor and the angle where it is reached. */
const ALPHA_MIN = 0.1;
const THETA_MIN = (150 * Math.PI) / 180;

/** Interaural delay of one ear (s) for a sound meeting it at `theta` radians (0 = straight at the ear). */
export function earDelay(theta: number): number {
  const ac = HEAD_RADIUS / SOUND_SPEED;
  return theta < Math.PI / 2 ? ac * (1 - Math.cos(theta)) : ac * (theta - Math.PI / 2 + 1);
}

/** Head shadow factor α for a sound meeting the ear at `theta`: 2 = +6 dB highs facing it, 0.1 = -20 dB behind the head. */
export function shadowAlpha(theta: number): number {
  return 1 + ALPHA_MIN / 2 + (1 - ALPHA_MIN / 2) * Math.cos((theta / THETA_MIN) * Math.PI);
}

/** Unit direction of a stage position: x right, y front, z up. */
export function direction(pos: StagePosition): [number, number, number] {
  const az = (pos.azimuth * Math.PI) / 180;
  const el = (pos.elevation * Math.PI) / 180;
  return [Math.cos(el) * Math.sin(az), Math.cos(el) * Math.cos(az), Math.sin(el)];
}

/** Angles (radians) at which a sound from `pos` meets the left and right ear. */
export function earAngles(pos: StagePosition): [number, number] {
  const [x] = direction(pos);
  const c = Math.max(-1, Math.min(1, x));
  return [Math.acos(-c), Math.acos(c)];
}

/** First-order head-shadow filter of one ear, direct form I. */
class Shadow {
  private b0 = 1;
  private b1 = 0;
  private a1 = 0;
  private x1 = 0;
  private y1 = 0;
  constructor(private sr: number) {}

  /** H(s) = (1 + α s / 2ω0) / (1 + s / 2ω0), ω0 = c / a, by the bilinear transform. */
  set(alpha: number): void {
    const tau = HEAD_RADIUS / (2 * SOUND_SPEED);
    const k = 2 * this.sr;
    const a0 = 1 + tau * k;
    this.b0 = (1 + alpha * tau * k) / a0;
    this.b1 = (1 - alpha * tau * k) / a0;
    this.a1 = (1 - tau * k) / a0;
  }

  tick(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 - this.a1 * this.y1;
    this.x1 = x;
    this.y1 = Math.abs(y) < 1e-25 ? 0 : y;
    return y;
  }

  reset(): void {
    this.x1 = this.y1 = 0;
  }
}

/** Shortest way from angle a to b (degrees), so a voice walking behind the head doesn't swing round the front. */
function azimuthStep(a: number, b: number): number {
  let d = b - a;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

export interface StageRenderOptions {
  /** Speakers mode: pan by the angle instead of binaural. */
  speakers?: boolean;
  /** Apply distance level, air and bass here (off when a Room & distance filter does it). */
  distanceCues?: boolean;
}

/** Renders one voice at a moving stage position; keeps its own filter and delay state. */
export class StageRenderer {
  private delayBuf: Float32Array;
  private delayPos = 0;
  private shadowL: Shadow;
  private shadowR: Shadow;
  /** Mono cues: pinna/torso shelf (front/back, height), pinna notch, distance air and bass. */
  private shelf: Biquad;
  private notch: Biquad;
  private air: Biquad;
  private bass: Biquad;
  private cur: StagePosition | null = null;
  /** Current per-ear delay (frames) and gains, gliding to the targets. */
  private dL = 0;
  private dR = 0;
  private gL = 1;
  private gR = 1;
  private cueKey = '';
  private airKey = '';

  constructor(private sr: number) {
    // the longest interaural delay plus room for interpolation
    this.delayBuf = new Float32Array(Math.ceil(0.002 * sr) + 4);
    this.shadowL = new Shadow(sr);
    this.shadowR = new Shadow(sr);
    this.shelf = new Biquad('highshelf', 4000, sr, Math.SQRT1_2, 0);
    this.notch = new Biquad('peaking', 7000, sr, 3, 0);
    this.air = new Biquad('lowpass', sr * 0.49, sr, Math.SQRT1_2);
    this.bass = new Biquad('lowshelf', 250, sr, Math.SQRT1_2, 0);
  }

  /** Forgets the filter state and the last position (after a jump in playback). */
  reset(): void {
    this.delayBuf.fill(0);
    this.delayPos = 0;
    this.shadowL.reset();
    this.shadowR.reset();
    this.shelf.reset();
    this.notch.reset();
    this.air.reset();
    this.bass.reset();
    this.cur = null;
  }

  /**
   * Renders `n` frames of `mono` into `outL`/`outR` (overwritten), moving from the previous call's
   * position to `target` across the block. `mono` must not be one of the outputs.
   */
  process(mono: Float32Array, outL: Float32Array, outR: Float32Array, n: number, target: StagePosition, opts: StageRenderOptions = {}): void {
    const from = this.cur ?? target;
    const first = !this.cur;
    const dAz = azimuthStep(from.azimuth, target.azimuth);
    const buf = this.delayBuf;
    const len = buf.length;
    let wp = this.delayPos;
    for (let start = 0; start < n; start += SUB_BLOCK) {
      const m = Math.min(SUB_BLOCK, n - start);
      const f = Math.min(1, (start + m) / n);
      const pos: StagePosition = {
        azimuth: from.azimuth + dAz * f,
        elevation: from.elevation + (target.elevation - from.elevation) * f,
        // distance glides in the log domain, as it is heard
        distance: from.distance * Math.pow(target.distance / from.distance, f),
      };
      const { delayL, delayR, gainL, gainR } = this.update(pos, opts);
      if (first && start === 0) {
        this.dL = delayL;
        this.dR = delayR;
        this.gL = gainL;
        this.gR = gainR;
      }
      const stepDL = (delayL - this.dL) / m;
      const stepDR = (delayR - this.dR) / m;
      const stepGL = (gainL - this.gL) / m;
      const stepGR = (gainR - this.gR) / m;
      for (let i = start; i < start + m; i++) {
        let x = this.bass.tick(this.air.tick(mono[i], 0), 0);
        x = this.notch.tick(this.shelf.tick(x, 0), 0);
        buf[wp] = x;
        this.dL += stepDL;
        this.dR += stepDR;
        this.gL += stepGL;
        this.gR += stepGR;
        const l = readDelay(buf, wp, this.dL, len);
        const r = readDelay(buf, wp, this.dR, len);
        if (opts.speakers) {
          outL[i] = l * this.gL;
          outR[i] = r * this.gR;
        } else {
          outL[i] = this.shadowL.tick(l) * this.gL;
          outR[i] = this.shadowR.tick(r) * this.gR;
        }
        if (++wp === len) wp = 0;
      }
    }
    this.delayPos = wp;
    this.cur = { ...target };
  }

  /** Sets the filters for a position and returns the per-ear delays (frames) and gains it wants. */
  private update(pos: StagePosition, opts: StageRenderOptions): { delayL: number; delayR: number; gainL: number; gainR: number } {
    const [x, y, z] = direction(pos);
    const dist = opts.distanceCues === false ? 1 : pos.distance;
    const level = Math.pow(10, distanceGainDb(dist) / 20);
    // air and proximity bass, as the Room & distance filter's direct sound
    const hc = distanceHighCut(dist);
    const bassDb = distanceBassDb(dist);
    const airKey = `${hc.toFixed(0)}/${bassDb.toFixed(2)}`;
    if (airKey !== this.airKey) {
      this.airKey = airKey;
      this.air.set('lowpass', hc || this.sr * 0.49, this.sr, Math.SQRT1_2);
      this.bass.set('lowshelf', 250, this.sr, Math.SQRT1_2, Math.abs(bassDb) < 0.05 ? 0 : bassDb);
    }
    if (opts.speakers) {
      const [pl, pr] = panGains(x);
      this.setCues(0, 0);
      return { delayL: 0, delayR: 0, gainL: pl * level, gainR: pr * level };
    }
    // behind the head the pinna shades the highs; above, they open up a little. The fixed +2 dB
    // makes up for the head shadow's dulling straight ahead (diffuse-field balance).
    const behind = Math.max(0, -y);
    const shelfDb = 2 - 8 * behind + (z > 0 ? 3 * z : 2 * z);
    // the pinna notch moves up with height (about 6 kHz below ear level to 11 kHz above) and fades overhead
    const notchHz = Math.min(11000, Math.max(5500, 7500 * Math.pow(2, (pos.elevation / 45) * 0.6)));
    const notchDb = -9 * (1 - Math.max(0, z) * 0.8);
    this.setCues(shelfDb, notchDb, notchHz);
    const [thL, thR] = earAngles(pos);
    this.shadowL.set(shadowAlpha(thL));
    this.shadowR.set(shadowAlpha(thR));
    const tl = earDelay(thL);
    const tr = earDelay(thR);
    const base = Math.min(tl, tr);
    return { delayL: (tl - base) * this.sr, delayR: (tr - base) * this.sr, gainL: level, gainR: level };
  }

  private setCues(shelfDb: number, notchDb: number, notchHz = 7500): void {
    const key = `${shelfDb.toFixed(2)}/${notchDb.toFixed(2)}/${notchHz.toFixed(0)}`;
    if (key === this.cueKey) return;
    this.cueKey = key;
    this.shelf.set('highshelf', 4000, this.sr, Math.SQRT1_2, shelfDb);
    this.notch.set('peaking', notchHz, this.sr, 3, notchDb);
  }
}

/** Reads `delay` frames (fractional, linear interpolation) behind the write position `wp`. */
function readDelay(buf: Float32Array, wp: number, delay: number, len: number): number {
  const d = Math.max(0, delay);
  const di = Math.floor(d);
  const frac = d - di;
  let a = wp - di;
  if (a < 0) a += len;
  let b = a - 1;
  if (b < 0) b += len;
  return buf[a] + (buf[b] - buf[a]) * frac;
}
