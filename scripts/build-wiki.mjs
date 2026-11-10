// Builds the GitHub wiki from the repository's docs, so the wiki is never edited by hand.
//
//   node scripts/build-wiki.mjs <bundled-topics.mjs> <out-dir>
//
// <bundled-topics.mjs> is src/help/topics.ts bundled with esbuild (`make wiki` does this), so the
// wiki has the same pages, order and groups as the in-app help, including the generated keyboard
// shortcuts page. Every user guide page becomes a wiki page named after its title; installation
// and build steps come from README.md, plus the roadmap and the third-party notices. Links between
// the files are rewritten to wiki page links, and links to anything else in the repository point
// at the file on GitHub. The Home page, sidebar and footer are generated here.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [topicsBundle, outDir] = process.argv.slice(2);
if (!topicsBundle || !outDir) {
  console.error('usage: node scripts/build-wiki.mjs <bundled-topics.mjs> <out-dir>');
  process.exit(2);
}

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const REPO = process.env.GITHUB_REPOSITORY || 'michaelkleinhenz/wavepod';
const BRANCH = process.env.WIKI_BRANCH || 'main';
const BLOB = `https://github.com/${REPO}/blob/${BRANCH}/`;
const TREE = `https://github.com/${REPO}/tree/${BRANCH}/`;
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/`;

const { TOPICS } = await import(pathToFileURL(path.resolve(topicsBundle)).href);

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const titleOf = (md) => /^#\s+(.+)$/m.exec(md)?.[1].trim() ?? 'Untitled';
/** Wiki page name for a title: GitHub turns the file name's dashes back into spaces. */
const pageName = (title) => title.replace(/[^\p{L}\p{N} -]/gu, '').trim().replace(/\s+/g, '-');

/** A section of README.md, from its `## heading` up to the next `## `. */
function readmeSection(heading) {
  const lines = read('README.md').split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) throw new Error(`README.md has no "## ${heading}" section`);
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join('\n').trim();
}

// Every page: wiki name, title, the repository file it comes from (for links) and its Markdown.
const pages = [];
for (const t of TOPICS) {
  const source = t.id === 'shortcuts' ? 'src/renderer/shortcuts.ts' : `docs/guide/${t.id}.md`;
  const title = titleOf(t.markdown);
  pages.push({ name: pageName(title), title, group: t.group, source, id: t.id, markdown: t.markdown });
}
const extra = [
  { title: 'Installation', source: 'README.md', markdown: `# Installation\n\n${readmeSection('Getting started')}` },
  { title: 'Build from source', source: 'README.md', markdown: `# Build from source\n\n${readmeSection('Build from source')}` },
  { title: 'Roadmap', source: 'docs/PLAN.md', markdown: read('docs/PLAN.md') },
  { title: 'Third-party notices', source: 'THIRD_PARTY_NOTICES.md', markdown: read('THIRD_PARTY_NOTICES.md') },
];
for (const p of extra) pages.push({ ...p, name: pageName(p.title), group: 'Project' });

// Repository file → wiki page, for rewriting links.
const pageForFile = new Map([['docs/guide/README.md', 'Home']]);
for (const p of pages) if (p.id) pageForFile.set(`docs/guide/${p.id}.md`, p.name);
pageForFile.set('docs/PLAN.md', 'Roadmap');
pageForFile.set('THIRD_PARTY_NOTICES.md', pageName('Third-party notices'));

