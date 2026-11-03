export function framesToSeconds(frames: number, sampleRate: number): number {
  return frames / sampleRate;
}

export function secondsToFrames(seconds: number, sampleRate: number): number {
  return Math.round(seconds * sampleRate);
}

/** Formats as HH:MM:SS.mmm (the format used by Podlove Simple Chapters and mp4chaps). */
export function formatTimestamp(seconds: number, withMillis = true): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const totalMs = Math.round(seconds * 1000);
  const ms = totalMs % 1000;
  const totalS = Math.floor(totalMs / 1000);
  const s = totalS % 60;
  const m = Math.floor(totalS / 60) % 60;
  const h = Math.floor(totalS / 3600);
  const base = `${pad(h)}:${pad(m)}:${pad(s)}`;
  return withMillis ? `${base}.${String(ms).padStart(3, '0')}` : base;
}

/** Parses "HH:MM:SS(.mmm)", "MM:SS(.mmm)" or plain seconds. Returns NaN when invalid. */
export function parseTimestamp(text: string): number {
  const t = text.trim();
  if (!t) return NaN;
  const parts = t.split(':');
  if (parts.length > 3) return NaN;
  let total = 0;
  for (const p of parts) {
    if (!/^\d+(\.\d+)?$/.test(p)) return NaN;
    total = total * 60 + Number(p);
  }
  return total;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export function gainToDb(gain: number): number {
  return gain <= 0 ? -Infinity : 20 * Math.log10(gain);
}

let counter = 0;
export function uid(prefix = 'id'): string {
  counter = (counter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}${counter.toString(36)}`;
}
