// Space: puts a voice into a room (kitchen, car, church, forest…) and at a distance from the
// listener. One filter does what would otherwise take a reverb, an EQ and a volume change:
//  - Distance turns the direct sound down, takes away highs (air) and, close up, adds the bass of
//    the proximity effect; far away the bass thins out. The room stays as loud, so a voice moving
//    away sounds more and more "in the room".
//  - Early reflections (a few discrete echoes off nearby walls) give the size and shape of a room;
//    the late reverb tail (Freeverb network, see reverb.ts) gives its decay.
//  - On a track placed on the 3D stage (Track.stage), the stage sets the distance and the direct
//    sound is rendered at the voice's place (binaural.ts), while the room stays all around.
import type { FxProcessor } from './processors';
import { Biquad } from './biquad';
import { Reverb } from './reverb';
import type { StagePosition } from '../../shared/types';
import { StageRenderer } from '../binaural';
import { distanceBassDb, distanceGainDb, distanceHighCut } from './distance';

/** Early reflection pattern: relative times (of the room's reflection span), gains and sides. */
const TAPS = [
  [0.13, 1.0, 0.85],
  [0.21, 0.82, 0.2],
  [0.34, 0.74, 0.7],
  [0.45, 0.62, 0.3],
  [0.57, 0.55, 0.9],
  [0.68, 0.46, 0.1],
  [0.82, 0.38, 0.6],
  [1.0, 0.3, 0.4],
] as const;
const TAP_NORM = 1 / Math.sqrt(TAPS.reduce((s, [, g]) => s + g * g, 0));

export { distanceBassDb, distanceGainDb, distanceHighCut };

/** Span of the early reflections in ms for a room size in %. */
const reflectionSpanMs = (size: number) => 3 + 0.9 * size;

export class Space implements FxProcessor {
  readonly latency = 0;
  private reverb: Reverb;
  private direct = 1;
  private air: Biquad | null = null;
  private bass: Biquad | null = null;
  private room = 0;
  private early = 0;
  private taps: Array<{ delay: number; gL: number; gR: number }> = [];
  private erBuf: Float32Array;
  private erPos = 0;
  /** One-pole low-pass on the reflections: soft surfaces swallow highs. */
  private erDamp = 0;
  private erLp = [0, 0];
  private mono = new Float32Array(0);
  private wetL = new Float32Array(0);
  private wetR = new Float32Array(0);
  private key = '';
  private params: Record<string, number> = {};
  /** The voice's place on the 3D stage, when its track is placed there (see setStage). */
  private stage: StagePosition | null = null;
  private stageSpeakers = false;
  private stageDist = NaN;
  private renderer: StageRenderer | null = null;
  constructor(private sr: number) {
    this.reverb = new Reverb(sr);
    this.erBuf = new Float32Array(Math.ceil(0.35 * sr));
  }

  setParams(p: Record<string, number>): void {
    this.params = p;
    this.apply();
  }

  /**
   * Places the voice on the 3D stage (null: not placed). The stage's distance replaces the
   * filter's own, and the direct sound comes from the voice's direction; reflections and reverb
   * stay around the listener. Called by the mixer before every block.
   */
  setStage(pos: StagePosition | null, speakers = false): void {
    if (!pos) {
      if (this.stage) {
        this.stage = null;
        this.renderer = null;
        this.stageDist = NaN;
        this.apply();
      }
      return;
    }
    this.stage = pos;
    this.stageSpeakers = speakers;
    if (!this.renderer) this.renderer = new StageRenderer(this.sr);
    // the room is only re-tuned when the distance changes by more than about 1 %
    if (!(Math.abs(Math.log(pos.distance / this.stageDist)) < 0.01)) {
      this.stageDist = pos.distance;
      this.apply();
    }
  }

