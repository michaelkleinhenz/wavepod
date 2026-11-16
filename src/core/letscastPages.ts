// LetsCast.fm pages: reading the podcast list, episode list and an episode's edit page, and
// episode links. No Node APIs, so the window can use it too (see letscast.ts for the requests).
export const LETSCAST_BASE = 'https://letscast.fm';

export interface LetsCastPodcast {
  /** As in the URL, e.g. "tabulaludo-5d181655". */
  slug: string;
  title: string;
}

export interface LetsCastEpisode {
  slug: string;
  title: string;
  /** The line under the title on the episode list: date and number ("31.12.26 12:00 Uhr (Episode: 888)"). */
  info: string;
}

export interface LetsCastEpisodePage {
  csrf: string;
  title: string;
  /** The audio file the episode plays now, or '' when it has none. */
  audio: string;
  /** Id of the stored audio file (hidden episode[audio_blob_id]); changes with every upload. */
  audioBlobId: string;
}

/** Thrown when LetsCast answers with its sign-in page. */
export class LetsCastSignedOut extends Error {
  constructor() {
    super('Sign in to LetsCast.fm first.');
  }
}

const SLUG = '[A-Za-z0-9][A-Za-z0-9_-]*';

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function text(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** A LetsCast episode link (edit page or episode page) → podcast and episode slug. */
export function parseEpisodeLink(link: string): { podcast: string; episode: string } | null {
  const m = new RegExp(`^\\s*(?:https?://(?:www\\.)?letscast\\.fm)?/podcasts/(${SLUG})/episodes/(${SLUG})(?:/edit)?/?(?:[?#].*)?\\s*$`).exec(link);
  if (!m || m[2] === 'new') return null;
  return { podcast: m[1], episode: m[2] };
}

export function isSignInPage(url: string, html: string): boolean {
  return /\/users\/sign_in\b/.test(url) || /<form[^>]+action=["'][^"']*\/users\/sign_in["']/.test(html);
}

/** An attribute of one tag; letscast.fm mixes single and double quotes. */
function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? decodeEntities(m[1] ?? m[2]) : null;
}

