// Audible ACX audiobook delivery: the technical checks ACX runs on every uploaded file, a meter
// that measures what they look at, and the room tone fix for the start and end of a file.
//
// ACX rejects files that miss its submission requirements: RMS between −23 and −18 dB, peaks no
// higher than −3 dBFS, a noise floor no higher than −60 dB, 0.5 to 1 s of room tone at the head and
// 1 to 5 s at the tail, MP3 at 192 kbps or more (constant bitrate, 44.1 kHz), one chapter per file
// and no file longer than 120 minutes.
import type { AcxStats } from '../shared/types';

export const ACX_RMS_MIN = -23;
export const ACX_RMS_MAX = -18;
/** Where the leveling puts the RMS: inside the range with room on both sides. */
export const ACX_RMS_TARGET = -20;
export const ACX_PEAK_MAX = -3;
/** The limiter's ceiling (dBTP), half a dB under ACX's peak limit so MP3 encoding can't push peaks over. */
export const ACX_PEAK_CEILING = -3.5;
export const ACX_NOISE_MAX = -60;
export const ACX_HEAD_MIN = 0.5;
export const ACX_HEAD_MAX = 1;
export const ACX_TAIL_MIN = 1;
export const ACX_TAIL_MAX = 5;
/** Room tone the fix leaves at the start and end of each file (seconds). */
export const ACX_HEAD_TARGET = 0.75;
export const ACX_TAIL_TARGET = 2;
export const ACX_MAX_SECONDS = 120 * 60;
export const ACX_MIN_BITRATE = 192;
export const ACX_SAMPLE_RATE = 44100;

/** Blocks the level is followed in (seconds); the noise floor is the quietest NOISE_BLOCKS of them. */
const BLOCK_SECONDS = 0.05;
/** The noise floor is measured over 0.5 s, as ACX's own check does. */
const NOISE_BLOCKS = 10;
/** A block is speech (not room tone) above the noise floor plus this much… */
const SPEECH_OVER_NOISE_DB = 12;
/** …and no more than this far under the file's RMS. */
const SPEECH_UNDER_RMS_DB = 24;

const toDb = (power: number) => (power > 0 ? 10 * Math.log10(power) : -Infinity);

/**
 * Measures audio the way ACX checks it: RMS of the whole file, the highest sample peak, the noise
 * floor (the quietest 0.5 s, not counting digital silence), and how much room tone comes before
 * the first and after the last word. With `captureRoomTone`, it keeps the quietest 0.5 s, to fill
 * a head or tail that is too short.
 */
export class AcxMeter {
  private readonly blockFrames: number;
  private sumSq = 0;
  private frames = 0;
  private peak = 0;
  /** Mean square of every finished block. */
  private blocks: number[] = [];
  private blockSum = 0;
  private blockFill = 0;
  /** Frames of exact zeros at the start (until the first sample that isn't) and at the end. */
  private leadZeros = 0;
  private trailZeros = 0;
  private started = false;
  /** The last NOISE_BLOCKS blocks of audio (ring), for the room tone. */
  private ring: Float32Array[] | null = null;
  private ringPos = 0;
  private quietest = Infinity;
  private tone: Float32Array[] | null = null;
  private toneAt = 0;

  constructor(readonly sampleRate: number, readonly channels: number, captureRoomTone = false) {
    this.blockFrames = Math.max(1, Math.round(sampleRate * BLOCK_SECONDS));
    if (captureRoomTone) this.ring = Array.from({ length: channels }, () => new Float32Array(this.blockFrames * NOISE_BLOCKS));
  }

  push(block: Float32Array[], n: number): void {
    const ch = this.channels;
    for (let i = 0; i < n; i++) {
      let sq = 0;
      let zero = true;
      for (let c = 0; c < ch; c++) {
        const v = block[c][i];
        if (v !== 0) zero = false;
        const a = v < 0 ? -v : v;
        if (a > this.peak) this.peak = a;
        sq += v * v;
      }
      if (zero) {
        if (!this.started) this.leadZeros++;
        this.trailZeros++;
      } else {
        this.started = true;
        this.trailZeros = 0;
      }
      this.sumSq += sq;
      this.blockSum += sq / ch;
      if (this.ring) for (let c = 0; c < ch; c++) this.ring[c][this.ringPos] = block[c][i];
      this.ringPos = this.ring ? (this.ringPos + 1) % this.ring[0].length : 0;
      this.frames++;
      if (++this.blockFill === this.blockFrames) this.endBlock();
    }
  }

