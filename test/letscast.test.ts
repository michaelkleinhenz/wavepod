import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LetsCastClient, LetsCastSignedOut, editUrl, letscastDate, letscastUpdate, parseEpisodeLink, parseEpisodePage, parseEpisodes, parsePodcasts, parseShowNotes, textToHtml } from '../src/core/letscast';
import { createProject } from '../src/core/project';
import { tmpDir } from './helpers';

// Shaped like letscast.fm's pages as of November 2026.
const PODCASTS = `
<a aria-label="Tatort Spieltisch Schnellauswahl öffnen" href="https://letscast.fm/podcasts/tatort-spieltisch-ca9a26e9/episodes"><img alt='Tatort Spieltisch Cover' class='relative' src='x.png'></a>
<div class='podcast-card w-72'><a aria-label='Podcast Tatort Spieltisch öffnen' href='https://letscast.fm/podcasts/tatort-spieltisch-ca9a26e9/episodes'><img alt='Tatort Spieltisch Cover'></a></div>
<a href="/podcasts/tatort-spieltisch-ca9a26e9/edit">Bearbeiten</a>
<a href="/podcasts/new">Podcast anlegen</a>
<a href="https://letscast.fm/podcasts/tabulaludo-5d181655/episodes">Tabulaludo &amp; Freunde</a>`;

const EPISODES = `
<div class="mt-4"><div class="flex">
 <a href="https://letscast.fm/podcasts/tabulaludo-5d181655/episodes/claude-test/edit"><div class="h-32 lozad"></div></a>
 <div class="px-4"><div class="font-bold"><a href="https://letscast.fm/podcasts/tabulaludo-5d181655/episodes/claude-test/edit">Claude Test </a></div>
 <div class="inline-flex"><p class="text-sm"> 31.12.26 12:00 Uhr (Episode: 888) </p>
 <span class="notice-label"><a href="https://letscast.fm/podcasts/tabulaludo-5d181655/episodes/claude-test/edit">Episode wird veröffentlicht in etwa einem Monat</a></span></div>
 <a href="https://letscast.fm/podcasts/tabulaludo-5d181655/episodes/claude-test/edit">Bearbeiten</a></div></div></div>
<div class="mt-4"><a href="https://letscast.fm/podcasts/tabulaludo-5d181655/episodes/999-review-the-last-kingdom/edit">Review: &quot;The Last Kingdom&quot;</a><p> 01.11.26 06:00 Uhr (Episode: 999) </p></div>
<a href="https://letscast.fm/podcasts/tabulaludo-5d181655/episodes/new">Episode hinzufügen</a>`;

function editPage(audio: string, blobId = ''): string {
  return `<html><head><meta name="csrf-token" content="TOKEN+/="></head><body>
<form action="/podcasts/tabulaludo-5d181655/episodes/claude-test" method="post"><input type="hidden" name="_method" value="patch">
<input class="input" type="text" value="Claude &amp; Test" name="episode[title]" id="episode_title">
${audio ? `<input value="${blobId}" autocomplete="off" type="hidden" name="episode[audio_blob_id]" id="episode_audio_blob_id" />` : ''}
${audio ? `<audio class='mt-6' controls preload='none'> <source src='${audio}?t=1' type='audio/mpeg'> </audio>` : ''}
<input data-direct-upload-url="https://letscast.fm/media/direct_uploads" type="file" name="episode[audio]" id="episode_audio"></form></body></html>`;
}

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function multipart(body: string): Array<[string, string]> {
  return [...body.matchAll(/name="([^"]+)"\r\n\r\n([\s\S]*?)\r\n--/g)].map((m) => [m[1], m[2]]);
}

