// The call audio of a remote guest on its way into the audio engine. It arrives from the window
// (WebRTC lives in Chromium) in small blocks on the network's clock and leaves on the audio
// device's clock, so this buffer keeps its delay bounded: it waits for a little audio before it
// starts (jitter), drops the oldest audio when it runs too full, and plays silence when it runs dry.

export interface RemoteInputStats {
  /** Frames waiting now. */
  buffered: number;
  /** Times the buffer ran dry and played silence since it was made. */
  underruns: number;
  /** Frames dropped because the buffer ran too full. */
  dropped: number;
}

export class RemoteInputBuffer {
  private buf: Float32Array;
  private readPos = 0;
  private count = 0;
  private started = false;
  underruns = 0;
  dropped = 0;

  /**
   * @param target frames to collect before playing (and again after running dry)
   * @param max most frames kept; more and the oldest go
   */
  constructor(
    readonly target: number,
    readonly max: number,
  ) {
    this.buf = new Float32Array(Math.max(max, target) + 1);
  }

  write(samples: Float32Array): void {
    const cap = this.buf.length;
    for (let i = 0; i < samples.length; i++) {
      if (this.count >= this.max) {
        // too full: forget the oldest frame so the delay stays bounded
        this.readPos = (this.readPos + 1) % cap;
        this.count--;
        this.dropped++;
      }
      this.buf[(this.readPos + this.count) % cap] = samples[i];
      this.count++;
    }
  }

  /** Fills `out[0..frames)`; silence where nothing is there (yet). */
  readInto(out: Float32Array, frames: number): void {
    if (!this.started) {
      if (this.count < this.target) {
        out.fill(0, 0, frames);
        return;
      }
      this.started = true;
    }
    const cap = this.buf.length;
    const n = Math.min(frames, this.count);
    for (let i = 0; i < n; i++) out[i] = this.buf[(this.readPos + i) % cap];
    this.readPos = (this.readPos + n) % cap;
    this.count -= n;
    if (n < frames) {
      out.fill(0, n, frames);
      // ran dry: wait for the jitter margin again before carrying on
      this.underruns++;
      this.started = false;
    }
  }

  stats(): RemoteInputStats {
    return { buffered: this.count, underruns: this.underruns, dropped: this.dropped };
  }
}

/** Jitter margin and maximum for a device buffer of `bufferSize` frames at `sampleRate`. */
export function remoteInputSizes(sampleRate: number, bufferSize: number): { target: number; max: number } {
  const target = Math.max(Math.round(0.04 * sampleRate), 2 * bufferSize);
  return { target, max: target + Math.max(Math.round(0.12 * sampleRate), 4 * bufferSize) };
}