  private endBlock(): void {
    const ms = this.blockSum / this.blockFill;
    this.blocks.push(ms);
    this.blockSum = 0;
    this.blockFill = 0;
    const b = this.blocks;
    if (!this.ring || b.length < NOISE_BLOCKS) return;
    let sum = 0;
    for (let k = b.length - NOISE_BLOCKS; k < b.length; k++) {
      if (b[k] === 0) return; // digital silence is not room tone
      sum += b[k];
    }
    if (sum < this.quietest) {
      this.quietest = sum;
      const len = this.ring[0].length;
      // unroll the ring: the oldest sample is at ringPos
      this.tone = this.ring.map((r) => {
        const out = new Float32Array(len);
        out.set(r.subarray(this.ringPos), 0);
        out.set(r.subarray(0, this.ringPos), len - this.ringPos);
        return out;
      });
      this.toneAt = (this.frames - len) / this.sampleRate;
    }
  }

  /** The quietest 0.5 s that isn't digital silence, and where it starts (seconds); null if there is none. */
  roomTone(): { samples: Float32Array[]; at: number } | null {
    return this.tone ? { samples: this.tone, at: this.toneAt } : null;
  }

  stats(): AcxStats {
    const sr = this.sampleRate;
    const duration = this.frames / sr;
    const rmsDb = this.frames ? toDb(this.sumSq / (this.frames * this.channels)) : -Infinity;
    const peakDb = this.peak > 0 ? 20 * Math.log10(this.peak) : -Infinity;
    const b = this.blocks;
    // noise floor: the quietest 0.5 s window (sliding by one block) without digital silence
    let noise = Infinity;
    let sum = 0;
    let zeros = 0;
    for (let k = 0; k < b.length; k++) {
      sum += b[k];
      if (b[k] === 0) zeros++;
      if (k >= NOISE_BLOCKS) {
        sum -= b[k - NOISE_BLOCKS];
        if (b[k - NOISE_BLOCKS] === 0) zeros--;
      }
      if (k >= NOISE_BLOCKS - 1 && zeros === 0 && sum / NOISE_BLOCKS < noise) noise = sum / NOISE_BLOCKS;
    }
    // files shorter than the window: the quietest block
    if (!Number.isFinite(noise)) for (const x of b) if (x > 0 && x < noise) noise = x;
    const noiseFloorDb = Number.isFinite(noise) ? toDb(noise) : -Infinity;
    // room tone: the blocks before the first and after the last that is louder than room tone
    // (never closer than 10 dB under the RMS: in a file with hardly a pause, the "noise floor" is speech)
    const threshold = Math.min(Math.max(Number.isFinite(noiseFloorDb) ? noiseFloorDb + SPEECH_OVER_NOISE_DB : -Infinity, rmsDb - SPEECH_UNDER_RMS_DB), rmsDb - 10);
    let first = -1;
    let last = -1;
    if (Number.isFinite(threshold)) {
      for (let k = 0; k < b.length; k++) {
        if (toDb(b[k]) > threshold) {
          if (first < 0) first = k;
          last = k;
        }
      }
    }
    const blockSec = this.blockFrames / sr;
    // dead digital silence between the first and last sound, e.g. a gap between clips
    const lead = this.leadZeros / sr;
    const trail = this.started ? this.trailZeros / sr : duration;
    let silentGaps = false;
    for (let k = 0; k < b.length && !silentGaps; k++) {
      if (b[k] === 0 && k * blockSec >= lead + blockSec && (k + 1) * blockSec <= duration - trail - blockSec) silentGaps = true;
    }
    const head = first < 0 ? duration : first * blockSec;
    const tail = last < 0 ? duration : Math.max(0, duration - (last + 1) * blockSec);
    return {
      duration,
      rmsDb,
      peakDb,
      noiseFloorDb,
      head,
      tail,
      leadSilence: lead,
      trailSilence: trail,
      silentGaps,
    };
  }
}

/**
 * The file has room tone to loop: a quietest half second well under the speech. In a file with
 * hardly a pause, the quietest half second is still speech, and repeating that would be worse
 * than nothing.
 */
export function hasRoomTone(s: Pick<AcxStats, 'rmsDb' | 'noiseFloorDb'>): boolean {
  return Number.isFinite(s.noiseFloorDb) && s.noiseFloorDb < s.rmsDb - 15;
}

/** What the room tone fix does at each end of a file (seconds): cut off, then add room tone. */
export interface RoomTonePlan {
  trimHead: number;
  padHead: number;
  trimTail: number;
  padTail: number;
}

