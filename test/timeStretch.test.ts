import { describe, expect, it } from 'vitest';
import { TimeStretcher, type StretchSource } from '../src/core/timeStretch';

const SR = 48000;

function sineSource(freq: number, calls: Array<[number, number]> = []): StretchSource {
  return (pos, n, buf) => {
    calls.push([pos, n]);
    for (let i = 0; i < n; i++) {
      const v = 0.5 * Math.sin((2 * Math.PI * freq * (pos + i)) / SR);
      buf[0][i] = v;
      buf[1][i] = v;
    }
  };
}

function render(st: TimeStretcher, frames: number): Float32Array {
  const out = [new Float32Array(frames), new Float32Array(frames)];
  // in device-sized blocks, like the audio callback
  const block = 512;
  const tmp = [new Float32Array(block), new Float32Array(block)];
  for (let done = 0; done < frames; done += block) {
    const n = Math.min(block, frames - done);
    st.pull(n, tmp);
    out[0].set(tmp[0].subarray(0, n), done);
  }
  return out[0];
}

function zeroCrossings(x: Float32Array): number {
  let c = 0;
  for (let i = 1; i < x.length; i++) if ((x[i - 1] < 0) !== (x[i] < 0)) c++;
  return c;
}

describe('time stretch', () => {
  it('passes audio through unchanged at 1x', () => {
    const st = new TimeStretcher(SR, sineSource(440), 1);
    st.reset(1000);
    const out = render(st, SR / 2);
    for (let i = 0; i < out.length; i += 97) expect(out[i]).toBeCloseTo(0.5 * Math.sin((2 * Math.PI * 440 * (1000 + i)) / SR), 4);
  });

  it('plays twice as fast at 2x but keeps the pitch', () => {
    const calls: Array<[number, number]> = [];
    const st = new TimeStretcher(SR, sineSource(440, calls), 2);
    st.reset(0);
    const out = render(st, SR); // one second of output
    // same pitch: ~880 zero crossings per second
    expect(zeroCrossings(out.subarray(SR / 10))).toBeGreaterThan(0.9 * 880 * 0.9);
    expect(zeroCrossings(out.subarray(SR / 10))).toBeLessThan(1.1 * 880 * 0.9);
    // two seconds of the timeline went by
    expect(st.position).toBeGreaterThan(1.95 * SR);
    expect(st.position).toBeLessThan(2.05 * SR);
    // the source is read in one contiguous run (filters downstream depend on it)
    for (let i = 1; i < calls.length; i++) expect(calls[i][0]).toBe(calls[i - 1][0] + calls[i - 1][1]);
    // and no clicks: the level stays smooth
    let maxJump = 0;
    for (let i = 1; i < out.length; i++) maxJump = Math.max(maxJump, Math.abs(out[i] - out[i - 1]));
    expect(maxJump).toBeLessThan(0.1);
  });

  it('restarts cleanly after a reset', () => {
    const st = new TimeStretcher(SR, sineSource(220), 1.5);
    st.reset(0);
    render(st, 10000);
    st.reset(SR * 10);
    expect(st.position).toBe(SR * 10);
    render(st, 4800);
    expect(st.position).toBeGreaterThan(SR * 10 + 4800 * 1.5 - 2000);
  });
});