function mockLetsCast(): Promise<{ base: string; seen: Seen[]; forms: Array<{ url: string; fields: Array<[string, string]> }>; state: { showNotes: string; created: string }; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  let audio = '';
  let uploads = 0;
  const state = { showNotes: '', created: '' };
  const forms: Array<{ url: string; fields: Array<[string, string]> }> = [];
  let stored: Buffer | null = null;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      const url = req.url!.split('?')[0];
      if (url === '/users/sign_in') return res.end('<form action="/users/sign_in" method="post"></form>');
      if (url === '/storage/blob1' && req.method === 'PUT') {
        const md5 = createHash('md5').update(body).digest('base64');
        if (req.headers['content-md5'] !== md5) {
          res.statusCode = 400;
          return res.end('bad checksum');
        }
        stored = body;
        return res.end();
      }
      if (req.headers.cookie !== 'session=ok') {
        res.statusCode = 302;
        res.setHeader('Location', '/users/sign_in');
        return res.end();
      }
      if (url === '/podcasts') return res.end(PODCASTS);
      if (url === '/podcasts/tabulaludo-5d181655/episodes' && req.method === 'GET')
        return res.end(
          (state.created ? `<div><a href="/podcasts/tabulaludo-5d181655/episodes/${state.created}/edit">Folge 441</a><p> 31.12.26 06:00 Uhr (Episode: 441) </p></div>` : '') + EPISODES,
        );
      if (/^\/podcasts\/tabulaludo-5d181655\/episodes\/[^/]+\/edit$/.test(url)) return res.end(editPage(audio, `blob-${uploads}`));
      if (url === '/media/direct_uploads' && req.method === 'POST') {
        if (req.headers['x-csrf-token'] !== 'TOKEN+/=') {
          res.statusCode = 422;
          return res.end('{}');
        }
        const { blob } = JSON.parse(body.toString());
        res.setHeader('Content-Type', 'application/json');
        return res.end(
          JSON.stringify({
            id: `blob-${uploads + 1}`,
            filename: blob.filename,
            byte_size: blob.byte_size,
            signed_id: `SIGNED-${blob.filename}`,
            direct_upload: { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/storage/blob1?X-Amz-Signature=x`, headers: { 'Content-Type': blob.content_type, 'Content-MD5': blob.checksum } },
          }),
        );
      }
      if (/\/show_notes\/edit$/.test(url)) return res.end(`<input type="hidden" name="episode[content]" value="${state.showNotes.replace(/</g, '&lt;').replace(/>/g, '&gt;')}">`);
      if (url === '/podcasts/tabulaludo-5d181655/episodes/new') return res.end(editPage(''));
      if (url === '/podcasts/tabulaludo-5d181655/episodes' && req.method === 'POST') {
        forms.push({ url, fields: multipart(body.toString()) });
        state.created = '441-folge-441';
        res.statusCode = 302;
        res.setHeader('Location', `/podcasts/tabulaludo-5d181655/episodes/${state.created}/edit`);
        return res.end();
      }
      if (url.startsWith('/podcasts/tabulaludo-5d181655/episodes/') && url.endsWith('/show_notes') && req.method === 'POST') {
        forms.push({ url, fields: multipart(body.toString()) });
        res.statusCode = 302;
        res.setHeader('Location', '/podcasts/tabulaludo-5d181655/episodes/claude-test/edit');
        return res.end();
      }
      if (url === '/podcasts/tabulaludo-5d181655/episodes/claude-test' && req.method === 'POST') {
        const form = body.toString();
        forms.push({ url, fields: multipart(form) });
        if (!form.includes('name="_method"') || !form.includes('TOKEN+/=') || (form.includes('episode[audio]') && !stored)) {
          res.statusCode = 422;
          return res.end(editPage(audio, `blob-${uploads}`));
        }
        if (form.includes('name="episode[audio]"')) audio = `/media/podcast/c5ef2401/episode/new${++uploads}.mp3`;
        res.statusCode = 302;
        res.setHeader('Location', '/podcasts/tabulaludo-5d181655/episodes/claude-test/edit');
        return res.end();
      }
      res.statusCode = 404;
      res.end('not found');
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ base: `http://127.0.0.1:${port}`, seen, forms, state, close: () => new Promise((r) => server.close(() => r())) });
    }),
  );
}

// Like the app's Electron session fetch: sends the cookie, follows redirects, and (as Electron's
// fetch does) leaves Response.url and .redirected empty.
const withCookie = (cookie: string) => async (url: string, init?: RequestInit) => {
  const r = await fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), cookie } });
  return new Response(r.status === 204 ? null : await r.arrayBuffer(), { status: r.status, headers: r.headers });
};

