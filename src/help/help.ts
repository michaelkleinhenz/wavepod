// The help window: the user guide with a contents list, full-text search and links between pages.
// It runs on its own (no preload, no access to the app); its address says what to show:
// `#topic` or `#topic/anchor`, e.g. `#export/stems`.
import { escapeHtml, renderMarkdown, type Rendered } from './markdown';
import { buildIndex, queryTerms, search, type SearchHit } from './search';
import { DEFAULT_TOPIC, TOPICS, resolveLink, type Topic } from './topics';

const isMac = navigator.platform.toLowerCase().includes('mac');
/** Keys as they are labelled on this computer. */
const keyText = (s: string) => (isMac ? s.replace(/\bCtrl\b/g, '⌘').replace(/\bAlt\b/g, '⌥') : s);

const pages = new Map<string, Rendered>();
function page(topic: Topic): Rendered {
  let r = pages.get(topic.id);
  if (!r) {
    r = renderMarkdown(topic.markdown, {
      link: (href) => {
        const to = resolveLink(href, topic.id);
        return to ? `#${to}` : href;
      },
      code: keyText,
    });
    pages.set(topic.id, r);
  }
  return r;
}

const index = buildIndex(TOPICS);
const topicById = (id: string) => TOPICS.find((t) => t.id === id);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

// ---------------------------------------------------------------- layout
const app = document.getElementById('help')!;
const side = el('aside', 'side');
const searchBox = el('input', 'search') as HTMLInputElement;
searchBox.type = 'search';
searchBox.placeholder = 'Search the guide';
searchBox.setAttribute('aria-label', 'Search the guide');
searchBox.spellcheck = false;
const toc = el('nav', 'toc');
toc.setAttribute('aria-label', 'Contents');
side.append(el('div', 'brand', '<span class="logo">◉</span> WavePod Help'), searchBox, toc);

const main = el('main', 'main');
const article = el('article', 'doc');
const results = el('section', 'results');
const pager = el('nav', 'pager');
main.append(article, results, pager);
app.append(side, main);

// ---------------------------------------------------------------- state
let current = DEFAULT_TOPIC;
let highlight: string[] = [];
let hits: SearchHit[] = [];
let active = 0;
/** The page shows marked search words, so it is drawn fresh on the next visit. */
let marked = false;

function parseHash(): { topic: string; anchor: string } {
  const [t, a] = decodeURIComponent(location.hash.replace(/^#/, '')).split('/');
  return { topic: topicById(t) ? t : DEFAULT_TOPIC, anchor: a ?? '' };
}

function renderToc(): void {
  toc.innerHTML = '';
  let group = '';
  for (const t of TOPICS) {
    if (t.group !== group) {
      group = t.group;
      toc.append(el('div', 'toc-group', escapeHtml(group)));
    }
    const p = page(t);
    const a = el('a', `toc-topic${t.id === current ? ' current' : ''}`, escapeHtml(p.title));
    a.href = `#${t.id}`;
    toc.append(a);
    if (t.id === current) {
      const sub = el('div', 'toc-sections');
      for (const hd of p.headings.filter((x) => x.level === 2)) {
        const s = el('a', 'toc-section', escapeHtml(hd.text));
        s.href = `#${t.id}/${hd.id}`;
        s.dataset.anchor = hd.id;
        sub.append(s);
      }
      toc.append(sub);
    }
  }
  toc.querySelector('.toc-topic.current')?.scrollIntoView({ block: 'nearest' });
}

/** Marks the query's words in the page, so a search hit is easy to spot. */
function markTerms(root: HTMLElement, terms: string[]): void {
  if (!terms.length) return;
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'giu');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const text = node.data;
    re.lastIndex = 0;
    if (!re.test(text)) continue;
    re.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const start = m.index + m[1].length;
      frag.append(text.slice(last, start), Object.assign(document.createElement('mark'), { textContent: m[2] }));
      last = start + m[2].length;
    }
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
}