export const NO_ROOM_TONE_FIX: RoomTonePlan = { trimHead: 0, padHead: 0, trimTail: 0, padTail: 0 };

/**
 * Brings the room tone at both ends into ACX's range: digital silence at the ends is cut off (ACX
 * wants room tone, not dead silence), a head or tail that is too long is cut to 0.75 s / 2 s, one
 * that is too short is lengthened to that with room tone. A file with no speech is left alone.
 */
export function roomTonePlan(s: Pick<AcxStats, 'duration' | 'head' | 'tail' | 'leadSilence' | 'trailSilence'>): RoomTonePlan {
  if (s.head >= s.duration) return NO_ROOM_TONE_FIX;
  const plan = { ...NO_ROOM_TONE_FIX };
  const lead = Math.min(s.leadSilence, s.head);
  const head = s.head - lead;
  plan.trimHead = lead;
  if (head < ACX_HEAD_MIN) plan.padHead = ACX_HEAD_TARGET - head;
  else if (head > ACX_HEAD_MAX) plan.trimHead = s.head - ACX_HEAD_TARGET;
  const trail = Math.min(s.trailSilence, s.tail);
  const tail = s.tail - trail;
  plan.trimTail = trail;
  if (tail < ACX_TAIL_MIN) plan.padTail = ACX_TAIL_TARGET - tail;
  else if (tail > ACX_TAIL_MAX) plan.trimTail = s.tail - ACX_TAIL_TARGET;
  return plan;
}

/** Changes anything at all. */
export function plansAnything(p: RoomTonePlan): boolean {
  return p.trimHead > 0 || p.padHead > 0 || p.trimTail > 0 || p.padTail > 0;
}

/**
 * `frames` of room tone made from a short recording of it, looped with a 50 ms equal-power
 * crossfade at each repeat so there is no click or audible seam.
 */
export function roomToneFill(tone: Float32Array[], frames: number, sampleRate: number): Float32Array[] {
  const len = tone[0]?.length ?? 0;
  const fade = Math.min(Math.round(sampleRate * 0.05), Math.floor(len / 2));
  const period = Math.max(1, len - fade);
  return tone.map((t) => {
    const out = new Float32Array(frames);
    if (!len) return out;
    for (let i = 0; i < frames; i++) {
      const rep = Math.floor(i / period);
      const k = i - rep * period;
      if (rep > 0 && k < fade) {
        const a = k / fade;
        out[i] = t[k] * Math.sqrt(a) + t[period + k] * Math.sqrt(1 - a);
      } else out[i] = t[k];
    }
    return out;
  });
}

/** What the export does about ACX: level the RMS (and limit the peaks), fix the room tone at the ends. */
export interface AcxFixes {
  leveling: boolean;
  roomTone: boolean;
}

/**
 * The figures a file measured as `s` (before the export's gain) will have once exported with
 * `fixes`: leveled to −20 dB RMS with the peaks held at the limiter's ceiling, and the room tone
 * at both ends cut or lengthened. Room tone can only be added when there is some to loop.
 */
export function predictAcx(s: AcxStats, fixes: AcxFixes): AcxStats {
  const plan = fixes.roomTone && hasRoomTone(s) ? roomTonePlan(s) : NO_ROOM_TONE_FIX;
  const gain = fixes.leveling ? acxGainDb(s.rmsDb) : 0;
  return {
    ...s,
    duration: s.duration - plan.trimHead - plan.trimTail + plan.padHead + plan.padTail,
    rmsDb: fixes.leveling && Number.isFinite(s.rmsDb) ? ACX_RMS_TARGET : s.rmsDb,
    peakDb: fixes.leveling ? Math.min(s.peakDb + gain, ACX_PEAK_CEILING) : s.peakDb,
    noiseFloorDb: s.noiseFloorDb + gain,
    head: s.head - plan.trimHead + plan.padHead,
    tail: s.tail - plan.trimTail + plan.padTail,
    leadSilence: plan.trimHead >= s.leadSilence ? 0 : s.leadSilence,
    trailSilence: plan.trimTail >= s.trailSilence ? 0 : s.trailSilence,
  };
}

/**
 * ACX wants every chapter (and the opening and closing credits) as a file of its own: a note when
 * the export would write the whole book, or one part of it, as one file. Null when it splits.
 */
export function acxRangeNote(range: 'all' | 'selection' | 'region' | 'regions' | 'chapters', chapters: number, regions: number): string | null {
  if (range === 'chapters' || range === 'regions') return null;
  if (range === 'all' && chapters < 2 && regions < 2) {
    return 'ACX wants each chapter, and the opening and closing credits, as a file of its own. Set a chapter marker at the start of each chapter (or a region around it), then export each chapter.';
  }
  if (range === 'all') return 'ACX wants each chapter as a file of its own, but this writes the whole book as one file.';
  return null;
}