describe('LetsCast.fm', () => {
  let close: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await close?.();
    close = null;
  });

  it('reads episode links', () => {
    expect(parseEpisodeLink('https://letscast.fm/podcasts/tabulaludo-5d181655/episodes/claude-test/edit')).toEqual({ podcast: 'tabulaludo-5d181655', episode: 'claude-test' });
    expect(parseEpisodeLink(' https://www.letscast.fm/podcasts/a-1/episodes/b_2?x=1 ')).toEqual({ podcast: 'a-1', episode: 'b_2' });
    expect(parseEpisodeLink('/podcasts/a/episodes/new')).toBeNull();
    expect(parseEpisodeLink('https://example.com/podcasts/a/episodes/b')).toBeNull();
    expect(editUrl('a', 'b')).toBe('https://letscast.fm/podcasts/a/episodes/b/edit');
  });

  it('reads podcasts, episodes and the edit page', () => {
    expect(parsePodcasts(PODCASTS)).toEqual([
      { slug: 'tatort-spieltisch-ca9a26e9', title: 'Tatort Spieltisch' },
      { slug: 'tabulaludo-5d181655', title: 'Tabulaludo & Freunde' },
    ]);
    expect(parseEpisodes(EPISODES, 'tabulaludo-5d181655')).toEqual([
      { slug: 'claude-test', title: 'Claude Test', info: '31.12.26 12:00 Uhr (Episode: 888)', number: '888' },
      { slug: '999-review-the-last-kingdom', title: 'Review: "The Last Kingdom"', info: '01.11.26 06:00 Uhr (Episode: 999)', number: '999' },
    ]);
    expect(parseEpisodePage(editPage(''))).toEqual({ csrf: 'TOKEN+/=', title: 'Claude & Test', audio: '', audioBlobId: '' });
    expect(parseEpisodePage(editPage('https://lcdn.letscast.fm/x.mp3')).audio).toBe('https://lcdn.letscast.fm/x.mp3');
  });

  it('knows when it is signed out', async () => {
    const mock = await mockLetsCast();
    close = mock.close;
    const c = new LetsCastClient(withCookie('session=nope'), mock.base);
    expect(await c.signedIn()).toBe(false);
    await expect(c.podcasts()).rejects.toBeInstanceOf(LetsCastSignedOut);
  });

  it('uploads the MP3 like the web app: direct upload, PUT with MD5, PATCH only the audio', async () => {
    const mock = await mockLetsCast();
    close = mock.close;
    const c = new LetsCastClient(withCookie('session=ok'), mock.base);
    expect(await c.signedIn()).toBe(true);
    expect((await c.episodes('tabulaludo-5d181655')).map((e) => e.slug)).toEqual(['claude-test', '999-review-the-last-kingdom']);
    const file = path.join(tmpDir(), 'Episode 3.mp3');
    fs.writeFileSync(file, Buffer.from([0xff, 0xfb, 0x90, 0x64, 1, 2, 3]));
    const phases: string[] = [];
    const r = await c.uploadAudio('tabulaludo-5d181655', 'claude-test', file, (p) => phases.push(p.phase));
    expect(r.audio).toBe('/media/podcast/c5ef2401/episode/new1.mp3');
    expect(phases.at(-1)).toBe('Done');
    // a second upload replaces the audio
    expect((await c.uploadAudio('tabulaludo-5d181655', 'claude-test', file)).audio).toBe('/media/podcast/c5ef2401/episode/new2.mp3');

    const create = mock.seen.find((s) => s.url === '/media/direct_uploads')!;
    expect(JSON.parse(create.body.toString())).toEqual({
      blob: { filename: 'Episode 3.mp3', content_type: 'audio/mpeg', byte_size: 7, checksum: createHash('md5').update(fs.readFileSync(file)).digest('base64') },
    });
    const patch = mock.seen.find((s) => s.method === 'POST' && s.url.endsWith('/episodes/claude-test'))!;
    expect(patch.headers['content-type']).toMatch(/^multipart\/form-data/);
    const fields = [...patch.body.toString().matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
    expect(fields).toEqual(['_method', 'authenticity_token', 'episode[audio]']);
  });

  it('formats dates and show notes the way LetsCast stores them', () => {
    expect(letscastDate('2026-12-31T06:05')).toBe('31.12.2026 06:05');
    expect(letscastDate('nope')).toBe('');
    expect(textToHtml('Hallo <Welt> & so\nzweite Zeile\n\n- Punkt https://wavepod.de.\n- zwei\nDanach')).toBe(
      '<div>Hallo &lt;Welt&gt; &amp; so<br>zweite Zeile</div><ul><li>Punkt <a href="https://wavepod.de">https://wavepod.de</a>.</li><li>zwei</li></ul><div>Danach</div>',
    );
    expect(parseShowNotes('<input type="hidden" name="episode[content]" id="x" value="&lt;div&gt;Hi&lt;/div&gt;">')).toBe('<div>Hi</div>');
    expect(parseShowNotes('<input type="hidden" name="episode[content]" value="&lt;div&gt;&lt;br&gt;&lt;/div&gt;">')).toBe('');
  });

  it('sends only what is chosen and has a value in WavePod', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'images'));
    fs.writeFileSync(path.join(dir, 'images', 'cover.jpg'), 'jpg');
    const p = createProject('Ep', 48000);
    p.metadata = {
      ...p.metadata,
      title: 'Folge 441',
      episode: '441',
      author: '',
      description: 'Kurz',
      showNotes: 'Notizen',
      artwork: 'images/cover.jpg',
      subtitle: 'Mit Gästen',
      publishDate: '2026-12-31T06:00',
      episodeType: 'bonus',
      keywords: 'Brettspiele, Heat',
      explicit: false,
      hidden: true,
    };
    const all = { audio: true, details: true, showNotes: true, cover: true };
    expect(letscastUpdate(p, dir, all)).toEqual({
      fields: [
        ['episode[title]', 'Folge 441'],
        ['episode[subtitle]', 'Mit Gästen'],
        ['episode[publishing_date]', '31.12.2026 06:00'],
        ['episode[episode_type]', 'bonus'],
        ['episode[number]', '441'],
        ['episode[keywords]', 'Brettspiele, Heat'],
        ['episode[summary]', '<div>Kurz</div>'],
        ['episode[has_explicit_content]', '0'],
        ['episode[hidden]', '1'],
      ],
      showNotesHtml: '<div>Notizen</div>',
      coverFile: path.join(dir, 'images', 'cover.jpg'),
    });
    expect(letscastUpdate(p, dir, { ...all, details: false, showNotes: false, cover: false })).toEqual({});
    p.metadata.episode = 'S2E3';
    expect(letscastUpdate(p, dir, all).fields!.some(([k]) => k === 'episode[number]')).toBe(false);
  });

  it('updates the episode with the same number, keeping show notes it has', async () => {
    const mock = await mockLetsCast();
    close = mock.close;
    mock.state.showNotes = '<div>Schon da</div>';
    const c = new LetsCastClient(withCookie('session=ok'), mock.base);
    expect((await c.findByNumber('tabulaludo-5d181655', '888'))?.slug).toBe('claude-test');
    expect(await c.findByNumber('tabulaludo-5d181655', '441')).toBeNull();
    const dir = tmpDir();
    const cover = path.join(dir, 'cover.jpg');
    fs.writeFileSync(cover, 'jpg');
    await c.updateEpisode('tabulaludo-5d181655', 'claude-test', { coverFile: cover, fields: [['episode[title]', 'Folge 441'], ['episode[hidden]', '0']], showNotesHtml: '<div>Neu</div>' });
    const byUrl = (u: string) => mock.forms.filter((f) => f.url.endsWith(u)).map((f) => f.fields.filter(([k]) => k !== 'authenticity_token'));
    expect(byUrl('/episodes/claude-test')).toEqual([
      [
        ['_method', 'patch'],
        ['episode[image]', 'SIGNED-cover.jpg'],
        ['episode[title]', 'Folge 441'],
        ['episode[hidden]', '0'],
      ],
    ]);
    expect(byUrl('/show_notes')).toEqual([]);
    // without show notes there, they are written
    mock.state.showNotes = '';
    await c.updateEpisode('tabulaludo-5d181655', 'claude-test', { showNotesHtml: '<div>Neu</div>' });
    expect(byUrl('/show_notes')).toEqual([
      [
        ['_method', 'patch'],
        ['episode[content]', '<div>Neu</div>'],
      ],
    ]);
  });

  it('creates a new episode when there is none with that number', async () => {
    const mock = await mockLetsCast();
    close = mock.close;
    const c = new LetsCastClient(withCookie('session=ok'), mock.base);
    await expect(c.createEpisode('tabulaludo-5d181655', { fields: [['episode[title]', 'Folge 441']] })).rejects.toThrow(/publishing date/);
    await expect(c.createEpisode('tabulaludo-5d181655', { fields: [['episode[publishing_date]', '31.12.2026 06:00']] })).rejects.toThrow(/title/);
    const slug = await c.createEpisode('tabulaludo-5d181655', {
      fields: [
        ['episode[title]', 'Folge 441'],
        ['episode[publishing_date]', '31.12.2026 06:00'],
        ['episode[number]', '441'],
      ],
      showNotesHtml: '<div>Notizen</div>',
    });
    expect(slug).toBe('441-folge-441');
    const create = mock.forms.find((f) => f.url === '/podcasts/tabulaludo-5d181655/episodes')!;
    expect(create.fields.map(([k]) => k)).toEqual(['authenticity_token', 'episode[title]', 'episode[publishing_date]', 'episode[number]']);
    expect(mock.forms.some((f) => f.url.endsWith('/441-folge-441/show_notes'))).toBe(true);
  });
});
