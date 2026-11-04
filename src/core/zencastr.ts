// Zencastr session ZIPs (Library → Recordings → Download): one folder per participant with
// their track as WAV and/or MP3, plus the soundboard as its own file, e.g.
//   michael/michael_recording-1_2026-11-04_15-10-53.wav
//   michael/michael_recording-1_2026-11-04_15-10-53.mp3
//   recording-1_soundboard.mp3
//   recording-1_transcription.txt
// This works out which files become which track; the main process extracts them and the
// renderer decodes them into a new episode.

export interface ZencastrPart {
  /** Path of the entry inside the ZIP. */
  entry: string;
  /** Seconds after the participant's first part (rejoins), 0 for the first. */
  start: number;
}

export interface ZencastrTrack {
  name: string;
  /** Goes onto WavePod's Soundboard track. */
  soundboard?: boolean;
  parts: ZencastrPart[];
}

export interface ZencastrPlan {
  tracks: ZencastrTrack[];
  /** Entries left out (video, transcript, mixed post-productions, …), for the summary. */
  skipped: string[];
}

const AUDIO_PREFERENCE = ['wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'mp3'];

function ext(name: string): string {
  const m = /\.([^./]+)$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}

function stem(name: string): string {
  return name.replace(/\.[^./]+$/, '');
}

function base(name: string): string {
  return name.split('/').pop() ?? name;
}

/** Wall-clock time in the file name ("_2026-11-04_15-10-53"), in seconds, or null. */
export function fileTime(name: string): number | null {
  const m = /(\d{4})-(\d{2})-(\d{2})[_ T](\d{2})[-:](\d{2})[-:](\d{2})/.exec(base(name));
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s) / 1000;
}

/** The participant a file belongs to: its folder, or the name before "_recording-N" otherwise. */
function participant(name: string): string {
  const parts = name.split('/');
  if (parts.length > 1) return parts[parts.length - 2];
  const b = stem(base(name));
  const m = /^(.*?)_recording-\d+/i.exec(b);
  return m && m[1] ? m[1] : b;
}

/** "kleinhenz_demo_recording-1.zip" → "kleinhenz demo". */
export function sessionTitle(zipName: string): string {
  const b = stem(base(zipName.replace(/\\/g, '/')));
  return b.replace(/[_ -]*recording-\d+$/i, '').replace(/_+/g, ' ').trim() || b;
}

export function planZencastrImport(entries: string[]): ZencastrPlan {
  const skipped: string[] = [];
  // one file per recording: the WAV when there are both WAV and MP3
  const best = new Map<string, string>();
  for (const name of entries) {
    if (name.endsWith('/') || base(name).startsWith('.') || name.startsWith('__MACOSX/')) continue;
    const e = ext(name);
    if (!AUDIO_PREFERENCE.includes(e) || /(^|\/)post-?productions?\//i.test(name) || /post-?production/i.test(base(name))) {
      skipped.push(name);
      continue;
    }
    const key = stem(name);
    const had = best.get(key);
    if (!had || AUDIO_PREFERENCE.indexOf(e) < AUDIO_PREFERENCE.indexOf(ext(had))) {
      if (had) skipped.push(had);
      best.set(key, name);
    } else skipped.push(name);
  }

  const soundboard: string[] = [];
  const people = new Map<string, string[]>();
  for (const name of best.values()) {
    if (/soundboard/i.test(base(name))) {
      soundboard.push(name);
      continue;
    }
    const who = participant(name);
    people.set(who, [...(people.get(who) ?? []), name]);
  }

  const tracks: ZencastrTrack[] = [];
  const byTime = (a: string, b: string) => (fileTime(a) ?? 0) - (fileTime(b) ?? 0) || a.localeCompare(b);
  for (const [who, files] of [...people].sort((a, b) => a[0].localeCompare(b[0]))) {
    files.sort(byTime);
    const t0 = fileTime(files[0]);
    tracks.push({
      name: who,
      parts: files.map((entry) => {
        const t = fileTime(entry);
        return { entry, start: t0 !== null && t !== null ? Math.max(0, t - t0) : 0 };
      }),
    });
  }
  if (soundboard.length) tracks.push({ name: 'Soundboard', soundboard: true, parts: soundboard.sort(byTime).map((entry) => ({ entry, start: 0 })) });
  return { tracks, skipped: skipped.sort() };
}
