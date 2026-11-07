import { describe, expect, it } from 'vitest';
import { AudioEngine } from '../src/main/audio/engine';
import { createProject } from '../src/core/project';
import { tmpDir } from './helpers';

/** The engine with a fake output, so the preview can be started and rendered without a device. */
function engine(): AudioEngine {
  const e = new AudioEngine(null);
  e.setProject(createProject('Show', 48000), tmpDir());
  (e as unknown as { output: unknown }).output = {};
  return e;
}

function render(e: AudioEngine, frames: number): Float32Array[] | null {
  return (e as unknown as { renderPreview(n: number): Float32Array[] | null }).renderPreview(frames);
}

function previewing(e: AudioEngine): boolean {
  return (e as unknown as { preview: unknown }).preview !== null;
}

describe('sound library preview', () => {
  it('plays the sound', () => {
    const e = engine();
    expect(e.previewSound([new Float32Array(48000 * 5).fill(0.5)])).toBe(true);
    const out = render(e, 480)!;
    expect(out[0][100]).toBeCloseTo(0.5);
    expect(previewing(e)).toBe(true);
  });

  it('stops with a short fade when asked to, instead of playing to the end', () => {
    const e = engine();
    e.previewSound([new Float32Array(48000 * 5).fill(0.5)]);
    render(e, 480);
    e.previewSound(null);
    // 20 ms fade at 48 kHz = 960 frames, then silence
    const fade = render(e, 480)!;
    expect(fade[0][0]).toBeLessThanOrEqual(0.5);
    expect(fade[0][479]).toBeLessThan(0.5);
    render(e, 480);
    expect(previewing(e)).toBe(false);
    expect(render(e, 480)).toBeNull();
  });
});
