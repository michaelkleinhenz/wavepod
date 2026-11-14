import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
}));

import { CamPodClient, cameraProblem, cameraStartFrame, downloadFolder, linkSession, normalizeCamPodSettings, normalizeCamPodUrl, sessionFiles, sessionsFromWire, statusFromWire } from '../src/core/campod';
import { CamPodDownloader, CamPodFollower, camPodInfo, updateCamPodSettings } from '../src/main/campod';
import { createProject, normalizeProject } from '../src/core/project';
import type { CamPodEvent } from '../src/shared/types';

describe('CamPod address and settings', () => {
  it('turns what the user types into a base URL', () => {
    expect(normalizeCamPodUrl('studio-pc')).toBe('http://studio-pc:8080');
    expect(normalizeCamPodUrl(' 192.168.1.20 ')).toBe('http://192.168.1.20:8080');
    expect(normalizeCamPodUrl('192.168.1.20:9000')).toBe('http://192.168.1.20:9000');
    expect(normalizeCamPodUrl('http://campod.local/')).toBe('http://campod.local');
    expect(normalizeCamPodUrl('https://cams.example.com/ui/')).toBe('https://cams.example.com');
    expect(normalizeCamPodUrl('')).toBe('');
    expect(() => normalizeCamPodUrl('ftp://x')).toThrow(/http/);
    expect(() => normalizeCamPodUrl('not a host')).toThrow(/address/);
  });

  it('keeps settings sane and the token out of the window', () => {
    expect(normalizeCamPodSettings(null)).toEqual({ url: '', token: '', followRecording: true });
    expect(normalizeCamPodSettings({ url: 'box', followRecording: false, token: 5 })).toEqual({ url: 'http://box:8080', token: '', followRecording: false });
    const s = updateCamPodSettings(normalizeCamPodSettings(null), { url: 'box', token: ' secret ' });
    expect(s.url).toBe('http://box:8080');
    expect(camPodInfo(s)).toEqual({ url: 'http://box:8080', hasToken: true, followRecording: true });
    expect(camPodInfo(updateCamPodSettings(s, { token: '' })).hasToken).toBe(false);
    expect(updateCamPodSettings(s, { followRecording: false }).token).toBe(s.token);
  });
});

describe('what WavePod can import', () => {
  it('flags MJPEG kept as it is and cameras without sound', () => {
    expect(cameraProblem({ fourcc: 'MJPG', codec: 'copy', hasAudio: true })).toMatch(/MJPEG/);
    expect(cameraProblem({ fourcc: 'MJPG', codec: 'h264', hasAudio: true })).toBeNull();
    expect(cameraProblem({ fourcc: 'H264', codec: 'copy', hasAudio: true })).toBeNull();
    expect(cameraProblem({ fourcc: 'YUYV', codec: 'h264', hasAudio: false })).toMatch(/no sound/);
  });

  it('reads CamPod status', () => {
    const s = statusFromWire({
      version: '0.2.0',
      recording: null,
      disk: { remaining: 7200e9 },
      cameras: [
        { id: 'a', name: 'Host', present: true, state: 'preview', choice: { fourcc: 'MJPG', width: 1920, height: 1080, fps: 30 }, codec: 'copy', hasAudio: true, settings: { enabled: true, videoCodec: '', useAudio: true } },
        { id: 'b', name: 'Guest', present: true, state: 'preview', choice: { fourcc: 'H264', width: 1920, height: 1080, fps: 30 }, codec: 'copy', hasAudio: true, settings: { enabled: true, useAudio: true } },
        { id: 'c', name: 'Wide', present: false, settings: { enabled: true } },
      ],
    });
    expect(s.remainingSeconds).toBe(7200);
    expect(s.cameras.map((c) => [c.name, c.format, c.canSwitchToH264, !!c.problem])).toEqual([
      ['Host', 'MJPG 1920×1080 30 fps', true, true],
      ['Guest', 'H264 1920×1080 30 fps', false, false],
      ['Wide', '', false, false],
    ]);
    const enc = statusFromWire({ cameras: [{ id: 'a', name: 'Host', present: true, choice: { fourcc: 'MJPG', width: 1280, height: 720, fps: 30 }, codec: 'h264', hasAudio: true, settings: { enabled: true } }] });
    expect(enc.cameras[0]).toMatchObject({ format: 'H.264 (from MJPG) 1280×720 30 fps', canSwitchToH264: false, problem: null });
  });

  it('picks the camera files of a recording, parts included', () => {
    const r = sessionFiles({
      name: '2026-11-14_1900_folge-1',
      cameras: [
        { id: 'a', name: 'Host', files: ['cam-host.mkv', 'cam-host_part2.mkv'], choice: { fourcc: 'MJPG' }, codec: 'h264', hasAudio: true },
        { id: 'b', name: 'Guest', files: ['cam-guest.mkv'], choice: { fourcc: 'MJPG' }, codec: 'copy', hasAudio: true },
        { id: 'c', name: 'Wide', files: [], startError: 'Gerät belegt' },
        { id: 'd', name: 'Sneaky', files: ['../etc/passwd', 'x/y.mkv'], choice: { fourcc: 'H264' }, codec: 'copy', hasAudio: true },
      ],
    });
    expect(r.files).toEqual([
      { camera: 'Host (part 1)', file: 'cam-host.mkv', part: 1 },
      { camera: 'Host (part 2)', file: 'cam-host_part2.mkv', part: 2 },
    ]);
    expect(r.skipped).toHaveLength(3);
    expect(r.skipped[0]).toMatch(/^Guest: .*MJPEG/);
    expect(r.skipped[1]).toMatch(/Gerät belegt/);
    expect(downloadFolder('2026-11-14_1900_folge 1')).toBe('video/2026-11-14_1900_folge_1');
  });

  it('remembers which recordings belong to the episode', () => {
    let p = createProject('Ep');
    p = linkSession(p, { name: '2026-11-14_1900_ep', start: 48000 });
    p = linkSession(p, { name: '2026-11-14_1900_ep', start: 96000 });
    expect(p.campod).toEqual({ sessions: [{ name: '2026-11-14_1900_ep', start: 96000 }] });
    expect(cameraStartFrame(p, '2026-11-14_1900_ep', 1)).toBe(96000);
    expect(cameraStartFrame(p, '2026-11-14_1900_ep', 2)).toBeUndefined();
    expect(cameraStartFrame(p, 'other', 1)).toBeUndefined();
    const list = sessionsFromWire([{ name: '2026-11-14_1900_ep', duration: 90e9, files: 2 }, { name: 'x', files: 1 }], p);
    expect(list.map((s) => [s.linked, s.seconds])).toEqual([[true, 90], [false, 0]]);
    // survives saving and loading; junk is dropped
    const raw = JSON.parse(JSON.stringify({ ...p, campod: { sessions: [...p.campod!.sessions, { name: '../x', start: 1 }, { name: 'y', start: -5 }] } }));
    expect(normalizeProject(raw).campod).toEqual(p.campod);
    expect(normalizeProject({ ...raw, campod: { sessions: [] } }).campod).toBeUndefined();
  });
});

