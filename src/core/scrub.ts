// Tape-style scrubbing: while the playhead is dragged, the timeline is played at the speed and in
// the direction the mouse moves, pitch and all, like rocking a tape over the head.
//
// The mouse only says where the playhead should be (the target), in steps at the rate mouse
// events arrive. The steps are smoothed first, then the read head chases the smoothed target with a
// short time constant, so the speed comes out steady between mouse events (no 60 Hz warble), winds
// down when the mouse stops and reverses when it turns back. The timeline is read in cached chunks so that
// forward scrubbing renders it contiguously (filters stay primed) and backward scrubbing jumps
// rarely.

/** Renders `n` frames of the timeline from `pos` into `buf` (two channels, overwritten). */
export type ScrubSource = (pos: number, n: number, buf: Float32Array[]) => void;

/** How quickly the read head catches up with the (smoothed) mouse, in seconds. */
export const SCRUB_TIME_CONSTANT = 0.05;
/** Smoothing of the mouse steps, in seconds. */
const TARGET_SMOOTHING = 0.03;
/** Fastest scrub, as a multiple of normal speed (lower on heavy projects, see `budget`). */
export const SCRUB_MAX_RATE = 8;
/** Share of each audio block's duration that rendering the timeline may take while scrubbing. */
const CPU_BUDGET = 0.4;
/** The read head never falls further behind the mouse than this; beyond it, it jumps (crossfaded). */
export const SCRUB_MAX_LAG_SECONDS = 0.4;
/** Below this speed the sound fades out, so a held mouse is silent instead of a stuck sample. */
const QUIET_RATE = 0.05;
/** Filter warm-up before a jump of the source while scrubbing (playback uses more). */
export const SCRUB_WARMUP_SECONDS = 0.02;
/** Timeline chunk size the source is rendered in. */
export const SCRUB_CHUNK = 1024;
/** Backward scrubbing renders this many chunks per jump of the source. */
const BACKWARD_BATCH = 4;
const MAX_CHUNKS = 400;

export class Scrubber {
  /** Read head (timeline frames, fractional). */
  private pos = 0;
  private target = 0;
  /** The target with the mouse steps smoothed out. */
  private smooth = 0;
  /** Speed at the end of the last block (timeline frames per output frame, signed). */
  private rate = 0;
  private gain = 0;
  private chunks = new Map<number, Float32Array[]>();
  private window: Float32Array[] = [new Float32Array(0), new Float32Array(0)];
  private alt: Float32Array[] = [new Float32Array(0), new Float32Array(0)];
  private readonly tau: number;
  private readonly maxLag: number;
  private readonly smoothing: number;
  /** Measured cost of rendering one timeline frame, in ms (moving average). */
  private costPerFrame = 0;

  constructor(
    private sampleRate: number,
    private source: ScrubSource,
  ) {
    this.tau = SCRUB_TIME_CONSTANT * sampleRate;
    this.maxLag = SCRUB_MAX_LAG_SECONDS * sampleRate;
    this.smoothing = TARGET_SMOOTHING * sampleRate;
  }

  /** Where the read head is now. */
  get position(): number {
    return this.pos;
  }

  /** Current speed (1 = normal, negative = backwards). */
  get speed(): number {
    return this.rate;
  }

  /** Starts at `pos` with the tape at rest. */
  reset(pos: number): void {
    this.pos = this.target = this.smooth = Math.max(0, pos);
    this.rate = 0;
    this.gain = 0;
    this.chunks.clear();
  }

  /** Forgets rendered audio, e.g. after an edit. */
  invalidate(): void {
    this.chunks.clear();
  }

  /** Where the mouse is; the read head heads there. */
  moveTo(pos: number): void {
    this.target = Math.max(0, pos);
  }

  /** Adds `frames` of scrub audio into `out[0..1]` (from index 0). */
  render(frames: number, out: Float32Array[]): void {
    if (frames <= 0) return;
    const startRate = this.rate;
    // jump when the mouse got too far ahead, and crossfade the old run into the new one
    let jumpFrom: number | null = null;
    if (Math.abs(this.target - this.pos) > this.maxLag + SCRUB_MAX_RATE * frames) {
      jumpFrom = this.pos;
      this.pos = this.target - Math.sign(this.target - this.pos) * this.maxLag;
      this.smooth = this.pos;
    }
    this.smooth += (this.target - this.smooth) * (1 - Math.exp(-frames / this.smoothing));
    // exponential chase: speed proportional to the distance, capped
    const k = 1 - Math.exp(-frames / this.tau);
    const cap = this.maxRate(frames);
    let endRate = ((this.smooth - this.pos) * k) / frames;
    endRate = Math.max(-cap, Math.min(cap, endRate));
    const endGain = quietGain(endRate);
    const newStart = this.pos;
    this.addRun(newStart, startRate, endRate, frames, out, this.gain, endGain, jumpFrom === null ? null : 'in');
    if (jumpFrom !== null) this.addRun(jumpFrom, startRate, startRate, frames, out, this.gain, this.gain, 'out');
    this.pos = Math.max(0, newStart + ((startRate + endRate) / 2) * frames);
    this.rate = endRate;
    this.gain = endGain;
  }

