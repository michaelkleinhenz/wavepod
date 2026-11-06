// Full-text search over the user guide: every page is split into sections at its headings, and a
// query finds the sections that contain all of its words (matched at the start of words, so
// "norm" finds "normalise"). Section titles count more than the text below them.
import { plainText, renderMarkdown, slug } from './markdown';
import type { Topic } from './topics';

export interface Section {
  topic: string;
  topicTitle: string;
  /** Heading id within the page; '' for the part above the first heading. */
  anchor: string;
  heading: string;
  text: string;
}

export interface SearchHit {
  section: Section;
  score: number;
  /** A short piece of the text around the first match. */
  snippet: string;
}

/** Folds case, accents and British/American spellings, so "Normalize" finds "normalise". */
export function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/iz(?=e|ing|ation)/g, 'is')
    .replace(/colour/g, 'color')
    .replace(/analyz/g, 'analys');
}

function words(s: string): string[] {
  return fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Splits a page into sections at its headings (`##` and deeper; the title starts the first one). */
export function sections(topic: Topic): Section[] {
  const { title, headings } = renderMarkdown(topic.markdown);
  const out: Section[] = [];
  let cur: Section = { topic: topic.id, topicTitle: title, anchor: '', heading: title, text: '' };
  const body: string[] = [];
  const flush = () => {
    cur.text = plainText(body.join(' ')).replace(/[|#>*]+/g, ' ').replace(/\s+/g, ' ').trim();
    out.push(cur);
    body.length = 0;
  };
  let next = 0;
  let fenced = false;
  let sawTitle = false;
  for (const line of topic.markdown.split(/\r?\n/)) {
    if (line.startsWith('```')) fenced = !fenced;
    const hm = !fenced && /^(#{1,6})\s+(.*?)\s*#*$/.exec(line);
    if (hm) {
      if (hm[1].length === 1 && !sawTitle) {
        sawTitle = true;
        continue;
      }
      flush();
      const h = headings[next++];
      cur = { topic: topic.id, topicTitle: title, anchor: h?.id ?? slug(hm[2]), heading: h?.text ?? plainText(hm[2]), text: '' };
      continue;
    }
    if (/^\s*\|?\s*:?-{3,}/.test(line)) continue; // table rule
    body.push(line);
  }
  flush();
  return out.filter((s) => s.text || s.anchor);
}

export function buildIndex(topics: Topic[]): Section[] {
  return topics.flatMap(sections);
}

function snippet(text: string, terms: string[], width = 170): string {
  const folded = fold(text);
  let at = -1;
  for (const t of terms) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u');
    const m = re.exec(folded);
    if (m && (at < 0 || m.index < at)) at = m.index + m[1].length;
  }
  if (at < 0) return text.length > width ? `${text.slice(0, width).replace(/\s+\S*$/, '')} …` : text;
  let start = Math.max(0, at - Math.round(width / 3));
  if (start > 0) start = text.indexOf(' ', start) + 1 || start;
  let end = Math.min(text.length, start + width);
  if (end < text.length) end = text.lastIndexOf(' ', end) > start ? text.lastIndexOf(' ', end) : end;
  return `${start > 0 ? '… ' : ''}${text.slice(start, end)}${end < text.length ? ' …' : ''}`;
}

export function search(index: Section[], query: string, limit = 30): SearchHit[] {
  const terms = [...new Set(words(query))];
  if (!terms.length) return [];
  const hits: SearchHit[] = [];
  const phrase = fold(query.trim());
  for (const section of index) {
    const head = words(section.heading);
    const title = words(section.topicTitle);
    const body = words(section.text);
    let score = 0;
    let all = true;
    for (const t of terms) {
      const inHead = head.filter((w) => w.startsWith(t)).length;
      const inTitle = title.filter((w) => w.startsWith(t)).length;
      const inBody = body.filter((w) => w.startsWith(t)).length;
      if (!inHead && !inTitle && !inBody) {
        all = false;
        break;
      }
      score += inHead * 8 + inTitle * 3 + Math.min(inBody, 6) + (head.includes(t) ? 4 : 0);
    }
    if (!all) continue;
    if (terms.length > 1 && fold(`${section.heading} ${section.text}`).includes(phrase)) score += 10;
    hits.push({ section, score, snippet: snippet(section.text, terms) });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** The query's words, folded, for highlighting matches on the page. */
export function queryTerms(query: string): string[] {
  return [...new Set(words(query))];
}
