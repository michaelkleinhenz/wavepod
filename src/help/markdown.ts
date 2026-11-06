// A small Markdown renderer for the user guide in docs/guide/. It covers what the guide uses:
// headings (with ids), paragraphs, lists (nested by indentation), tables, block quotes as tip
// boxes, code blocks, inline code, bold, italic and links. Everything is escaped; raw HTML in
// the Markdown is shown as text, never run.

export interface Heading {
  level: number;
  id: string;
  text: string;
}

export interface RenderOptions {
  /** Turns a link target into the href that is written, e.g. `export.md#stems` → `#export/stems`. */
  link?: (href: string) => string;
  /** Rewrites the text of inline code, e.g. `Ctrl` → `⌘` on macOS. */
  code?: (text: string) => string;
}

export interface Rendered {
  html: string;
  /** The page title (the first `#` heading) and every heading below it, in order. */
  title: string;
  headings: Heading[];
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The id a heading gets: lower case, words joined by dashes, like GitHub does it. */
export function slug(text: string): string {
  return plainText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

/** Inline Markdown reduced to its text (for headings, ids and the search index). */
export function plainText(md: string): string {
  return md
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^\w*])\*([^*\s][^*]*)\*/g, '$1$2')
    .replace(/(^|\W)_([^_\s][^_]*)_(?=\W|$)/g, '$1$2');
}

/** Inline Markdown to HTML. */
export function inline(md: string, opts: RenderOptions = {}): string {
  // Code spans first, so nothing inside them is treated as Markdown.
  const parts = md.split(/(`[^`]*`)/);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) {
        const text = part.slice(1, -1);
        return `<code>${escapeHtml(opts.code ? opts.code(text) : text)}</code>`;
      }
      let s = escapeHtml(part);
      s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) => {
        const raw = href.replace(/&amp;/g, '&');
        const external = /^(https?:|mailto:)/i.test(raw);
        const target = external ? raw : opts.link ? opts.link(raw) : raw;
        return `<a href="${escapeHtml(target)}"${external ? ' class="external"' : ''}>${label}</a>`;
      });
      s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      s = s.replace(/(^|[^\w*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
      s = s.replace(/(^|[\s(])_([^_\s][^_]*)_(?=[\s.,;:!?)]|$)/g, '$1<em>$2</em>');
      return s;
    })
    .join('');
}

interface ListItem {
  text: string[];
  children: string[];
}

const LIST_RE = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

function renderList(lines: string[], opts: RenderOptions): string {
  const first = LIST_RE.exec(lines[0])!;
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items: ListItem[] = [];
  for (const line of lines) {
    const m = LIST_RE.exec(line);
    if (m && m[1].length === indent) items.push({ text: [m[3]], children: [] });
    else if (items.length) {
      const cur = items[items.length - 1];
      if (m || cur.children.length) cur.children.push(line);
      else cur.text.push(line.trim());
    }
  }
  const tag = ordered ? 'ol' : 'ul';
  const lis = items.map((it) => `<li>${inline(it.text.join(' '), opts)}${it.children.length ? renderList(it.children, opts) : ''}</li>`);
  return `<${tag}>${lis.join('')}</${tag}>`;
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));
}

export function renderMarkdown(md: string, opts: RenderOptions = {}): Rendered {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  const headings: Heading[] = [];
  const used = new Map<string, number>();
  let title = '';
  let i = 0;
  const isBlank = (l: string | undefined) => l === undefined || !l.trim();
  const startsBlock = (l: string) => /^(#{1,6}\s|```|>|\|)/.test(l) || LIST_RE.test(l);

  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    // fenced code
    if (line.startsWith('```')) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i++;
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    // heading
    const hm = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line);
    if (hm) {
      const level = hm[1].length;
      const text = plainText(hm[2]);
      let id = slug(hm[2]);
      const n = used.get(id) ?? 0;
      used.set(id, n + 1);
      if (n) id = `${id}-${n}`;
      if (level === 1 && !title) title = text;
      else headings.push({ level, id, text });
      out.push(`<h${level} id="${escapeHtml(id)}">${inline(hm[2], opts)}</h${level}>`);
      i++;
      continue;
    }
    // block quote: a tip or warning box
    if (line.startsWith('>')) {
      const body: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) body.push(lines[i++].replace(/^>\s?/, ''));
      const inner = renderMarkdown(body.join('\n'), opts).html;
      const kind = /^\s*\*\*(Warning|Careful|Important)/i.test(body[0]) ? 'warning' : 'tip';
      out.push(`<aside class="callout ${kind}">${inner}</aside>`);
      continue;
    }
    // table
    if (line.trim().startsWith('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      const head = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(splitRow(lines[i++]));
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c, opts)}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c, opts)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`,
      );
      continue;
    }
    // list (items may continue on indented lines; a blank line ends it unless the list goes on)
    if (LIST_RE.test(line)) {
      const body: string[] = [];
      while (i < lines.length) {
        const l = lines[i];
        if (isBlank(l)) {
          const next = lines[i + 1];
          if (next !== undefined && LIST_RE.test(next)) {
            i++;
            continue;
          }
          break;
        }
        if (body.length && !LIST_RE.test(l) && !/^\s/.test(l)) break;
        body.push(l);
        i++;
      }
      out.push(renderList(body, opts));
      continue;
    }
    // paragraph
    const body: string[] = [];
    while (i < lines.length && !isBlank(lines[i]) && !(body.length && startsBlock(lines[i]))) body.push(lines[i++].trim());
    out.push(`<p>${inline(body.join(' '), opts)}</p>`);
  }
  return { html: out.join('\n'), title, headings };
}
