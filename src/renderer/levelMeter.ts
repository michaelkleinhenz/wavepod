// Level meters with Ultraschall's target zone (−18…−6 dBFS), a peak-hold mark, the highest peak
// as a number and a clip light that stays on until clicked. State lives per meter key, so a
// meter keeps its peak and clip light when the view around it is rebuilt.
import { toDb } from '../core/dsp';
import { h } from './dom';

export const METER_FLOOR = -60;
/** The level speech should mostly sit in while recording. */
export const TARGET_ZONE: [number, number] = [-18, -6];
/** At or above this sample peak the clip light goes on. */
export const CLIP_DB = -0.1;
/** The peak-hold mark stays this long before it starts to fall. */
const HOLD_MS = 1500;
const FALL_DB_PER_S = 20;

interface MeterState {
  /** Highest peak (dBFS) since the last reset. */
  max: number;
  clipped: boolean;
  /** Peak-hold mark (dBFS) and when it was set. */
  hold: number;
  holdAt: number;
  /** Level last shown (dBFS), so a rebuilt meter starts where the old one was. */
  level: number;
}

const states = new Map<string, MeterState>();

function state(key: string): MeterState {
  let s = states.get(key);
  if (!s) {
    s = { max: -Infinity, clipped: false, hold: -Infinity, holdAt: 0, level: -Infinity };
    states.set(key, s);
  }
  return s;
}

/** Forgets all peaks and clip lights (e.g. when a new recording starts). */
export function resetAllMeters(): void {
  states.clear();
}

const pct = (db: number) => `${Math.max(0, Math.min(100, ((db - METER_FLOOR) / -METER_FLOOR) * 100))}%`;

export class LevelMeter {
  readonly el: HTMLElement;
  private bar = h('div', { class: 'meter-fill' });
  private holdMark = h('div', { class: 'meter-hold' });
  private peakText = h('span', { class: 'meter-peak' }, '–∞');
  private clipLed = h('span', { class: 'clip-led', title: 'Clip light: the signal reached 0 dBFS. Click to reset.' });

  constructor(readonly key: string, size: 'small' | 'large' = 'small') {
    const zone = h('div', { class: 'meter-zone', style: `left:${pct(TARGET_ZONE[0])};width:calc(${pct(TARGET_ZONE[1])} - ${pct(TARGET_ZONE[0])})` });
    this.el = h(
      'div',
      { class: `level-meter ${size}`, title: 'Aim for the shaded zone (−18 to −6 dBFS). Click the number or the light to reset the peak.' },
      h('div', { class: 'meter' }, zone, this.bar, this.holdMark),
      this.peakText,
      this.clipLed,
    );
    const reset = () => {
      states.delete(key);
      this.paint(state(key), -Infinity);
    };
    this.peakText.addEventListener('click', reset);
    this.clipLed.addEventListener('click', reset);
    const s = state(key);
    this.paint(s, s.level);
  }

  /** `level` is the current (already decayed) peak, linear; `peak` the raw peak since the last update. */
  update(level: number, peak = level): void {
    const s = state(this.key);
    const now = performance.now();
    const db = toDb(level, METER_FLOOR);
    s.level = db;
    const pk = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
    if (pk > s.max) s.max = pk;
    if (pk >= CLIP_DB) s.clipped = true;
    if (pk >= s.hold) {
      s.hold = pk;
      s.holdAt = now;
    } else if (now - s.holdAt > HOLD_MS) {
      s.hold = Math.max(db, s.hold - (FALL_DB_PER_S * (now - s.holdAt - HOLD_MS)) / 1000);
    }
    this.paint(s, db);
  }

  private paint(s: MeterState, db: number): void {
    this.bar.style.width = pct(db);
    this.bar.classList.toggle('hot', db > TARGET_ZONE[1]);
    this.bar.classList.toggle('clip', db > -0.5);
    const showHold = s.hold > METER_FLOOR;
    this.holdMark.style.display = showHold ? '' : 'none';
    if (showHold) this.holdMark.style.left = pct(s.hold);
    this.peakText.textContent = s.max > METER_FLOOR ? s.max.toFixed(1) : '–∞';
    this.peakText.classList.toggle('in-zone', s.max >= TARGET_ZONE[0] && s.max <= TARGET_ZONE[1]);
    this.peakText.classList.toggle('over', s.max > TARGET_ZONE[1]);
    this.clipLed.classList.toggle('on', s.clipped);
  }
}