function showPage(): void {
  const { topic, anchor } = parseHash();
  const changed = topic !== current || !article.childElementCount;
  current = topic;
  const t = topicById(topic)!;
  const p = page(t);
  if (changed || highlight.length || marked) {
    marked = highlight.length > 0;
    article.innerHTML = p.html;
    markTerms(article, highlight);
    renderToc();
    const i = TOPICS.indexOf(t);
    const prev = TOPICS[i - 1];
    const next = TOPICS[i + 1];
    pager.innerHTML =
      (prev ? `<a class="prev" href="#${prev.id}"><small>Previous</small>${escapeHtml(page(prev).title)}</a>` : '<span></span>') +
      (next ? `<a class="next" href="#${next.id}"><small>Next</small>${escapeHtml(page(next).title)}</a>` : '<span></span>');
    document.title = `${p.title} – WavePod Help`;
  }
  for (const s of toc.querySelectorAll<HTMLElement>('.toc-section')) s.classList.toggle('current', s.dataset.anchor === anchor);
  const target = anchor ? document.getElementById(anchor) : null;
  if (target) {
    target.scrollIntoView({ block: 'start' });
    target.classList.remove('flash');
    void target.offsetWidth;
    target.classList.add('flash');
  } else if (changed) main.scrollTop = 0;
  // a hit on a whole page: show its first match (a hit on a section starts at the section's heading)
  if (highlight.length && !target) article.querySelector('mark')?.scrollIntoView({ block: 'center' });
  highlight = [];
}

// ---------------------------------------------------------------- search
function renderResults(): void {
  const q = searchBox.value.trim();
  const searching = q.length > 0;
  app.classList.toggle('searching', searching);
  if (!searching) {
    results.innerHTML = '';
    return;
  }
  hits = search(index, q);
  active = Math.min(active, Math.max(0, hits.length - 1));
  const terms = queryTerms(q);
  const mark = (s: string) => {
    let html = escapeHtml(s);
    if (!terms.length) return html;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${terms.map((t) => escapeHtml(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'giu');
    html = html.replace(re, '$1<mark>$2</mark>');
    return html;
  };
  results.innerHTML = '';
  results.append(el('h1', undefined, hits.length ? `Results for “${escapeHtml(q)}”` : `Nothing found for “${escapeHtml(q)}”`));
  if (!hits.length) {
    results.append(el('p', 'muted', 'Try fewer or other words, for example the name of a button or menu command. Words are matched at their start, so “norm” finds “normalise”.'));
    return;
  }
  hits.forEach((hit, i) => {
    const s = hit.section;
    const a = el('a', `hit${i === active ? ' active' : ''}`);
    a.href = `#${s.topic}${s.anchor ? `/${s.anchor}` : ''}`;
    a.innerHTML = `<span class="hit-where">${escapeHtml(s.topicTitle)}${s.anchor ? ` › ${mark(s.heading)}` : ''}</span><span class="hit-text">${mark(hit.snippet)}</span>`;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      openHit(i);
    });
    results.append(a);
  });
}

function openHit(i: number): void {
  const hit = hits[i];
  if (!hit) return;
  highlight = queryTerms(searchBox.value);
  searchBox.value = '';
  renderResults();
  const target = `#${hit.section.topic}${hit.section.anchor ? `/${hit.section.anchor}` : ''}`;
  if (location.hash === target) showPage();
  else location.hash = target;
}

searchBox.addEventListener('input', () => {
  active = 0;
  renderResults();
});
searchBox.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!hits.length) return;
    active = (active + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length;
    renderResults();
    results.querySelector('.hit.active')?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    openHit(active);
  } else if (e.key === 'Escape' && searchBox.value) {
    e.preventDefault();
    e.stopPropagation();
    searchBox.value = '';
    renderResults();
  }
});

// ---------------------------------------------------------------- navigation
window.addEventListener('hashchange', () => {
  if (searchBox.value) {
    searchBox.value = '';
    renderResults();
  }
  showPage();
});

// links that leave the guide open in the browser (the main process hands them to the system)
document.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest('a');
  if (!a) return;
  const href = a.getAttribute('href') ?? '';
  if (/^(https?:|mailto:)/i.test(href)) {
    e.preventDefault();
    window.open(href, '_blank');
  }
});

window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if ((mod && e.key.toLowerCase() === 'f') || (e.key === '/' && document.activeElement !== searchBox)) {
    e.preventDefault();
    searchBox.focus();
    searchBox.select();
  } else if (mod && e.key.toLowerCase() === 'w') {
    e.preventDefault();
    window.close();
  } else if (e.altKey && e.key === 'ArrowLeft') {
    e.preventDefault();
    history.back();
  } else if (e.altKey && e.key === 'ArrowRight') {
    e.preventDefault();
    history.forward();
  } else if (mod && e.key.toLowerCase() === 'p') {
    e.preventDefault();
    window.print();
  }
});

showPage();