/** Every <a> with its href (host dropped) and inner HTML. */
function links(html: string): Array<{ href: string; tag: string; inner: string; end: number }> {
  const out: Array<{ href: string; tag: string; inner: string; end: number }> = [];
  for (const m of html.matchAll(/(<a\b[^>]*>)([\s\S]*?)<\/a>/gi)) {
    const href = attr(m[1], 'href');
    if (href !== null) out.push({ href: href.replace(/^https?:\/\/(?:www\.)?letscast\.fm/, '').split(/[?#]/)[0], tag: m[1], inner: m[2], end: m.index! + m[0].length });
  }
  return out;
}

/** The podcasts on the account's /podcasts page. */
export function parsePodcasts(html: string): LetsCastPodcast[] {
  const out = new Map<string, string>();
  const re = new RegExp(`^/podcasts/(${SLUG})/episodes/?$`);
  for (const l of links(html)) {
    const m = re.exec(l.href);
    if (!m) continue;
    // the link text, else the cover's alt text ("Tabulaludo Cover")
    const img = /<img\b[^>]*>/i.exec(l.inner);
    const alt = img ? (attr(img[0], 'alt') ?? '').replace(/\s*Cover$/i, '').trim() : '';
    const title = text(l.inner) || alt;
    if (!out.get(m[1])) out.set(m[1], title);
  }
  return [...out].map(([slug, title]) => ({ slug, title: title || slug }));
}

/** The episodes on one page of a podcast's episode list, newest first as LetsCast shows them. */
export function parseEpisodes(html: string, podcast: string): LetsCastEpisode[] {
  const out = new Map<string, LetsCastEpisode>();
  const prefix = `/podcasts/${podcast}/episodes/`;
  for (const l of links(html)) {
    if (!l.href.startsWith(prefix) || !l.href.endsWith('/edit')) continue;
    const slug = l.href.slice(prefix.length, -'/edit'.length);
    if (!new RegExp(`^${SLUG}$`).test(slug)) continue;
    const t = text(l.inner);
    const e = out.get(slug);
    if (!e) {
      // the date line comes right after the title link
      const info = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(html.slice(l.end, l.end + 1500));
      out.set(slug, { slug, title: t, info: info ? text(info[1]) : '' });
    } else if (!e.title && t) {
      e.title = t;
    }
  }
  return [...out.values()].map((e) => ({ ...e, title: e.title || e.slug }));
}

/** CSRF token, title and current audio of an episode's edit page. */
export function parseEpisodePage(html: string): LetsCastEpisodePage {
  const meta = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]).find((t) => attr(t, 'name') === 'csrf-token');
  const title = [...html.matchAll(/<input\b[^>]*>/gi)].map((m) => m[0]).find((t) => attr(t, 'id') === 'episode_title');
  const audio = /<audio\b[^>]*>[\s\S]*?<\/audio>|<audio\b[^>]*>/i.exec(html);
  const src = audio ? [...audio[0].matchAll(/<(?:audio|source)\b[^>]*>/gi)].map((m) => attr(m[0], 'src')).find((v) => v) : null;
  const blob = [...html.matchAll(/<input\b[^>]*>/gi)].map((m) => m[0]).find((t) => attr(t, 'name') === 'episode[audio_blob_id]');
  return {
    csrf: meta ? (attr(meta, 'content') ?? '') : '',
    title: title ? (attr(title, 'value') ?? '') : '',
    audio: src ? src.split('?')[0] : '',
    audioBlobId: blob ? (attr(blob, 'value') ?? '') : '',
  };
}

export function editUrl(podcast: string, episode: string, base = LETSCAST_BASE): string {
  return `${base}/podcasts/${podcast}/episodes/${episode}/edit`;
}

/** Ids of the chapters an episode has now (chapters edit page), to replace them. */
export function parseChapterIds(html: string): string[] {
  return [...html.matchAll(/<input\b[^>]*>/gi)]
    .map((m) => m[0])
    .filter((t) => /^episode\[chapters_attributes\]\[\d+\]\[id\]$/.test(attr(t, 'name') ?? ''))
    .map((t) => attr(t, 'value') ?? '')
    .filter(Boolean);
}

/** A chapter start as LetsCast takes it: "01:02:03", or "01:02:03.250" with milliseconds. */
export function chapterStart(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const base = `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)}`;
  return ms % 1000 ? `${base}.${p(ms % 1000, 3)}` : base;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** One line of text with its links made clickable. */
function inline(line: string): string {
  let out = '';
  let last = 0;
  for (const m of line.matchAll(/\bhttps?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]]/g)) {
    out += escapeHtml(line.slice(last, m.index)) + `<a href="${escapeHtml(m[0])}">${escapeHtml(m[0])}</a>`;
    last = m.index! + m[0].length;
  }
  return out + escapeHtml(line.slice(last));
}

/**
 * Plain text as the HTML LetsCast's editor (Trix) writes: a <div> per paragraph (blank line between
 * them), line breaks as <br>, lines starting with "- " or "* " as a bullet list, links clickable.
 */
export function textToHtml(text: string): string {
  const blocks = text.replace(/\r\n?/g, '\n').trim().split(/\n\s*\n/);
  const out: string[] = [];
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trimEnd());
    let para: string[] = [];
    let list: string[] = [];
    const flush = () => {
      if (para.length) out.push(`<div>${para.map(inline).join('<br>')}</div>`);
      if (list.length) out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join('')}</ul>`);
      para = [];
      list = [];
    };
    for (const l of lines) {
      const bullet = /^\s*[-*•]\s+(.*)$/.exec(l);
      if (bullet) {
        if (para.length) flush();
        list.push(bullet[1]);
      } else {
        if (list.length) flush();
        para.push(l);
      }
    }
    flush();
  }
  return out.join('');
}