  /**
   * How fast the head may go: rendering the timeline it covers has to fit comfortably into the
   * audio block, or the device runs dry and crackles. Heavy filter stacks scrub slower.
   */
  private maxRate(frames: number): number {
    if (this.costPerFrame <= 0) return SCRUB_MAX_RATE;
    const budgetMs = (frames / this.sampleRate) * 1000 * CPU_BUDGET;
    const affordable = budgetMs / this.costPerFrame; // timeline frames we can render per block
    return Math.max(1, Math.min(SCRUB_MAX_RATE, affordable / frames));
  }

  /**
   * Adds one run of the read head: from `start`, speed ramping from r0 to r1 and gain from g0 to g1
   * across the block, optionally faded in or out over the whole block (for a jump).
   */
  private addRun(start: number, r0: number, r1: number, frames: number, out: Float32Array[], g0: number, g1: number, fade: 'in' | 'out' | null): void {
    if (g0 === 0 && g1 === 0) return;
    // the span of timeline this block reads, with a frame either side for interpolation
    const travel = ((r0 + r1) / 2) * frames;
    const lo = Math.floor(Math.min(start, start + travel)) - 1;
    const hi = Math.ceil(Math.max(start, start + travel)) + 2;
    const win = this.fetch(lo, hi, r1 < 0 || (r1 === 0 && r0 < 0));
    const [wl, wr] = win;
    const [ol, or] = out;
    let p = start;
    for (let i = 0; i < frames; i++) {
      const t = (i + 0.5) / frames;
      const r = r0 + (r1 - r0) * t;
      let g = g0 + (g1 - g0) * t;
      if (fade === 'in') g *= t;
      else if (fade === 'out') g *= 1 - t;
      const x = Math.max(lo, Math.min(hi - 1, p)) - lo;
      const j = Math.floor(x);
      const f = x - j;
      const j1 = Math.min(j + 1, hi - lo - 1);
      ol[i] += (wl[j] + (wl[j1] - wl[j]) * f) * g;
      or[i] += (wr[j] + (wr[j1] - wr[j]) * f) * g;
      p += r;
    }
  }

  /** The timeline for [lo, hi) as one contiguous buffer (positions before 0 are silent). */
  private fetch(lo: number, hi: number, backward: boolean): Float32Array[] {
    const n = hi - lo;
    if (this.window[0].length < n) this.window = [new Float32Array(n), new Float32Array(n)];
    const [wl, wr] = this.window;
    const c0 = Math.floor(lo / SCRUB_CHUNK);
    const c1 = Math.floor((hi - 1) / SCRUB_CHUNK);
    for (let c = c0; c <= c1; c++) {
      const chunk = this.chunk(c, backward);
      const cs = c * SCRUB_CHUNK;
      const a = Math.max(lo, cs);
      const b = Math.min(hi, cs + SCRUB_CHUNK);
      if (!chunk) {
        wl.fill(0, a - lo, b - lo);
        wr.fill(0, a - lo, b - lo);
        continue;
      }
      wl.set(chunk[0].subarray(a - cs, b - cs), a - lo);
      wr.set(chunk[1].subarray(a - cs, b - cs), a - lo);
    }
    return this.window;
  }

  private chunk(c: number, backward: boolean): Float32Array[] | null {
    if (c < 0) return null;
    const hit = this.chunks.get(c);
    if (hit) {
      // most recently used last
      this.chunks.delete(c);
      this.chunks.set(c, hit);
      return hit;
    }
    // going backwards, render a few chunks ending at c in one go, so the source jumps less often
    let first = c;
    if (backward) while (first > 0 && c - first + 1 < BACKWARD_BATCH && !this.chunks.has(first - 1)) first--;
    const count = c - first + 1;
    const len = count * SCRUB_CHUNK;
    if (this.alt[0].length < len) this.alt = [new Float32Array(len), new Float32Array(len)];
    const buf = this.alt;
    buf[0].fill(0, 0, len);
    buf[1].fill(0, 0, len);
    const t0 = performance.now();
    this.source(first * SCRUB_CHUNK, len, buf);
    const cost = (performance.now() - t0) / len;
    this.costPerFrame = this.costPerFrame > 0 ? this.costPerFrame * 0.8 + cost * 0.2 : cost;
    for (let k = 0; k < count; k++) {
      const s = k * SCRUB_CHUNK;
      this.chunks.set(first + k, [buf[0].slice(s, s + SCRUB_CHUNK), buf[1].slice(s, s + SCRUB_CHUNK)]);
    }
    while (this.chunks.size > MAX_CHUNKS) this.chunks.delete(this.chunks.keys().next().value!);
    return this.chunks.get(c)!;
  }
}

/** Fades the sound out as the tape comes to a halt. */
function quietGain(rate: number): number {
  const x = Math.min(1, Math.abs(rate) / QUIET_RATE);
  return x * x * (3 - 2 * x);
}
