// Export settings that stay with an episode and its template, and the loudness targets to pick from.
import type { ExportSettings } from '../shared/types';

/** For a new episode with nothing remembered: one MP3 with chapters, normalised for podcast apps. */
export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  formats: ['mp3'],
  mp3Bitrate: 128,
  normalize: true,
  targetLufs: -16,
  peakCeiling: -1,
  stems: false,
  chapterFiles: true,
};

export const MP3_BITRATES = [64, 96, 128, 160, 192, 256];
export const OPUS_BITRATES = [32, 48, 64, 96, 128];
export const PEAK_CEILINGS = [-0.1, -1, -2, -3];

export const LOUDNESS_TARGETS = [
  { label: 'Spotify / YouTube (−14 LUFS)', value: -14 },
  { label: 'Podcast stereo (−16 LUFS)', value: -16 },
  { label: 'Podcast mono / Apple (−19 LUFS)', value: -19 },
  { label: 'EBU R128 broadcast (−23 LUFS)', value: -23 },
];
/** A custom target must lie in this range (LUFS). */
export const CUSTOM_TARGET_MIN = -30;
export const CUSTOM_TARGET_MAX = -9;

export function isPresetTarget(lufs: number): boolean {
  return LOUDNESS_TARGETS.some((t) => t.value === lufs);
}

/** A typed target, rounded to 0.5 LU and kept in range; null if it isn't a number. */
export function clampTarget(v: number): number | null {
  if (!Number.isFinite(v)) return null;
  return Math.max(CUSTOM_TARGET_MIN, Math.min(CUSTOM_TARGET_MAX, Math.round(v * 2) / 2));
}

/**
 * Mono podcasts are usually published at −19 LUFS (a mono file measured as mono reads 3 LU lower
 * than the same audio in stereo), so ticking mono moves −16 to −19, and unticking moves it back.
 * Any other target is left as it is.
 */
export function targetForMono(lufs: number, mono: boolean): number {
  if (mono && lufs === -16) return -19;
  if (!mono && lufs === -19) return -16;
  return lufs;
}

const FORMATS = ['mp3', 'wav', 'flac', 'opus'] as const;

/** Checks settings read from a project or template file; anything missing or wrong takes the default. */
export function normalizeExportSettings(raw: unknown): ExportSettings | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Partial<ExportSettings>;
  const d = DEFAULT_EXPORT_SETTINGS;
  const num = (v: unknown, ok: (n: number) => boolean, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && ok(v) ? v : fallback);
  const formats = Array.isArray(r.formats) ? FORMATS.filter((f) => r.formats!.includes(f)) : d.formats;
  return {
    formats,
    mp3Bitrate: num(r.mp3Bitrate, (n) => MP3_BITRATES.includes(n), d.mp3Bitrate),
    ...(r.opusBitrate !== undefined ? { opusBitrate: num(r.opusBitrate, (n) => OPUS_BITRATES.includes(n), 64) } : {}),
    normalize: typeof r.normalize === 'boolean' ? r.normalize : d.normalize,
    targetLufs: clampTarget(num(r.targetLufs, () => true, d.targetLufs)) ?? d.targetLufs,
    peakCeiling: num(r.peakCeiling, (n) => n <= 0 && n >= -6, d.peakCeiling),
    stems: !!r.stems,
    ...(r.stemFormat === 'wav' || r.stemFormat === 'flac' ? { stemFormat: r.stemFormat } : {}),
    ...(r.stemMode === 'tracks' || r.stemMode === 'dme' ? { stemMode: r.stemMode } : {}),
    ...(r.stemMe ? { stemMe: true } : {}),
    chapterFiles: typeof r.chapterFiles === 'boolean' ? r.chapterFiles : d.chapterFiles,
    ...(r.mono ? { mono: true } : {}),
  };
}