  private apply(): void {
    const p = this.params;
    const d = Math.max(0.1, this.stage ? this.stageDist : p.distance ?? 1);
    const size = p.size ?? 40;
    const damping = p.damping ?? 50;
    // The gap between the direct sound and the first reflections shrinks as the source moves away.
    const predelay = (p.predelay ?? 10) / (1 + d / 4);
    this.reverb.setParams({ size, decay: p.decay ?? 0.5, damping, mix: 100, predelay: predelay + reflectionSpanMs(size) * 0.4, width: p.width ?? 100 });
    this.direct = Math.pow(10, distanceGainDb(d) / 20);
    this.room = (p.room ?? 12) / 100;
    this.early = ((p.early ?? 20) / 100) * TAP_NORM * 0.7;
    this.erDamp = Math.exp((-2 * Math.PI * Math.max(800, 14000 * (1 - (damping / 100) * 0.85))) / this.sr);
    const span = reflectionSpanMs(size);
    const w = (p.width ?? 100) / 100;
    this.taps = TAPS.map(([t, g, side]) => {
      const pan = 0.5 + (side - 0.5) * w;
      return {
        delay: Math.min(this.erBuf.length - 1, Math.max(1, Math.round(((predelay + t * span) / 1000) * this.sr))),
        gL: g * Math.cos((pan * Math.PI) / 2) * Math.SQRT2,
        gR: g * Math.sin((pan * Math.PI) / 2) * Math.SQRT2,
      };
    });
    const hc = distanceHighCut(d);
    const bass = distanceBassDb(d);
    const key = `${hc}/${bass.toFixed(2)}`;
    if (key !== this.key) {
      this.key = key;
      if (!hc) this.air = null;
      else if (this.air) this.air.set('lowpass', hc, this.sr, Math.SQRT1_2);
      else this.air = new Biquad('lowpass', hc, this.sr, Math.SQRT1_2);
      if (Math.abs(bass) < 0.1) this.bass = null;
      else if (this.bass) this.bass.set('lowshelf', 250, this.sr, Math.SQRT1_2, bass);
      else this.bass = new Biquad('lowshelf', 250, this.sr, Math.SQRT1_2, bass);
    }
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    if (this.mono.length < n) {
      this.mono = new Float32Array(n);
      this.wetL = new Float32Array(n);
      this.wetR = new Float32Array(n);
    }
    const { mono, wetL, wetR, erBuf, taps, early, erDamp } = this;
    for (let i = 0; i < n; i++) mono[i] = (L[i] + R[i]) * 0.5;
    wetL.fill(0, 0, n);
    wetR.fill(0, 0, n);
    // early reflections
    const len = erBuf.length;
    let pos = this.erPos;
    let [lpL, lpR] = this.erLp;
    for (let i = 0; i < n; i++) {
      erBuf[pos] = mono[i];
      let l = 0;
      let r = 0;
      for (const t of taps) {
        let k = pos - t.delay;
        if (k < 0) k += len;
        const v = erBuf[k];
        l += v * t.gL;
        r += v * t.gR;
      }
      lpL = l + erDamp * (lpL - l);
      lpR = r + erDamp * (lpR - r);
      wetL[i] = lpL * early;
      wetR[i] = lpR * early;
      if (++pos === len) pos = 0;
    }
    this.erPos = pos;
    this.erLp = [Math.abs(lpL) < 1e-25 ? 0 : lpL, Math.abs(lpR) < 1e-25 ? 0 : lpR];
    // late reverb
    if (this.room > 0) this.reverb.addWet(mono, wetL, wetR, n, this.room);
    // direct sound at its distance
    if (this.bass) {
      this.bass.process(L, n, 0);
      this.bass.process(R, n, 1);
    }
    if (this.air) {
      this.air.process(L, n, 0);
      this.air.process(R, n, 1);
    }
    const g = this.direct;
    if (this.stage && this.renderer) {
      // the direct sound from the voice's place; distance level and air are already applied above
      for (let i = 0; i < n; i++) mono[i] = (L[i] + R[i]) * 0.5 * g;
      this.renderer.process(mono, L, R, n, this.stage, { speakers: this.stageSpeakers, distanceCues: false });
      for (let i = 0; i < n; i++) {
        L[i] += wetL[i];
        R[i] += wetR[i];
      }
      return;
    }
    for (let i = 0; i < n; i++) {
      L[i] = L[i] * g + wetL[i];
      R[i] = R[i] * g + wetR[i];
    }
  }

  reset(): void {
    this.reverb.reset();
    this.erBuf.fill(0);
    this.erPos = 0;
    this.erLp = [0, 0];
    this.air?.reset();
    this.bass?.reset();
    this.renderer?.reset();
  }
}
