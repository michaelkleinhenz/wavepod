// Marker ping: a short beep when playback passes a marker (optional, off by default).
import type { Frames, Marker } from '../shared/types';

/** Markers with from <= position < to (playback moved forward over them). */
export function markersCrossed(markers: readonly Marker[], from: Frames, to: Frames): Marker[] {
  if (to <= from) return [];
  return markers.filter((m) => m.position >= from && m.position < to);
}

/** The ping: 80 ms, smooth envelope; higher for chapters, lower for edit markers. */
export function pingTone(sampleRate: number, kind: Marker['kind'] = 'chapter'): Float32Array {
  const n = Math.round(sampleRate * 0.08);
  const f = kind === 'chapter' ? 1320 : 880;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const env = Math.sin((Math.PI * i) / n) ** 2;
    out[i] = 0.25 * env * Math.sin((2 * Math.PI * f * i) / sampleRate);
  }
  return out;
}
