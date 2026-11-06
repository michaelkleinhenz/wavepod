import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderMarkdown, slug } from '../src/help/markdown';
import { buildIndex, fold, search, sections } from '../src/help/search';
import { DEFAULT_TOPIC, TOPICS, resolveLink, shortcutsMarkdown } from '../src/help/topics';
import { DIALOG_TOPICS, SETTINGS_TABS, helpTopicFor } from '../src/help/context';
import { SHORTCUTS } from '../src/renderer/shortcuts';
import { FX_DEFINITIONS } from '../src/core/fx/definitions';
import { VOICE_EFFECTS } from '../src/core/fx/voiceEffects';

const pages = new Map(TOPICS.map((t) => [t.id, renderMarkdown(t.markdown)]));
const allText = TOPICS.map((t) => t.markdown).join('\n');
const pageText = (id: string) => TOPICS.find((t) => t.id === id)!.markdown;

/** True if `address` (`topic` or `topic/anchor`) is a page, or a heading on a page. */
function exists(address: string): boolean {
  const [topic, anchor] = address.split('/');
  const p = pages.get(topic);
  if (!p) return false;
  return !anchor || p.headings.some((h) => h.id === anchor);
}

describe('markdown', () => {
  it('renders headings with ids, paragraphs and inline formatting', () => {
    const r = renderMarkdown('# Title\n\nSome **bold**, *italic* and `Ctrl+S`.\n\n## Fades and crossfades\n\nText');
    expect(r.title).toBe('Title');
    expect(r.headings).toEqual([{ level: 2, id: 'fades-and-crossfades', text: 'Fades and crossfades' }]);
    expect(r.html).toContain('<p>Some <strong>bold</strong>, <em>italic</em> and <code>Ctrl+S</code>.</p>');
  });

  it('escapes HTML instead of running it', () => {
    const r = renderMarkdown('<script>alert(1)</script> and `<b>`');
    expect(r.html).not.toContain('<script>');
    expect(r.html).toContain('&lt;script&gt;');
    expect(r.html).toContain('<code>&lt;b&gt;</code>');
  });

  it('renders nested lists, tables, code blocks and tip boxes', () => {
    const md = [
      '1. One',
      '2. Two',
      '   - inner',
      '',
      '| Key | Does |',
      '| --- | --- |',
      '| `A\\|B` | x |',
      '',
      '```',
      '# not a heading',
      '```',
      '',
      '> **Tip:** do this',
    ].join('\n');
    const { html, headings } = renderMarkdown(md);
    expect(html).toContain('<ol><li>One</li><li>Two<ul><li>inner</li></ul></li></ol>');
    expect(html).toContain('<td><code>A|B</code></td>');
    expect(html).toContain('<pre><code># not a heading</code></pre>');
    expect(html).toContain('<aside class="callout tip">');
    expect(headings).toEqual([]);
  });

  it('rewrites links between pages and marks external ones', () => {
    const { html } = renderMarkdown('[a](export.md#stems) [b](https://example.com)', { link: (h) => `#${resolveLink(h, 'x')}` });
    expect(html).toContain('<a href="#export/stems">a</a>');
    expect(html).toContain('<a href="https://example.com" class="external">b</a>');
  });

  it('makes ids like GitHub does', () => {
    expect(slug('Changing words (experimental)')).toBe('changing-words-experimental');
    expect(slug('Arm, record, stop')).toBe('arm-record-stop');
    expect(slug('Using a RØDECaster Pro II')).toBe('using-a-rødecaster-pro-ii');
  });

  it('gives repeated headings their own ids', () => {
    const { headings } = renderMarkdown('# T\n## Notes\n## Notes');
    expect(headings.map((h) => h.id)).toEqual(['notes', 'notes-1']);
  });
});

