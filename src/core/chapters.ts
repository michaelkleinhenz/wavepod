// Chapter list import/export: Podlove Simple Chapters, mp4chaps, Podcasting 2.0 JSON, Audacity labels.
import { formatTimestamp, parseTimestamp } from '../shared/time';

export interface Chapter {
  /** Seconds from the start of the episode. */
  start: number;
  title: string;
  url?: string;
  /** Image file name or URL, as it should appear in chapter files. */
  image?: string;
}

export type ChapterFormat = 'psc' | 'mp4chaps' | 'json' | 'audacity';

export const CHAPTER_FORMATS: Array<{ id: ChapterFormat; label: string; ext: string }> = [
  { id: 'psc', label: 'Podlove Simple Chapters (XML)', ext: 'psc.xml' },
  { id: 'mp4chaps', label: 'mp4chaps (text)', ext: 'chapters.txt' },
  { id: 'json', label: 'Podcasting 2.0 JSON', ext: 'chapters.json' },
  { id: 'audacity', label: 'Audacity labels', ext: 'labels.txt' },
];

function sorted(chapters: Chapter[]): Chapter[] {
  return [...chapters].sort((a, b) => a.start - b.start);
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function exportChapters(chapters: Chapter[], format: ChapterFormat, totalSeconds?: number): string {
  const list = sorted(chapters);
  switch (format) {
    case 'psc': {
      const lines = list.map((c) => {
        const href = c.url ? ` href="${xmlEscape(c.url)}"` : '';
        const image = c.image ? ` image="${xmlEscape(c.image)}"` : '';
        return `  <psc:chapter start="${formatTimestamp(c.start)}" title="${xmlEscape(c.title)}"${href}${image} />`;
      });
      return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<psc:chapters version="1.2" xmlns:psc="http://podlove.org/simple-chapters">',
        ...lines,
        '</psc:chapters>',
        '',
      ].join('\n');
    }
    case 'mp4chaps':
      return list.map((c) => `${formatTimestamp(c.start)} ${c.title}${c.url ? ` <${c.url}>` : ''}`).join('\n') + '\n';
    case 'json':
      return (
        JSON.stringify(
          {
            version: '1.2.0',
            chapters: list.map((c) => ({
              startTime: round3(c.start),
              title: c.title,
              ...(c.url ? { url: c.url } : {}),
              ...(c.image ? { img: c.image } : {}),
            })),
          },
          null,
          2,
        ) + '\n'
      );
    case 'audacity':
      return (
        list
          .map((c, i) => {
            const end = list[i + 1]?.start ?? totalSeconds ?? c.start;
            return `${c.start.toFixed(6)}\t${end.toFixed(6)}\t${c.title}`;
          })
          .join('\n') + '\n'
      );
  }
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function detectChapterFormat(text: string): ChapterFormat | null {
  const t = text.trim();
  if (!t) return null;
  if (t.startsWith('{')) return 'json';
  if (t.includes('<psc:chapter') || t.includes('<chapter')) return 'psc';
  const first = t.split(/\r?\n/)[0];
  if (/^\d+(\.\d+)?\t\d+(\.\d+)?\t/.test(first)) return 'audacity';
  if (/^\d+(:\d+){1,2}(\.\d+)?\s/.test(first)) return 'mp4chaps';
  return null;
}

export function importChapters(text: string, format = detectChapterFormat(text)): Chapter[] {
  switch (format) {
    case 'json': {
      const data = JSON.parse(text) as { chapters?: Array<{ startTime: number; title?: string; url?: string; img?: string; toc?: boolean }> };
      return sorted(
        (data.chapters ?? [])
          .filter((c) => typeof c.startTime === 'number' && c.toc !== false)
          .map((c) => ({ start: c.startTime, title: c.title ?? '', ...(c.url ? { url: c.url } : {}), ...(c.img ? { image: c.img } : {}) })),
      );
    }
    case 'psc': {
      const out: Chapter[] = [];
      const re = /<(?:psc:)?chapter\b([^>]*)\/?>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const attrs = parseAttrs(m[1]);
        const start = parseTimestamp(attrs.start ?? '');
        if (Number.isNaN(start)) continue;
        out.push({ start, title: attrs.title ?? '', ...(attrs.href ? { url: attrs.href } : {}), ...(attrs.image ? { image: attrs.image } : {}) });
      }
      return sorted(out);
    }
    case 'mp4chaps': {
      const out: Chapter[] = [];
      for (const line of text.split(/\r?\n/)) {
        const m = /^\s*(\d+(?::\d+){1,2}(?:\.\d+)?)\s+(.*?)\s*$/.exec(line);
        if (!m) continue;
        let title = m[2];
        let url: string | undefined;
        const u = /^(.*?)\s*<([a-z][a-z0-9+.-]*:\/\/[^>]+)>$/i.exec(title);
        if (u) {
          title = u[1];
          url = u[2];
        }
        out.push({ start: parseTimestamp(m[1]), title, ...(url ? { url } : {}) });
      }
      return sorted(out);
    }
    case 'audacity': {
      const out: Chapter[] = [];
      for (const line of text.split(/\r?\n/)) {
        const parts = line.split('\t');
        if (parts.length < 3 || parts[0].startsWith('\\')) continue;
        const start = Number(parts[0]);
        if (Number.isNaN(start)) continue;
        out.push({ start, title: parts.slice(2).join('\t') });
      }
      return sorted(out);
    }
    default:
      throw new Error('Unrecognised chapter format');
  }
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:-]+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[m[1]] = xmlUnescape(m[2]);
  return out;
}

/** Title, optional link and optional image file name for one chapter, without a start time. */
export interface ChapterContent {
  title: string;
  url?: string;
  /** Image file name as written in the list, relative to the list's folder. */
  image?: string;
}

/** A third field counts as an image when it names a JPEG or PNG file (not a link). */
const IMAGE_FIELD = /^[^;]*\.(jpe?g|png)$/i;

/**
 * Parses chapter content without times, one chapter per line as "title;link;image" (link and
 * image are optional, so "title" and "title;link" work too, and "title;;image" skips the link).
 * The image is the last field when the line has at least two ";" and that field is a JPEG/PNG
 * file name (or empty). The title/link split is at the first ";" followed by something that
 * looks like a link (no spaces, with "://" or a dot) or by nothing, so titles with a ";" and
 * links with a ";" both work. Blank lines are skipped.
 */
export function parseChapterContent(text: string): ChapterContent[] {
  const out: ChapterContent[] = [];
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    let image: string | undefined;
    const last = line.lastIndexOf(';');
    if (last > 0 && line.lastIndexOf(';', last - 1) >= 0) {
      const field = line.slice(last + 1).trim();
      if (field === '' || (IMAGE_FIELD.test(field) && !field.includes('://'))) {
        if (field) image = field;
        line = line.slice(0, last).trim();
      }
    }
    let entry: ChapterContent = { title: line };
    for (let i = line.indexOf(';'); i >= 0; i = line.indexOf(';', i + 1)) {
      const rest = line.slice(i + 1).trim();
      if (rest === '' || (!/\s/.test(rest) && /:\/\/|\./.test(rest))) {
        entry = { title: line.slice(0, i).trim(), ...(rest ? { url: rest } : {}) };
        break;
      }
    }
    if (image) entry.image = image;
    out.push(entry);
  }
  return out;
}