// ---------------------------------------------------------------- against a fake CamPod

interface Fake {
  url: string;
  calls: string[];
  files: Record<string, Buffer>;
  startDelay: number;
  token: string;
  close: () => Promise<void>;
}

async function fakeCamPod(): Promise<Fake> {
  const fake: Fake = { url: '', calls: [], files: {}, startDelay: 0, token: '', close: async () => {} };
  let recording: string | null = null;
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    fake.calls.push(`${req.method} ${url}${req.headers.range ? ` ${req.headers.range}` : ''}`);
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (fake.token && req.headers.authorization !== `Bearer ${fake.token}`) return json(401, { error: 'Zugangstoken fehlt oder ist falsch' });
    if (req.method === 'POST' && url === '/api/recording/start') {
      if (recording) return json(409, { error: 'Aufnahme läuft bereits' });
      return void setTimeout(() => {
        recording = '2026-11-14_1900_ep';
        json(200, { session: { name: recording, startedAt: '2026-11-14T19:00:00Z', cameras: [{ id: 'a', name: 'Host' }, { id: 'b', name: 'Guest' }] }, errors: { b: 'Gerät belegt' } });
      }, fake.startDelay);
    }
    if (req.method === 'POST' && url === '/api/recording/stop') {
      if (!recording) return json(409, { error: 'keine Aufnahme aktiv' });
      recording = null;
      return json(200, {});
    }
    if (req.method === 'GET' && url === '/api/sessions/2026-11-14_1900_ep') {
      return json(200, {
        name: '2026-11-14_1900_ep',
        stoppedAt: '2026-11-14T20:00:00Z',
        cameras: [{ id: 'a', name: 'Host', files: Object.keys(fake.files), choice: { fourcc: 'H264' }, codec: 'copy', hasAudio: true }],
      });
    }
    const m = /^\/api\/sessions\/2026-11-14_1900_ep\/files\/(.+)$/.exec(url);
    if (req.method === 'GET' && m && fake.files[m[1]]) {
      const data = fake.files[m[1]];
      const r = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
      const from = r ? Number(r[1]) : 0;
      res.writeHead(r ? 206 : 200, { 'Content-Length': String(data.length - from) });
      return void res.end(data.subarray(from));
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 page not found\n');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise((r) => server.close(() => r()));
  return fake;
}

describe('talking to CamPod', () => {
  let fake: Fake;
  beforeEach(async () => (fake = await fakeCamPod()));
  afterEach(() => fake.close());

  it('sends the token and passes on CamPod’s errors', async () => {
    fake.token = 'tok';
    await expect(new CamPodClient(fake.url, 'wrong').stop()).rejects.toThrow(/access token/);
    const c = new CamPodClient(fake.url, 'tok');
    await expect(c.stop()).rejects.toThrow('CamPod: keine Aufnahme aktiv');
    const r = await c.start('Episode 12');
    expect(r).toEqual({ name: '2026-11-14_1900_ep', startedAt: '2026-11-14T19:00:00Z', failed: ['Guest: Gerät belegt'] });
    // an older CamPod without the download endpoint
    await expect(c.session('2026-01-01_0000')).rejects.toThrow(/Update CamPod/);
    await expect(new CamPodClient('http://127.0.0.1:1').status()).rejects.toThrow(/Can’t reach CamPod/);
  });

  const settings = () => ({ url: fake.url, token: '', followRecording: true });

  it('starts and stops the cameras with the recording', async () => {
    const events: CamPodEvent[] = [];
    const f = new CamPodFollower(settings, (e) => events.push(e));
    f.recordingStarted('Episode 12', 48000);
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'started')).toBe(true));
    expect(f.busy).toBe(true);
    f.recordingStopped();
    await f.settle();
    expect(fake.calls).toEqual(['POST /api/recording/start', 'POST /api/recording/stop']);
    expect(events).toEqual([
      { kind: 'started', name: '2026-11-14_1900_ep', failed: ['Guest: Gerät belegt'] },
      { kind: 'stopped', name: '2026-11-14_1900_ep' },
    ]);
    expect(f.takeLinks()).toEqual([{ name: '2026-11-14_1900_ep', start: 48000 }]);
    expect(f.takeLinks()).toEqual([]);
    expect(f.busy).toBe(false);
  });

  it('stops a recording that ended before CamPod answered', async () => {
    fake.startDelay = 150;
    const f = new CamPodFollower(settings, () => {});
    f.recordingStarted('Short', 0);
    f.recordingStopped();
    // the take is merged before the stop reached CamPod: still linked, once
    const early = f.takeLinks();
    await f.settle();
    expect(fake.calls).toEqual(['POST /api/recording/start', 'POST /api/recording/stop']);
    expect([...early, ...f.takeLinks()]).toEqual([{ name: '2026-11-14_1900_ep', start: 0 }]);
  });

  it('does nothing when switched off or not set up', () => {
    const f = new CamPodFollower(() => ({ ...settings(), followRecording: false }), () => {});
    f.recordingStarted('x', 0);
    const g = new CamPodFollower(() => ({ url: '', token: '', followRecording: true }), () => {});
    g.recordingStarted('x', 0);
    expect(f.busy || g.busy).toBe(false);
  });

  it('reports a failed start without touching the recording', async () => {
    const events: CamPodEvent[] = [];
    const f = new CamPodFollower(() => ({ url: 'http://127.0.0.1:1', token: '', followRecording: true }), (e) => events.push(e));
    f.recordingStarted('x', 0);
    await f.settle();
    expect(events[0]).toMatchObject({ kind: 'error' });
    expect((events[0] as { message: string }).message).toMatch(/did not start/);
  });

  it('downloads camera files into the episode, resuming and skipping finished ones', async () => {
    fake.files = { 'cam-host.mkv': Buffer.alloc(300_000, 7), 'cam-host_part2.mkv': Buffer.from('second part') };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavepod-campod-'));
    try {
      const folder = path.join(dir, 'video', '2026-11-14_1900_ep');
      fs.mkdirSync(folder, { recursive: true });
      // half of the first file from an interrupted download
      fs.writeFileSync(path.join(folder, 'cam-host.mkv.part'), fake.files['cam-host.mkv'].subarray(0, 100_000));
      const project = linkSession(createProject('Ep'), { name: '2026-11-14_1900_ep', start: 4800 });
      const progress: CamPodEvent[] = [];
      const d = new CamPodDownloader();
      const r = await d.download(settings(), project, dir, '2026-11-14_1900_ep', (e) => progress.push(e));
      expect(r.files).toEqual([
        { camera: 'Host (part 1)', path: 'video/2026-11-14_1900_ep/cam-host.mkv', start: 4800 },
        { camera: 'Host (part 2)', path: 'video/2026-11-14_1900_ep/cam-host_part2.mkv' },
      ]);
      expect(fs.readFileSync(path.join(folder, 'cam-host.mkv')).equals(fake.files['cam-host.mkv'])).toBe(true);
      expect(fs.readFileSync(path.join(folder, 'cam-host_part2.mkv'), 'utf8')).toBe('second part');
      expect(fs.existsSync(path.join(folder, 'cam-host.mkv.part'))).toBe(false);
      expect(fake.calls).toContain('GET /api/sessions/2026-11-14_1900_ep/files/cam-host.mkv bytes=100000-');
      expect(progress.at(-1)).toMatchObject({ kind: 'download', index: 1, count: 2, fraction: 1 });

      // a second import finds the files there and doesn't write them again
      const mtime = fs.statSync(path.join(folder, 'cam-host.mkv')).mtimeMs;
      await d.download(settings(), project, dir, '2026-11-14_1900_ep', () => {});
      expect(fs.statSync(path.join(folder, 'cam-host.mkv')).mtimeMs).toBe(mtime);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
