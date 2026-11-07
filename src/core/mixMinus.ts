// Mix-minus: a feed for a remote guest (Zoom, Skype, a phone hybrid) that carries every live
// microphone, the soundboard and the episode playback, but not the guest's own input. Without it
// the guest hears themselves back with the call's delay, or the call loops into an echo.
//
// The live inputs reach the output callback through a small ring buffer. The input and output may
// be different devices whose clocks drift apart, so the buffer keeps its delay bounded: when it
// runs too full, the oldest audio is dropped; when it runs dry, the missing frames are silent.

import type { Track } from '../shared/types';

/** One live input channel in the guest feed and how much of it goes left and right. */
export interface MixMinusSource {
  channel: number;
  left: number;
  right: number;
}

/**
 * The inputs that go into the guest feed: every input a track records from (so a device's own
 * stereo mix channels, which would contain the guest, stay out), minus the `exclude`d ones.
 * Mono inputs go to both sides; a stereo track's two inputs go left and right.
 */
export function mixMinusSources(tracks: Track[], inputChannelCount: number, exclude: number[]): MixMinusSource[] {
  const leave = new Set(exclude);
  const seen = new Set<number>();
  const out: MixMinusSource[] = [];
  const add = (channel: number, left: number, right: number) => {
    if (channel < 0 || channel >= inputChannelCount || leave.has(channel) || seen.has(channel)) return;
    seen.add(channel);
    out.push({ channel, left, right });
  };
  for (const t of tracks) {
    if (t.kind === 'soundboard') continue;
    const ch = t.inputChannels;
    if (ch.length === 1) add(ch[0], 1, 1);
    else if (ch.length >= 2) {
      add(ch[0], 1, 0);
      add(ch[1], 0, 1);
    }
  }
  return out;
}

/** True if the feed would leave out at least one input that is actually used by a track. */
export function mixMinusLeavesOutSomething(tracks: Track[], exclude: number[]): boolean {
  return tracks.some((t) => t.kind !== 'soundboard' && t.inputChannels.some((c) => exclude.includes(c)));
}

/** A stereo ring buffer from the input callback to the output callback, with a bounded delay. */
export class MixMinusBuffer {
  private left: Float32Array;
  private right: Float32Array;
  private readPos = 0;
  private fill = 0;

  /**
   * `maxDelay`: the most frames the buffer holds before it drops the oldest; `targetDelay`: how
   * many it keeps after such a drop (a little headroom so it doesn't drop again at once).
   */
  constructor(
    readonly maxDelay: number,
    readonly targetDelay: number = Math.floor(maxDelay / 2),
  ) {
    this.left = new Float32Array(maxDelay);
    this.right = new Float32Array(maxDelay);
  }

  /** Frames waiting to be played. */
  get buffered(): number {
    return this.fill;
  }

  clear(): void {
    this.readPos = 0;
    this.fill = 0;
  }

  /** Mixes the guest feed out of one interleaved input buffer and queues it. */
  write(interleaved: Float32Array, nch: number, sources: MixMinusSource[]): void {
    const frames = Math.floor(interleaved.length / nch);
    const live = sources.filter((s) => s.channel < nch);
    const cap = this.maxDelay;
    // keep only the newest `cap` frames of a buffer larger than the whole ring
    const skip = Math.max(0, frames - cap);
    const n = frames - skip;
    if (this.fill + n > cap) {
      // the output fell behind (or isn't running): drop the oldest, down to the target delay
      const keep = Math.max(0, Math.min(this.fill, this.targetDelay - n));
      this.readPos = (this.readPos + this.fill - keep) % cap;
      this.fill = keep;
    }
    let w = (this.readPos + this.fill) % cap;
    for (let i = skip; i < frames; i++) {
      let l = 0;
      let r = 0;
      const base = i * nch;
      for (const s of live) {
        const v = interleaved[base + s.channel];
        l += v * s.left;
        r += v * s.right;
      }
      this.left[w] = l;
      this.right[w] = r;
      if (++w === cap) w = 0;
    }
    this.fill += n;
  }

  /** Adds up to `frames` queued frames into `L`/`R`; returns how many there were. */
  readInto(frames: number, L: Float32Array, R: Float32Array): number {
    const n = Math.min(frames, this.fill);
    const cap = this.maxDelay;
    let p = this.readPos;
    for (let i = 0; i < n; i++) {
      L[i] += this.left[p];
      R[i] += this.right[p];
      if (++p === cap) p = 0;
    }
    this.readPos = p;
    this.fill -= n;
    return n;
  }
}