/** GitHub's id for a heading, as used in `#anchor` links. */
const slug = (heading) => heading.replace(/[`*_]/g, '').trim().toLowerCase().replace(/[^\p{L}\p{N}\- ]/gu, '').replace(/ /g, '-');
const anchorsOf = (md) => new Set([...md.replace(/^```[\s\S]*?^```/gm, '').matchAll(/^#+\s+(.+)$/gm)].map((m) => slug(m[1])));
/** README.md is split over several pages, so `#anchor` links in it may lead to another page. */
const readmePages = pages.filter((p) => p.source === 'README.md').map((p) => ({ name: p.name, anchors: anchorsOf(p.markdown) }));
function readmeAnchor(anchor, current) {
  const own = readmePages.find((p) => p.name === current);
  if (own?.anchors.has(anchor)) return `#${anchor}`;
  const other = readmePages.find((p) => p.anchors.has(anchor));
  return other ? `${other.name}#${anchor}` : `${BLOB}README.md#${anchor}`;
}

/** Rewrites the links of Markdown that lives at `source` in the repository, leaving code alone. */
function rewriteLinks(md, source, current) {
  const dir = path.posix.dirname(source);
  const fix = (bang, text, href) => {
    const m = /^(\S+?)(\s+"[^"]*")?$/.exec(href.trim());
    if (!m) return `${bang}[${text}](${href})`;
    let [, url, titlePart = ''] = m;
    if (source === 'README.md' && url.startsWith('#')) return `${bang}[${text}](${readmeAnchor(url.slice(1), current)}${titlePart})`;
    if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(url)) return `${bang}[${text}](${href})`;
    const [file, anchor] = url.split('#');
    const target = path.posix.normalize(path.posix.join(dir, file));
    const hash = anchor ? `#${anchor}` : '';
    if (!bang && pageForFile.has(target)) url = pageForFile.get(target) + hash;
    else if (bang) url = RAW + target;
    else {
      const full = path.join(ROOT, target);
      const isDir = existsSync(full) && statSync(full).isDirectory();
      url = (isDir ? TREE : BLOB) + target + hash;
    }
    return `${bang}[${text}](${url}${titlePart})`;
  };
  return md
    .split(/(^```[\s\S]*?^```)/m)
    .map((part, i) =>
      i % 2 ? part : part.split(/(`[^`\n]*`)/).map((bit, j) => (j % 2 ? bit : bit.replace(/(!?)\[([^\]]*)\]\(([^)\s]+(?:\s+"[^"]*")?)\)/g, (_, b, t, h) => fix(b, t, h)))).join(''),
    )
    .join('');
}

/** The wiki shows the page name as the title, so the page's own `# Title` line goes. */
const dropTitle = (md) => md.replace(/^#\s+.+\n+/, '');

const groups = [];
for (const p of pages) {
  let g = groups.find((x) => x.name === p.group);
  if (!g) groups.push((g = { name: p.group, pages: [] }));
  g.pages.push(p);
}
const link = (p) => `[${p.title}](${p.name})`;

const home = [
  '**Record and edit your podcast or audio drama like a document.** WavePod is a free, open-source multitrack recorder and editor for Linux, Windows and macOS.',
  `**[Download WavePod](https://github.com/${REPO}/releases/latest)** · [Website](https://${REPO.split('/')[0]}.github.io/${REPO.split('/')[1]}/) · [Source code](https://github.com/${REPO}) · [Report a problem](https://github.com/${REPO}/issues)`,
  "This is WavePod's user guide. The same pages open in the app under **Help › WavePod Help** (`F1`), with full-text search and at the page for the view or dialog you are in.",
  'New to WavePod? Start with [Installation](Installation) and then [Getting started](Getting-started).',
  ...groups.map((g) => `## ${g.name}\n\n${g.pages.map((p) => `- ${link(p)}`).join('\n')}`),
].join('\n\n');

const sidebar = [
  '**[Home](Home)**',
  ...groups.map((g) => `**${g.name}**\n\n${g.pages.map((p) => `- ${link(p)}`).join('\n')}`),
].join('\n\n');

const footer = `This wiki is generated from [docs/guide](${TREE}docs/guide) and the README in the repository; changes made here are overwritten. To improve a page, edit the file there.`;

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const write = (name, md) => writeFileSync(path.join(outDir, `${name}.md`), md.trim() + '\n');
write('Home', home);
write('_Sidebar', sidebar);
write('_Footer', footer);
for (const p of pages) write(p.name, rewriteLinks(dropTitle(p.markdown), p.source, p.name));
console.log(`Wrote ${pages.length + 3} wiki pages to ${outDir}`);
