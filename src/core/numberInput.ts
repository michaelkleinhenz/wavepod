// Reading numbers typed into a slider's value field ("-3,5 dB", "1.2 kHz", "4:1", "250 ms").

export interface NumberInputSpec {
  min: number;
  max: number;
  /** Unit the value is stored in, e.g. 'dB', 'Hz', 'ms', ':1', '%'. */
  unit?: string;
  /** Typed values are rounded to this (default: no rounding). */
  precision?: number;
}

const SCALE: Record<string, Record<string, number>> = {
  Hz: { hz: 1, khz: 1000, k: 1000 },
  ms: { ms: 1, s: 1000, sec: 1000 },
  s: { s: 1, sec: 1, ms: 0.001 },
};

/**
 * Turns typed text into a value of the given range, or null when there is no number in it.
 * Accepts a decimal comma, a Unicode minus, a leading "+", and the unit itself or a related one
 * (kHz for Hz, s for ms), so what a slider shows can be typed back as it is.
 */
export function parseNumberInput(text: string, spec: NumberInputSpec): number | null {
  const s = text.trim().replace(/[−–]/g, '-').replace(/\s+/g, '');
  const m = /^([+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+))(?:e([+-]?\d+))?(.*)$/i.exec(s);
  if (!m) return null;
  let v = Number(m[1].replace(',', '.')) * (m[2] ? Math.pow(10, Number(m[2])) : 1);
  if (!Number.isFinite(v)) return null;
  const suffix = m[3].toLowerCase();
  if (suffix) {
    const own = (spec.unit ?? '').toLowerCase().replace(/\s+/g, '');
    const scale = SCALE[spec.unit ?? '']?.[suffix];
    if (scale !== undefined) v *= scale;
    else if (suffix !== own) return null;
  }
  if (spec.precision && spec.precision > 0) v = Math.round(v / spec.precision) * spec.precision;
  v = Math.min(spec.max, Math.max(spec.min, v));
  // tidy float noise from the rounding (0.30000000000000004)
  return Number(v.toFixed(10));
}

/** Display precision of a slider with this step: 0.01, 0.1 or 1. */
export function precisionForStep(step: number): number {
  return step < 0.1 ? 0.01 : step < 1 ? 0.1 : 1;
}

/** The leading number of a formatted value ("-6.02 dB" → -6.02), or null. */
export function leadingNumber(text: string): number | null {
  const m = /^\s*([+\-−]?(?:\d+(?:[.,]\d*)?|[.,]\d+))/.exec(text);
  if (!m) return null;
  const v = Number(m[1].replace('−', '-').replace(',', '.'));
  return Number.isFinite(v) ? v : null;
}

/**
 * Finds the normalized value (0..1) whose formatted text shows `target`, for plug-ins that cannot
 * parse text themselves. Assumes the display is monotonic in the normalized value; returns null
 * when the ends don't read as numbers or `target` lies outside them.
 */
export function searchNormalized(target: number, numberAt: (normalized: number) => number | null, iterations = 24): number | null {
  const lo = numberAt(0);
  const hi = numberAt(1);
  if (lo === null || hi === null || lo === hi) return null;
  const rising = hi > lo;
  if (target <= Math.min(lo, hi)) return rising ? 0 : 1;
  if (target >= Math.max(lo, hi)) return rising ? 1 : 0;
  let a = 0;
  let b = 1;
  for (let i = 0; i < iterations; i++) {
    const mid = (a + b) / 2;
    const v = numberAt(mid);
    if (v === null) return null;
    if (v < target === rising) a = mid;
    else b = mid;
  }
  const va = numberAt(a);
  const vb = numberAt(b);
  if (va === null || vb === null) return (a + b) / 2;
  return Math.abs(va - target) <= Math.abs(vb - target) ? a : b;
}