describe('the user guide', () => {
  it('has a title on every page and unique page ids', () => {
    expect(new Set(TOPICS.map((t) => t.id)).size).toBe(TOPICS.length);
    for (const [id, p] of pages) expect(p.title, id).toBeTruthy();
    expect(pages.has(DEFAULT_TOPIC)).toBe(true);
  });

  it('only links to pages and headings that exist', () => {
    for (const t of TOPICS) {
      for (const m of t.markdown.matchAll(/\]\(([^)\s]+)\)/g)) {
        const to = resolveLink(m[1], t.id);
        if (to === null) continue; // a web link
        expect(exists(to), `${t.id}: ${m[1]}`).toBe(true);
      }
    }
  });

  it('describes every menu command', () => {
    const main = readFileSync('src/main/main.ts', 'utf8');
    const menu = main.slice(main.indexOf('function buildMenu'), main.indexOf('appMenu = Menu.buildFromTemplate'));
    const labels = [...menu.matchAll(/label: '([^']+)'/g)].map((m) => m[1].replace('&&', '&').replace(/…$/, ''));
    expect(labels.length).toBeGreaterThan(40);
    const text = allText.toLowerCase();
    const missing = labels.filter((l) => !['File', 'Edit', 'View'].includes(l) && !text.includes(l.toLowerCase()));
    expect(missing).toEqual([]);
  });

  it('describes every built-in filter and voice effect', () => {
    for (const d of FX_DEFINITIONS) expect(pageText('filters'), d.name).toContain(`**${d.name}**`);
    const drama = pageText('audio-drama').toLowerCase();
    for (const e of VOICE_EFFECTS) expect(drama, e.name).toContain(e.name.toLowerCase());
  });

  it('lists every tool AI agents can use', () => {
    const tools = readFileSync('src/core/mcp/tools.ts', 'utf8');
    const names = [...tools.matchAll(/^\s+name: '([a-z_]+)'/gm)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(20);
    for (const n of names) expect(pageText('ai-agents'), n).toContain(`\`${n}\``);
  });

  it('has every keyboard shortcut on the shortcuts page', () => {
    const md = shortcutsMarkdown();
    for (const [, keys] of SHORTCUTS) for (const [k] of keys) expect(md).toContain(`\`${k.replace(/\|/g, '\\|')}\``);
    expect(renderMarkdown(md).headings.map((h) => h.text)).toEqual(SHORTCUTS.map(([g]) => g));
  });
});

describe('search', () => {
  const index = buildIndex(TOPICS);

  it('splits pages into sections at their headings', () => {
    const s = sections(TOPICS.find((t) => t.id === 'recording')!);
    expect(s[0].anchor).toBe('');
    expect(s.map((x) => x.anchor)).toContain('cough-buttons');
    expect(s.find((x) => x.anchor === 'cough-buttons')!.text).toMatch(/Shift\+1/);
  });

  it('finds sections by words at their start, best match first', () => {
    const hits = search(index, 'cough');
    expect(hits[0].section).toMatchObject({ topic: 'recording', anchor: 'cough-buttons' });
    expect(search(index, 'ripple cu').some((h) => h.section.topic === 'editing')).toBe(true);
    expect(search(index, 'xyzzy')).toEqual([]);
    expect(search(index, '  ')).toEqual([]);
  });

  it('needs every word to match', () => {
    for (const h of search(index, 'stems festival')) expect(fold(`${h.section.heading} ${h.section.text}`)).toMatch(/festival/);
  });

  it('treats British and American spellings alike', () => {
    expect(fold('Normalize')).toBe(fold('normalise'));
    expect(fold('colour')).toBe(fold('color'));
    expect(search(index, 'normalize').some((h) => h.section.topic === 'loudness')).toBe(true);
  });

  it('gives a snippet around the match', () => {
    const hit = search(index, 'auphonic')[0];
    expect(hit.snippet.toLowerCase()).toContain('auphonic');
    expect(hit.snippet.length).toBeLessThan(200);
  });
});

describe('context help', () => {
  it('opens a page that exists for every dialog, tab and view', () => {
    for (const [, topic] of DIALOG_TOPICS) expect(exists(topic), topic).toBe(true);
    for (const topic of Object.values(SETTINGS_TABS)) expect(exists(topic), topic).toBe(true);
    const views = ['setup', 'edit', 'chapters'] as const;
    for (const view of views) {
      for (const panel of ['fx', 'transcript', 'library', null] as const) {
        for (const tab of ['Project', 'Audio', null]) {
          const t = helpTopicFor({ view, panel, tab });
          expect(exists(t), `${view} ${panel} ${tab}: ${t}`).toBe(true);
        }
      }
    }
  });

  it('picks the page for what is on screen', () => {
    expect(helpTopicFor({ view: 'edit', dialog: 'Export episode' })).toBe('export');
    expect(helpTopicFor({ view: 'edit', dialog: 'Settings', tab: 'Controllers' })).toBe('controllers');
    expect(helpTopicFor({ view: 'edit', dialog: 'Change words Experimental' })).toBe('transcript/changing-words-experimental');
    expect(helpTopicFor({ view: 'setup', tab: 'Audio' })).toBe('audio-setup');
    expect(helpTopicFor({ view: 'edit', panel: 'fx' })).toBe('filters');
    expect(helpTopicFor({ view: 'edit', recording: true })).toBe('recording');
    expect(helpTopicFor({ view: 'edit' })).toBe('timeline');
  });
});
