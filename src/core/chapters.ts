// Chapter list import/export: Podlove Simple Chapters, mp4chaps, Podcasting 2.0 JSON, Audacity labels.
import { formatTimestamp, parseTimestamp } from '../shared/time';

export interface Chapter {
  /** Seconds from the start of the episode. */
  start: number;
  title: string;
  url?: string;
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
        return `  <psc:chapter start="${formatTimestamp(c.start)}" title="${xmlEscape(c.title)}"${href} />`;
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
      const data = JSON.parse(text) as { chapters?: Array<{ startTime: number; title?: string; url?: string; toc?: boolean }> };
      return sorted(
        (data.chapters ?? [])
          .filter((c) => typeof c.startTime === 'number' && c.toc !== false)
          .map((c) => ({ start: c.startTime, title: c.title ?? '', ...(c.url ? { url: c.url } : {}) })),
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
        out.push({ start, title: attrs.title ?? '', ...(attrs.href ? { url: attrs.href } : {}) });
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
