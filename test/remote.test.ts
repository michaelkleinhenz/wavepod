import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BYTES_PER_SAMPLE,
  PROTOCOL_VERSION,
  buildInviteLink,
  chunkAttributes,
  decodeMessage,
  encodeMessage,
  floatToPcm24,
  guestIdOf,
  guestIdentity,
  parseChunkAttributes,
  parseInviteLink,
  pcm24ToFloat,
} from '../src/shared/remoteProtocol';
import { RemoteInputBuffer, remoteInputSizes } from '../src/core/remoteInput';
import { addReceived, callClipsOf, contiguousUpTo, initialClip, isComplete, missingChunks, normalizeRemoteTakes, placeRemoteTake, type RemoteTake } from '../src/core/remoteTakes';
import { RoomService, apiBase, guestToken, hostToken, signToken, tokenClaims } from '../src/main/remote/liveKit';
import { RemoteInbox } from '../src/main/remote/inbox';
import { addTrack, createProject, normalizeProject } from '../src/core/project';
import { runSoundcheck } from '../src/core/soundcheck';
import { AudioEngine, VIRTUAL_API } from '../src/main/audio/engine';
import type { Project } from '../src/shared/types';
import { tmpDir } from './helpers';
import { createHmac } from 'node:crypto';

const creds = { url: 'wss://show.livekit.cloud', apiKey: 'APIkey', apiSecret: 'secret-secret-secret' };

describe('remote protocol', () => {
  it('round-trips control messages and drops other versions or junk', () => {
    const m = { v: PROTOCOL_VERSION, type: 'ack' as const, takeId: 't1', upTo: 4 };
    expect(decodeMessage(encodeMessage(m))).toEqual(m);
    expect(decodeMessage(encodeMessage({ ...m, v: 99 }))).toBeNull();
    expect(decodeMessage(new TextEncoder().encode('{nope'))).toBeNull();
  });

  it('packs 24-bit samples and clips what is out of range', () => {
    const x = new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2, 1e-6]);
    const pcm = floatToPcm24(x);
    expect(pcm.length).toBe(x.length * BYTES_PER_SAMPLE);
    const y = pcm24ToFloat(pcm);
    for (let i = 0; i < 5; i++) expect(y[i]).toBeCloseTo(x[i], 6);
    expect(y[5]).toBeCloseTo(1, 6);
    expect(y[6]).toBeCloseTo(-1, 6);
    expect(Math.abs(y[7] - 1e-6)).toBeLessThan(1 / 8388608);
  });

  it('carries chunk headers as attributes and refuses odd ones', () => {
    const h = { takeId: 'tabc-p2', seq: 3, sampleRate: 48000, frames: 48000 };
    expect(parseChunkAttributes(chunkAttributes(h))).toEqual(h);
    expect(parseChunkAttributes({ ...chunkAttributes(h), takeId: '../x' })).toBeNull();
    expect(parseChunkAttributes({ ...chunkAttributes(h), seq: '-1' })).toBeNull();
    expect(parseChunkAttributes(undefined)).toBeNull();
  });

  it('puts everything of an invite in the fragment', () => {
    const token = guestToken(creds, 'room1', 'g1', 'Alex');
    const link = buildInviteLink('https://example.org/join/v1/#old', { url: creds.url, token, episode: 'Folge 12 & mehr', name: 'Alex' });
    expect(link.startsWith('https://example.org/join/v1/#')).toBe(true);
    expect(link.split('?')).toHaveLength(1);
    expect(parseInviteLink(new URL(link).hash)).toEqual({ url: creds.url, token, episode: 'Folge 12 & mehr', name: 'Alex' });
    expect(parseInviteLink('#u=https://evil&t=a.b.c')).toBeNull();
    expect(parseInviteLink('#u=wss://x&t=nope')).toBeNull();
  });

  it('names guests so the host can tell them apart', () => {
    expect(guestIdOf(guestIdentity('abc'))).toBe('abc');
    expect(guestIdOf('host')).toBeNull();
  });
});

