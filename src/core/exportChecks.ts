// Checks before export, besides the chapter checks: episode details, the cover, and (once the mix
// was analysed) the loudness and stretches of dead air.
import type { EpisodeMetadata, ExportSettings, LoudnessStats } from '../shared/types';

export interface ExportCheck {
  id: string;
  message: string;
  /** Times (seconds from the start of the export) the message is about, to jump to. */
  at?: number[];
}

export interface ImageSize {
  width: number;
  height: number;
}

/** Podcast directories ask for a square cover of at least this size; Apple takes up to COVER_MAX. */
export const COVER_MIN = 1400;
export const COVER_MAX = 3000;
/** Normalising by more than this much also lifts the room noise noticeably. */
export const BIG_BOOST_DB = 12;

const fmtLufs = (v: number) => `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)} LUFS`;
const fmtTarget = (v: number) => `${v < 0 ? '−' : ''}${Math.abs(v)} LUFS`;

/** Formats that carry tags (title, cover, …): all but WAV. */
export function tagsWritten(s: Pick<ExportSettings, 'formats'>): boolean {
  return s.formats.some((f) => f !== 'wav');
}

/**
 * What is worth fixing before export. `cover` is the size of the episode cover (null: it could not
 * be read, undefined: not known yet); `mix` is the loudness analysis of the mix, if one was run.
 */
export function exportChecks(meta: EpisodeMetadata, settings: ExportSettings, cover?: ImageSize | null, mix?: LoudnessStats | null): ExportCheck[] {
  const out: ExportCheck[] = [];
  if (tagsWritten(settings)) {
    const missing = [
      !meta.title.trim() && 'title',
      !meta.podcast.trim() && 'podcast name',
      !meta.episode.trim() && 'episode number',
      !meta.description.trim() && 'description',
    ].filter((x): x is string => !!x);
    if (missing.length) {
      out.push({ id: 'details', message: `No ${joinList(missing)} in the episode details. Podcast apps show what the file's tags say; fill them in under Chapters › Episode.` });
    }
    if (!meta.artwork) out.push({ id: 'no-cover', message: 'No episode cover set. Add one under Chapters › Episode to embed it in the files.' });
    else if (cover === null) out.push({ id: 'cover-unreadable', message: `The episode cover (${meta.artwork}) can't be read. Only JPEG and PNG files are embedded.` });
    else if (cover) {
      const { width: w, height: h } = cover;
      if (w !== h) out.push({ id: 'cover-square', message: `The episode cover is ${w}×${h} px. Podcast directories expect a square image and may crop or reject it.` });
      if (Math.min(w, h) < COVER_MIN) out.push({ id: 'cover-small', message: `The episode cover is only ${w}×${h} px. Apple Podcasts and Spotify ask for at least ${COVER_MIN}×${COVER_MIN} px.` });
      else if (Math.max(w, h) > COVER_MAX) out.push({ id: 'cover-large', message: `The episode cover is ${w}×${h} px. Apple Podcasts accepts at most ${COVER_MAX}×${COVER_MAX} px, and a big cover makes every file larger.` });
    }
  }
  if (mix && Number.isFinite(mix.integrated)) {
    const t = settings.targetLufs;
    const off = mix.integrated - t;
    if (!settings.normalize) {
      if (Math.abs(off) > 1) {
        out.push({ id: 'off-target', message: `The mix is at ${fmtLufs(mix.integrated)}, ${Math.abs(off).toFixed(1)} LU ${off < 0 ? 'under' : 'over'} the ${fmtTarget(t)} target, and Normalise loudness is off.` });
      }
      if (Number.isFinite(mix.truePeak) && mix.truePeak > settings.peakCeiling) {
        out.push({ id: 'peaks', message: `Peaks reach ${mix.truePeak.toFixed(1)} dBTP, over the ${settings.peakCeiling} dBTP ceiling, and Normalise loudness is off, so nothing holds them.` });
      }
    } else if (-off > BIG_BOOST_DB) {
      out.push({ id: 'quiet', message: `The mix is very quiet (${fmtLufs(mix.integrated)}): reaching ${fmtTarget(t)} raises it by ${(-off).toFixed(0)} dB, and the room noise with it. Check the recording levels, or even out the voices with the Dynamics filter.` });
    }
  }
  const silences = mix?.silences ?? [];
  if (silences.length) {
    const len = (s: [number, number]) => `${Math.round(s[1] - s[0])} s`;
    out.push({
      id: 'silence',
      message: silences.length === 1
        ? `There is ${len(silences[0])} of silence (dead air) in the mix:`
        : `There are ${silences.length} stretches of silence (dead air) of 5 s or more in the mix:`,
      at: silences.map((s) => s[0]),
    });
  }
  return out;
}

function joinList(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`;
}

/** Width and height of a PNG or JPEG, from its bytes; null for other formats or damaged files. */
export function imageSize(bytes: Uint8Array): ImageSize | null {
  // PNG: the IHDR chunk comes first
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const u32 = (o: number) => ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
    const width = u32(16);
    const height = u32(20);
    return width && height ? { width, height } : null;
  }
  // JPEG: walk the segments to the first start-of-frame
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      // SOF0…SOF15, except DHT (C4), JPG (C8) and DAC (CC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = (bytes[i + 5] << 8) | bytes[i + 6];
        const width = (bytes[i + 7] << 8) | bytes[i + 8];
        return width && height ? { width, height } : null;
      }
      if (len < 2) return null;
      i += 2 + len;
    }
  }
  return null;
}
