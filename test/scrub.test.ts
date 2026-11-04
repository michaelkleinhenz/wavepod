import { describe, expect, it } from 'vitest';
import { SCRUB_CHUNK, SCRUB_MAX_RATE, Scrubber, type ScrubSource } from '../src/core/scrub';

const SR = 48000;
const BLOCK = 480;

/** A ramp source: the sample value is the timeline position, so the output shows where the head read. */
function rampSource(calls: Array<[number, number]> = []): ScrubSource {
  return (pos, n, buf) => {
    calls.push([pos, n]);
    for (let i = 0; i < n; i++) buf[0][i] = buf[1][i] = (pos + i) / SR;
  };
}

function sineSource(freq: number): ScrubSource {
  return (pos, n, buf) => {
    for (let i = 0; i < n; i++) buf[0][i] = buf[1][i] = 0.5 * Math.sin((2 * Math.PI * freq * (pos + i)) / SR);
  };
}

function block(s: Scrubber): Float32Array {
  const out = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  s.render(BLOCK, out);
  return out[0];
}

describe('tape-style scrubbing', () => {
  it('is silent while the playhead is held still', () => {
    const s = new Scrubber(SR, sineSource(440));
    s.reset(SR);
    for (let b = 0; b < 10; b++) expect(Math.max(...block(s).map(Math.abs))).toBe(0);
  });

  it('plays at the speed the playhead moves, with the pitch following it', () => {
    const s = new Scrubber(SR, sineSource(440));
    s.reset(0);
    // move the target at exactly 1x for one second, one block at a time
    const out: number[] = [];
    for (let b = 1; b <= SR / BLOCK; b++) {
      s.moveTo(b * BLOCK);
      out.push(...block(s));
    }
    // after settling the head runs at ~1x, so the 440 Hz tone comes out at ~440 Hz
    expect(s.speed).toBeGreaterThan(0.9);
    expect(s.speed).toBeLessThan(1.1);
    const tail = out.slice(SR / 2);
    let crossings = 0;
    for (let i = 1; i < tail.length; i++) if ((tail[i - 1] < 0) !== (tail[i] < 0)) crossings++;
    expect(crossings).toBeGreaterThan(0.9 * 440);
    expect(crossings).toBeLessThan(1.1 * 440);
    // and the head trails the mouse only slightly
    expect(SR - s.position).toBeLessThan(0.1 * SR);
  });

  it('plays backwards when the playhead moves back', () => {
    const s = new Scrubber(SR, rampSource());
    s.reset(2 * SR);
    let last = Infinity;
    for (let b = 1; b <= 50; b++) {
      s.moveTo(2 * SR - b * BLOCK);
      const out = block(s);
      if (b > 10) {
        // the ramp source reads back as falling values (scaled by the fade-in gain early on)
        expect(out[BLOCK - 1]).toBeLessThan(out[0] + 1e-6);
        last = Math.min(last, s.position);
      }
    }
    expect(s.speed).toBeLessThan(-0.8);
    expect(last).toBeLessThan(2 * SR - 0.3 * SR);
  });

  it('winds down smoothly when the mouse stops', () => {
    const s = new Scrubber(SR, sineSource(220));
    s.reset(0);
    for (let b = 1; b <= 40; b++) {
      s.moveTo(b * BLOCK);
      block(s);
    }
    const target = 40 * BLOCK;
    let prev = s.speed;
    for (let b = 0; b < 40; b++) {
      block(s);
      expect(s.speed).toBeLessThanOrEqual(prev + 1e-9);
      prev = s.speed;
    }
    expect(s.speed).toBeLessThan(0.01);
    expect(Math.abs(target - s.position)).toBeLessThan(BLOCK);
    expect(Math.max(...block(s).map(Math.abs))).toBeLessThan(0.01);
  });

  it('caps the speed and jumps when the mouse runs far ahead, without a click', () => {
    const s = new Scrubber(SR, sineSource(100));
    s.reset(0);
    s.moveTo(SR * 0.01);
    for (let b = 0; b < 20; b++) block(s);
    s.moveTo(60 * SR); // a minute ahead
    const out = [...block(s), ...block(s)];
    expect(Math.abs(s.speed)).toBeLessThanOrEqual(SCRUB_MAX_RATE);
    expect(s.position).toBeGreaterThan(59 * SR);
    let maxJump = 0;
    for (let i = 1; i < out.length; i++) maxJump = Math.max(maxJump, Math.abs(out[i] - out[i - 1]));
    expect(maxJump).toBeLessThan(0.2);
  });

  it('renders the timeline contiguously when scrubbing forward', () => {
    const calls: Array<[number, number]> = [];
    const s = new Scrubber(SR, rampSource(calls));
    s.reset(0);
    for (let b = 1; b <= 400; b++) {
      s.moveTo(b * BLOCK * 2);
      block(s);
    }
    expect(calls.length).toBeGreaterThan(5);
    for (const [pos, n] of calls) {
      expect(pos % SCRUB_CHUNK).toBe(0);
      expect(n % SCRUB_CHUNK).toBe(0);
    }
    for (let i = 1; i < calls.length; i++) expect(calls[i][0]).toBe(calls[i - 1][0] + calls[i - 1][1]);
  });

  it('renders several chunks per jump when scrubbing backward', () => {
    const calls: Array<[number, number]> = [];
    const s = new Scrubber(SR, rampSource(calls));
    s.reset(10 * SR);
    for (let b = 1; b <= 400; b++) {
      s.moveTo(10 * SR - b * BLOCK);
      block(s);
    }
    const travelled = 10 * SR - s.position;
    // far fewer source jumps than chunks covered
    expect(calls.length).toBeLessThan(travelled / SCRUB_CHUNK / 2);
  });
});
