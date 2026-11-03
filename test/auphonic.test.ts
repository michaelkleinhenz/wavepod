import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuphonicClient, productionRequest, productionUrl, trackIds } from '../src/core/auphonic';
import { addMarker, addTrack, createProject } from '../src/core/project';
import { tmpDir } from './helpers';

interface Seen {
  method: string;
  url: string;
  auth: string;
  type: string;
  body: Buffer;
}

function mockAuphonic(): Promise<{ base: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, auth: String(req.headers.authorization), type: String(req.headers['content-type']), body: Buffer.concat(chunks) });
      res.setHeader('Content-Type', 'application/json');
      if (req.headers.authorization !== 'bearer KEY') {
        res.statusCode = 401;
        return res.end('{"error_message":"Authentication failed"}');
      }
      if (req.url === '/api/presets.json') return res.end(JSON.stringify({ data: [{ uuid: 'p1', preset_name: 'Show', is_multitrack: true }, { uuid: 'p2', preset_name: 'Single', is_multitrack: false }] }));
      if (req.url === '/api/productions.json') return res.end(JSON.stringify({ status_code: 200, data: { uuid: 'u123' } }));
      if (req.url === '/api/production/u123/upload.json' || req.url === '/api/production/u123/start.json') return res.end('{"status_code":200,"data":{}}');
      res.statusCode = 404;
      res.end('{"error_message":"not found"}');
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ base: `http://127.0.0.1:${port}`, seen, close: () => new Promise((r) => server.close(() => r())) });
    }),
  );
}

describe('Auphonic', () => {
  let close: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await close?.();
    close = null;
  });

  it('makes unique track ids', () => {
    expect(trackIds(['Host', 'Gäst Nr. 1', 'Host', ''])).toEqual(['host', 'gast_nr_1', 'host_2', 'track4']);
  });

  it('builds a multitrack production with metadata and chapters', () => {
    let p = createProject('Ep', 48000);
    p.metadata = { ...p.metadata, title: 'Episode 3', author: 'Me', podcast: 'Show', description: 'About things', category: 'Technology' };
    p = addMarker(p, 0, 'chapter', 'Intro').project;
    p = addMarker(p, 48000 * 75, 'chapter', 'Talk').project;
    p.markers[1].url = 'https://example.com';
    p = addMarker(p, 4800, 'edit', 'fix').project;
    const body = productionRequest(p, [{ id: 'host', title: 'Host', file: 'a' }, { id: 'guest', title: 'Guest', file: 'b' }], 'p1');
    expect(body).toEqual({
      preset: 'p1',
      is_multitrack: true,
      metadata: { title: 'Episode 3', artist: 'Me', album: 'Show', year: p.metadata.year, summary: 'About things', genre: 'Technology' },
      multi_input_files: [{ type: 'multitrack', id: 'host' }, { type: 'multitrack', id: 'guest' }],
      chapters: [{ start: '00:00:00.000', title: 'Intro' }, { start: '00:01:15.000', title: 'Talk', url: 'https://example.com' }],
    });
    expect(productionUrl('u1')).toBe('https://auphonic.com/engine/multitrack/edit/u1');
  });

  it('talks to the API: presets, create, upload by track id, start', async () => {
    const mock = await mockAuphonic();
    close = mock.close;
    const c = new AuphonicClient('KEY', mock.base);
    expect((await c.presets()).map((p) => p.name)).toEqual(['Show', 'Single']);
    const uuid = await c.createProduction(productionRequest(addTrack(createProject('E')), []));
    expect(uuid).toBe('u123');
    const file = path.join(tmpDir(), 'host.flac');
    fs.writeFileSync(file, Buffer.from('fLaC-data'));
    await c.upload(uuid, 'host', file);
    await c.start(uuid);
    const [, create, upload, start] = mock.seen;
    expect(create.type).toContain('application/json');
    expect(JSON.parse(create.body.toString()).is_multitrack).toBe(true);
    expect(upload.type).toContain('multipart/form-data');
    expect(upload.body.toString()).toContain('name="host"; filename="host.flac"');
    expect(upload.body.toString()).toContain('fLaC-data');
    expect(start.url).toBe('/api/production/u123/start.json');
    expect(mock.seen.every((s) => s.auth === 'bearer KEY')).toBe(true);
  });

  it('explains a wrong key', async () => {
    const mock = await mockAuphonic();
    close = mock.close;
    await expect(new AuphonicClient('nope', mock.base).presets()).rejects.toThrow(/API key/);
  });
});
