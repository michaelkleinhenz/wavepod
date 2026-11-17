// How a voice's direct sound changes with distance: shared by Room & distance (space.ts) and the 3D stage (binaural.ts).

/** Gain of the direct sound at a distance (m): about −4.5 dB per doubling beyond 1 m. */
export function distanceGainDb(d: number): number {
  return d <= 1 ? 0 : -15 * Math.log10(d);
}

/** High cut (Hz) of the direct sound at a distance, or 0 for none. */
export function distanceHighCut(d: number): number {
  return d <= 1.2 ? 0 : Math.max(1500, 20000 / Math.pow(d, 0.6));
}

/** Low shelf (dB at 250 Hz): proximity bass close up, thinner far away. */
export function distanceBassDb(d: number): number {
  return d < 1 ? Math.min(5, 3 * Math.log2(1 / d)) : -Math.min(6, 2 * Math.log2(d));
}