/** The gain that brings the RMS to the ACX target; 0 for silence. */
export function acxGainDb(rmsDb: number): number {
  return Number.isFinite(rmsDb) ? ACX_RMS_TARGET - rmsDb : 0;
}

/** One ACX requirement and whether a file meets it. */
export interface AcxResult {
  id: 'rms' | 'peak' | 'noise' | 'head' | 'tail' | 'length' | 'silence';
  label: string;
  /** The measured value, formatted. */
  value: string;
  ok: boolean;
  /** What is wrong and how to fix it, when it isn't ok. */
  hint?: string;
}

const db = (v: number, unit = 'dB') => (Number.isFinite(v) ? `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)} ${unit}` : `−∞ ${unit}`);
const secs = (v: number) => `${v.toFixed(v < 10 ? 2 : 0)} s`;

/**
 * Checks one file's figures against ACX's requirements. `fixes` says what the export does about
 * them, so the hints only suggest what it can't do itself.
 */
export function acxResults(s: AcxStats, fixes: AcxFixes = { leveling: false, roomTone: false }): AcxResult[] {
  const out: AcxResult[] = [];
  const rmsOk = s.rmsDb >= ACX_RMS_MIN && s.rmsDb <= ACX_RMS_MAX;
  out.push({
    id: 'rms',
    label: 'RMS level',
    value: db(s.rmsDb),
    ok: rmsOk,
    ...(rmsOk ? {} : { hint: `ACX wants −23 to −18 dB RMS. ${fixes.leveling ? '' : 'Tick Level to ACX to bring it to −20 dB.'}`.trim() }),
  });
  const peakOk = s.peakDb <= ACX_PEAK_MAX;
  out.push({ id: 'peak', label: 'Peak', value: db(s.peakDb, 'dBFS'), ok: peakOk, ...(peakOk ? {} : { hint: 'ACX wants peaks no higher than −3 dBFS. Level to ACX holds them with the limiter.' }) });
  const noiseOk = s.noiseFloorDb <= ACX_NOISE_MAX;
  out.push({
    id: 'noise',
    label: 'Noise floor',
    value: db(s.noiseFloorDb),
    ok: noiseOk,
    ...(noiseOk ? {} : { hint: 'ACX wants the room noise between words at −60 dB or lower. Add the Noise reduction or AI voice cleanup filter to the voice track (or Master), or record in a quieter room.' }),
  });
  const headOk = s.head >= ACX_HEAD_MIN && s.head <= ACX_HEAD_MAX;
  out.push({
    id: 'head',
    label: 'Room tone at the start',
    value: secs(s.head),
    ok: headOk,
    ...(headOk ? {} : { hint: `ACX wants 0.5 to 1 s of room tone before the first word.${fixes.roomTone ? '' : ' Tick Fix room tone, or move the first clip.'}` }),
  });
  const tailOk = s.tail >= ACX_TAIL_MIN && s.tail <= ACX_TAIL_MAX;
  out.push({
    id: 'tail',
    label: 'Room tone at the end',
    value: secs(s.tail),
    ok: tailOk,
    ...(tailOk ? {} : { hint: `ACX wants 1 to 5 s of room tone after the last word.${fixes.roomTone ? '' : ' Tick Fix room tone, or change the end of the range.'}` }),
  });
  const edges = s.head < s.duration && (s.leadSilence >= 0.05 || s.trailSilence >= 0.05);
  if (s.silentGaps || edges) {
    out.push({
      id: 'silence',
      label: 'Digital silence',
      value: s.silentGaps ? 'between clips' : 'at the ends',
      ok: false,
      hint: s.silentGaps
        ? 'There are gaps of dead digital silence (no room tone), for example between clips. ACX rejects them as unnatural; fill the gaps with room tone or let the clips touch.'
        : `The file ${s.leadSilence >= 0.05 ? 'starts' : 'ends'} with dead digital silence instead of room tone.${fixes.roomTone ? '' : ' Tick Fix room tone to replace it.'}`,
    });
  }
  const lengthOk = s.duration <= ACX_MAX_SECONDS;
  if (!lengthOk) out.push({ id: 'length', label: 'Length', value: `${Math.round(s.duration / 60)} min`, ok: false, hint: 'ACX takes files of up to 120 minutes. Split the chapter with a region or chapter marker.' });
  return out;
}