describe('LiveKit tokens', () => {
  it('signs HS256 tokens LiveKit accepts', () => {
    const t = signToken(creds, 'host', { room: 'r', roomJoin: true }, { now: 1_000_000, ttlSeconds: 60 });
    const [head, body, sig] = t.split('.');
    expect(JSON.parse(Buffer.from(head, 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(createHmac('sha256', creds.apiSecret).update(`${head}.${body}`).digest('base64url')).toBe(sig);
    const c = tokenClaims(t)!;
    expect(c).toMatchObject({ iss: 'APIkey', sub: 'host', nbf: 990, exp: 1060, video: { room: 'r', roomJoin: true } });
  });

  it('lets the host do everything and keeps guests in the waiting room', () => {
    const host = tokenClaims(hostToken(creds, 'r'))!.video as Record<string, unknown>;
    expect(host).toMatchObject({ room: 'r', roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
    const g = tokenClaims(guestToken(creds, 'r', 'g1', 'Alex'))!;
    expect(g.sub).toBe('guest-g1');
    expect(g.name).toBe('Alex');
    expect(g.video).toMatchObject({ room: 'r', roomJoin: true, canPublish: false, canSubscribe: false, canPublishData: false });
    expect((g.exp as number) - (g.nbf as number)).toBe(24 * 3600 + 10);
  });

  it('finds the API next to the WebSocket URL', () => {
    expect(apiBase('wss://show.livekit.cloud')).toBe('https://show.livekit.cloud');
    expect(apiBase('ws://127.0.0.1:7880/')).toBe('http://127.0.0.1:7880');
  });
});

describe('LiveKit room service', () => {
  const calls: Array<{ url: string; body: Record<string, unknown>; auth: string }> = [];
  const fake = (status = 200, text = '{}') =>
    new RoomService(creds, async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
      return { ok: status < 300, status, text: async () => text };
    });
  afterEach(() => (calls.length = 0));

  it('admits a guest with the microphone (and camera when video is on)', async () => {
    await fake().admit('r', 'guest-g1', false);
    expect(calls[0].url).toBe('https://show.livekit.cloud/twirp/livekit.RoomService/UpdateParticipant');
    expect(calls[0].body).toMatchObject({ room: 'r', identity: 'guest-g1', permission: { canPublish: true, canSubscribe: true, canPublishSources: ['MICROPHONE'] } });
    expect(tokenClaims(calls[0].auth.replace('Bearer ', ''))!.video).toMatchObject({ room: 'r', roomAdmin: true });
    await fake().admit('r', 'guest-g1', true);
    expect((calls[1].body.permission as { canPublishSources: string[] }).canPublishSources).toEqual(['MICROPHONE', 'CAMERA']);
  });

  it('closes the room when the session ends', async () => {
    await fake().deleteRoom('r');
    expect(calls[0].url).toBe('https://show.livekit.cloud/twirp/livekit.RoomService/DeleteRoom');
    expect(calls[0].body).toEqual({ room: 'r' });
  });

  it('holds a guest back but keeps their upload going', async () => {
    await fake().holdBack('r', 'guest-g1');
    expect(calls[0].body.permission).toEqual({ canSubscribe: false, canPublish: false, canPublishData: true });
  });

  it('counts rooms and explains failures', async () => {
    expect(await fake(200, '{"rooms":[{},{}]}').test()).toBe(2);
    await expect(fake(401, 'unauthorized').test()).rejects.toThrow(/API key or secret/);
    await expect(fake(404, '{"code":"not_found","msg":"room not found"}').remove('r', 'x')).rejects.toThrow('LiveKit: room not found');
    const down = new RoomService(creds, async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(down.test()).rejects.toThrow(/Could not reach the LiveKit server/);
  });
});

describe('remote input buffer', () => {
  it('waits for the jitter margin, then plays in order', () => {
    const b = new RemoteInputBuffer(100, 400);
    const out = new Float32Array(64);
    b.write(new Float32Array(60).fill(0.5));
    b.readInto(out, 64);
    expect(out.every((v) => v === 0)).toBe(true);
    b.write(Float32Array.from({ length: 60 }, (_, i) => i / 100));
    b.readInto(out, 64);
    expect(out[0]).toBe(0.5);
    expect(out[60]).toBeCloseTo(0, 6);
    expect(out[63]).toBeCloseTo(0.03, 6);
    expect(b.stats().buffered).toBe(56);
  });

  it('plays silence when dry and waits for the margin again', () => {
    const b = new RemoteInputBuffer(10, 100);
    b.write(new Float32Array(20).fill(1));
    const out = new Float32Array(30);
    b.readInto(out, 30);
    expect(out[19]).toBe(1);
    expect(out[20]).toBe(0);
    expect(b.stats().underruns).toBe(1);
    b.write(new Float32Array(5).fill(1));
    b.readInto(out, 5);
    expect(out[0]).toBe(0); // under the margin again
  });

  it('drops the oldest audio so the delay stays bounded', () => {
    const b = new RemoteInputBuffer(10, 50);
    b.write(Float32Array.from({ length: 80 }, (_, i) => i));
    expect(b.stats()).toMatchObject({ buffered: 50, dropped: 30 });
    const out = new Float32Array(50);
    b.readInto(out, 50);
    expect(out[0]).toBe(30);
    expect(out[49]).toBe(79);
  });

  it('sizes the margin from the device buffer', () => {
    const s = remoteInputSizes(48000, 512);
    expect(s.target).toBe(1920);
    expect(s.max).toBeGreaterThan(s.target);
    expect(remoteInputSizes(48000, 2048).target).toBe(4096);
  });
});

function take(over: Partial<RemoteTake> = {}): RemoteTake {
  return {
    guestId: 'g1',
    trackId: 't1',
    takeId: 'tx',
    file: 'media/Alex-remote-tx.wav',
    sampleRate: 48000,
    recordStart: 480000,
    preRoll: 96000,
    received: [],
    chunks: null,
    frames: null,
    rttMs: 100,
    state: 'recording',
    ...over,
  };
}

describe('remote takes', () => {
  it('tracks which chunks are there and what is missing', () => {
    let r: number[] = [];
    for (const s of [0, 1, 3, 1, 5]) r = addReceived(r, s);
    expect(r).toEqual([0, 1, 3, 5]);
    expect(contiguousUpTo(r)).toBe(1);
    expect(contiguousUpTo([])).toBe(-1);
    expect(missingChunks({ received: r, chunks: null })).toEqual([2, 4]);
    expect(missingChunks({ received: r, chunks: 8 })).toEqual([2, 4, 6, 7]);
    expect(isComplete({ received: r, chunks: 8 })).toBe(false);
    expect(isComplete({ received: [0, 1, 2], chunks: 3 })).toBe(true);
    expect(isComplete({ received: [0, 1, 2], chunks: null })).toBe(false);
  });

  it('places the recording at the take start, pre-roll kept as a handle', () => {
    const c = initialClip(take({ frames: 20 * 48000 }), 48000);
    // the file starts one round trip (4800 frames) late, minus the pre-roll
    expect(c.start).toBe(480000);
    expect(c.offset).toBe(96000 - 4800);
    expect(c.length).toBe(20 * 48000 - c.offset);
  });

  it('turns the call audio into an earlier take', () => {
    let p = createProject('S', 48000);
    p = addTrack(p, { name: 'Alex', inputChannels: [] });
    const id = p.tracks[0].id;
    p.tracks[0].remote = { guestId: 'g1' };
    p.tracks[0].clips = [{ id: 'call', file: 'media/Alex-1.wav', start: 480000, offset: 0, length: 960000, gain: 0, fadeIn: 0, fadeOut: 0 }];
    const placed = placeRemoteTake(p, take({ trackId: id, frames: 20 * 48000 }))!;
    const t = placed.project.tracks[0];
    expect(t.takes?.map((tk) => tk.clips[0].file)).toEqual(['media/Alex-1.wav', 'media/Alex-remote-tx.wav']);
    expect(t.clips.some((c) => c.file === 'media/Alex-remote-tx.wav')).toBe(true);
    // the call audio is found again for lining up, in its take lane, and the raw file isn't
    const ref = callClipsOf(placed.project, id, 400000, 1500000);
    expect(ref.length).toBeGreaterThan(0);
    expect(ref.every((c) => c.file === 'media/Alex-1.wav')).toBe(true);
    expect(placeRemoteTake(p, take({ trackId: 'gone' }))).toBeNull();
  });

  it('picks the one call recording that covers the stretch', () => {
    let p = createProject('S', 48000);
    p = addTrack(p, { name: 'Alex', inputChannels: [] });
    const clip = (id: string, file: string, start: number, length: number) => ({ id, file, start, offset: start, length, gain: 0, fadeIn: 0, fadeOut: 0 });
    p.tracks[0].clips = [clip('a', 'media/old.wav', 0, 1000), clip('b', 'media/new.wav', 500, 5000), clip('c', 'media/new.wav', 6000, 1000)];
    expect(callClipsOf(p, p.tracks[0].id, 400, 7000).map((c) => c.id)).toEqual(['b', 'c']);
  });

  it('reads the take list leniently', () => {
    const list = normalizeRemoteTakes({
      takes: [take({ received: [2, 1, 1, -1] as number[] }), { ...take(), file: '../../etc/passwd' }, { ...take(), takeId: 'a b' }, null],
    });
    expect(list).toHaveLength(1);
    expect(list[0].received).toEqual([1, 2]);
    expect(normalizeRemoteTakes('junk')).toEqual([]);
  });
});

describe('remote inbox', () => {
  const pcm = (seq: number, frames = 48000) => floatToPcm24(new Float32Array(frames).fill((seq + 1) / 10));

  it('writes chunks where they belong, in any order, and completes the file', async () => {
    const dir = tmpDir();
    const inbox = new RemoteInbox(dir);
    const t = inbox.begin({ guestId: 'g1', trackId: 't1', trackName: 'Alex B.', takeId: 'tx', sampleRate: 48000, recordStart: 0, preRoll: 0, rttMs: 10 });
    expect(t.file).toBe('media/Alex_B.-remote-tx.wav');
    const h = (seq: number, frames = 48000) => ({ takeId: 'tx', seq, sampleRate: 48000, frames });
    await inbox.chunk('g1', h(2, 1000), pcm(2, 1000));
    await inbox.chunk('g1', h(0), pcm(0));
    expect(inbox.ackOf(inbox.get('g1', 'tx')!)).toBe(0);
    // wrong size, unknown take, other rate: ignored
    expect(await inbox.chunk('g1', h(1), pcm(1, 10))).toBeNull();
    expect(await inbox.chunk('g1', { ...h(1), takeId: 'other' }, pcm(1))).toBeNull();
    expect(await inbox.chunk('g1', { ...h(1), sampleRate: 44100 }, pcm(1))).toBeNull();
    const done = inbox.finished('g1', 'tx', 3, 2 * 48000 + 1000)!;
    expect(inbox.missing(done)).toEqual([1]);
    expect(await inbox.complete(done)).toBe(false);
    // past the end of the finished take
    expect(await inbox.chunk('g1', h(3), pcm(3))).toBeNull();
    await inbox.chunk('g1', h(1), pcm(1));
    expect(await inbox.complete(inbox.get('g1', 'tx')!)).toBe(true);
    await inbox.close();

    const bytes = fs.readFileSync(path.join(dir, t.file));
    expect(bytes.readUInt32LE(40)).toBe((2 * 48000 + 1000) * 3);
    expect(bytes.length).toBe(44 + (2 * 48000 + 1000) * 3);
    const audio = pcm24ToFloat(bytes.subarray(44));
    expect(audio[10]).toBeCloseTo(0.1, 5);
    expect(audio[48000 + 10]).toBeCloseTo(0.2, 5);
    expect(audio[2 * 48000 + 10]).toBeCloseTo(0.3, 5);

    // the state survives a restart
    const again = new RemoteInbox(dir);
    expect(again.get('g1', 'tx')).toMatchObject({ state: 'complete', chunks: 3, received: [0, 1, 2] });
  });
});

describe('remote guests in the project', () => {
  it('keeps the guest id and never gives a remote track a device input', () => {
    const p = normalizeProject({
      name: 'X',
      remoteRoom: 'wp-room',
      tracks: [
        { name: 'Alex', inputChannels: [3], remote: { guestId: 'g1' }, clips: [] },
        { name: 'Bad', remote: { guestId: '../x' }, clips: [] },
      ],
    } as never);
    expect(p.remoteRoom).toBe('wp-room');
    expect(p.tracks[0].remote).toEqual({ guestId: 'g1' });
    expect(p.tracks[0].inputChannels).toEqual([]);
    expect(p.tracks[1].remote).toBeUndefined();
    expect(normalizeProject({ name: 'X', remoteRoom: 'a b', tracks: [] } as never).remoteRoom).toBeUndefined();
  });

  it('counts an armed guest track as something to record', () => {
    let p: Project = createProject('S', 48000);
    p = addTrack(p, { name: 'Alex', inputChannels: [], armed: true });
    p.tracks[0].remote = { guestId: 'g1' };
    const issues = runSoundcheck({ project: p, deviceSampleRate: 48000, inputOpen: true, inputDeviceName: 'X', freeBytes: 500e9, position: 0 });
    expect(issues.map((i) => i.id)).not.toContain('no-armed');
  });
});

describe('AudioEngine remote inputs', () => {
  let engine: AudioEngine;
  afterEach(() => engine?.dispose());

  it('gives each guest an input after the device, monitors them and feeds the others', () => {
    engine = new AudioEngine(null);
    engine.applyConfig({ api: VIRTUAL_API, inputDeviceId: 1, outputDeviceId: 2, sampleRate: 48000, bufferSize: 480, outputFirstChannel: 0 });
    let p = createProject('S', 48000);
    p = addTrack(p, { name: 'Host', inputChannels: [0], armed: true });
    p = addTrack(p, { name: 'Alex', inputChannels: [], armed: true });
    p.tracks[1].remote = { guestId: 'g1' };
    engine.setProject(p, tmpDir());
    const e = engine as unknown as { onInput(b: Float32Array): void; onOutput(n: number, nch: number): Float32Array; input: { channels: number } };
    const nch = e.input.channels;
    const guest = p.tracks[1].id;
    expect(engine.remoteChannels()).toEqual({ [guest]: nch });

    const feed: Float32Array[] = [];
    engine.on('remoteFeed', (s: Float32Array) => feed.push(s));
    engine.setRemoteSession(true);
    // the guest says 0.25, the host 0.1
    let out: Float32Array = new Float32Array(0);
    for (let k = 0; k < 10; k++) {
      engine.remoteAudio(guest, new Float32Array(480).fill(0.25));
      const buf = new Float32Array(480 * nch);
      for (let i = 0; i < 480; i++) buf[i * nch] = 0.1;
      e.onInput(buf);
      out = e.onOutput(480, 2);
    }
    // the host hears the guest on the main pair (centre pan: full on both sides)
    expect(out[200 * 2]).toBeCloseTo(0.25, 3);
    // the guest gets the host, not themselves
    const last = feed[feed.length - 1];
    expect(last.length).toBeGreaterThan(0);
    expect(last[last.length - 1]).toBeCloseTo(0.1, 3);
    expect(engine.remoteStats(guest)!.buffered).toBeGreaterThanOrEqual(0);
  });
});

describe('camera choice', () => {
  it('lists cameras by name, numbers unnamed ones, and waits for permission', async () => {
    const { cameraChoices } = await import('../src/shared/cameras');
    const dev = (kind: string, deviceId: string, label = '') => ({ kind: kind as MediaDeviceKind, deviceId, label });
    expect(cameraChoices([dev('audioinput', 'a', 'Mic'), dev('videoinput', 'c1', 'FaceTime HD'), dev('videoinput', 'c2')])).toEqual([
      { id: 'c1', label: 'FaceTime HD' },
      { id: 'c2', label: 'Camera 2' },
    ]);
    // before the page may use a camera, browsers show one nameless entry
    expect(cameraChoices([dev('videoinput', '')])).toEqual([]);
  });
});

describe('guest page address', () => {
  it('invites to wavepod.de and moves old saved defaults along', async () => {
    const { DEFAULT_GUEST_PAGE, normalizeRemoteSettings, updateRemoteSettings } = await import('../src/main/remote/host');
    expect(DEFAULT_GUEST_PAGE).toBe('https://wavepod.de/join/v1/');
    expect(normalizeRemoteSettings({ guestPageUrl: 'https://michaelkleinhenz.github.io/wavepod/join/v1/' }).guestPageUrl).toBe('');
    const s = normalizeRemoteSettings({});
    expect(updateRemoteSettings(s, { guestPageUrl: 'https://wavepod.de/join/v1' }).guestPageUrl).toBe('');
    expect(updateRemoteSettings(s, { guestPageUrl: 'https://example.org/join/' }).guestPageUrl).toBe('https://example.org/join/');
  });
});
