// Remote guests, main-process side: settings and tokens, the audio and message bridge to the
// window (which holds the LiveKit connection), and the takes guests upload.
//
//  - Call audio: window → `audio` → engine (a remote input channel per guest track); the engine's
//    guest feed (`remoteFeed` event) → window → published to the room.
//  - Recording: when the host records, every guest gets `rec-start`; their raw chunks arrive as
//    `chunk` and go into the inbox (one WAV per guest and take). Once a take is complete it goes on
//    the guest's track as a new take and is aligned to the call audio of the same take.
import { MessageChannelMain, type MessagePortMain, type WebContents } from 'electron';
import type { AudioEngine } from '../audio/engine';
import type { Clip, Project, RemoteInfo, RemoteSessionInfo, RemoteSettingsInput, RemoteTakeInfo, TransportUpdate } from '../../shared/types';
import { PROTOCOL_VERSION, guestIdOf, guestIdentity, type GuestMessage, type HostMessage } from '../../shared/remoteProtocol';
import { REMOTE_PORT_CHANNEL, type ToMain, type ToWindow } from '../../shared/remoteBridge';
import { RoomService, guestToken, hostToken, newGuestId, newRoomName, type LiveKitCredentials } from './liveKit';
import { buildInviteLink } from '../../shared/remoteProtocol';
import { RemoteInbox } from './inbox';
import { callClipsOf, initialClip, missingChunks, placeRemoteTake, type RemoteTake } from '../../core/remoteTakes';
import { addTrack } from '../../core/project';
import { applyAlignment, type AlignResult } from '../../core/alignEdit';
import { decodeKey, encodeKey } from '../auphonic';

export const DEFAULT_GUEST_PAGE = 'https://wavepod.de/join/v1/';
/** Where the page was before wavepod.de: a setting that still says so follows the default. */
const OLD_GUEST_PAGES = ['https://michaelkleinhenz.github.io/wavepod/join/v1/'];

/** '' for the project's own page (so it follows the default), else the address as typed. */
function ownPage(url: string): string {
  const u = url.trim();
  const same = (a: string) => a.replace(/\/+$/, '') === u.replace(/\/+$/, '');
  return same(DEFAULT_GUEST_PAGE) || OLD_GUEST_PAGES.some(same) ? '' : u;
}
/** Below this the alignment is not trusted and the take keeps its estimated place. */
const MIN_ALIGN_CONFIDENCE = 0.4;
const PING_MS = 2000;
/** Round trips kept per guest; the lowest ones count (queueing only ever adds delay). */
const RTT_SAMPLES = 15;

/** As stored in the app settings. */
export interface StoredRemote {
  url: string;
  apiKey: string;
  /** "enc:<base64>" or plain, like the other API keys. */
  secret: string;
  guestPageUrl: string;
  video: boolean;
}

export function normalizeRemoteSettings(raw: unknown): StoredRemote {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<StoredRemote>;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  return {
    url: str(r.url),
    apiKey: str(r.apiKey),
    secret: str(r.secret),
    guestPageUrl: ownPage(str(r.guestPageUrl)),
    video: r.video === true,
  };
}

export function updateRemoteSettings(s: StoredRemote, input: RemoteSettingsInput): StoredRemote {
  const url = input.url === undefined ? s.url : input.url.trim();
  if (url && !/^wss?:\/\/[^\s/]+/.test(url)) throw new Error('The LiveKit URL starts with wss:// (for example wss://my-project.livekit.cloud).');
  const page = input.guestPageUrl === undefined ? s.guestPageUrl : input.guestPageUrl.trim();
  if (page && !/^https?:\/\//.test(page)) throw new Error('The guest page address starts with https://.');
  return {
    url,
    apiKey: input.apiKey === undefined ? s.apiKey : input.apiKey.trim(),
    secret: input.apiSecret === undefined ? s.secret : encodeKey(input.apiSecret.trim()),
    guestPageUrl: ownPage(page),
    video: input.video ?? s.video,
  };
}

const env = () => ({ url: process.env.LIVEKIT_URL ?? '', apiKey: process.env.LIVEKIT_API_KEY ?? '', apiSecret: process.env.LIVEKIT_API_SECRET ?? '' });

/** The credentials in use: the settings, or the environment when the settings have none. */
export function remoteCredentials(s: StoredRemote): (LiveKitCredentials & { fromEnvironment: boolean }) | null {
  const secret = decodeKey(s.secret);
  if (s.url && s.apiKey && secret) return { url: s.url, apiKey: s.apiKey, apiSecret: secret, fromEnvironment: false };
  const e = env();
  if (!s.url && !s.apiKey && e.url && e.apiKey && e.apiSecret) return { ...e, fromEnvironment: true };
  return null;
}

export function remoteInfo(s: StoredRemote): RemoteInfo {
  const c = remoteCredentials(s);
  return {
    url: c?.fromEnvironment ? c.url : s.url,
    apiKey: c?.fromEnvironment ? c.apiKey : s.apiKey,
    hasSecret: !!c?.apiSecret || !!decodeKey(s.secret),
    guestPageUrl: s.guestPageUrl || DEFAULT_GUEST_PAGE,
    video: s.video,
    fromEnvironment: !!c?.fromEnvironment,
  };
}

/** What the remote host needs from the rest of the app. */
export interface RemoteHostDeps {
  engine: AudioEngine;
  settings: () => StoredRemote;
  project: () => Project;
  dir: () => string;
  /** Applies an edit the window turns into an undo step. */
  apply: (project: Project, summary: string) => void;
  /** Aligns clips to reference clips in a worker, with drift-corrected copies. */
  align: (clipIds: string[], refClips: Clip[], project: Project) => Promise<AlignResult & { files: Record<string, string> }>;
  window: () => WebContents | null;
}

interface Guest {
  rtts: number[];
}

export class RemoteHost {
  private port: MessagePortMain | null = null;
  private inbox: RemoteInbox | null = null;
  private inboxDir = '';
  private guests = new Map<string, Guest>();
  /** The take being recorded now (host side). */
  private take: { takeId: string; recordStart: number } | null = null;
  /** Recent takes: id → where they started, for guests whose `rec-started` comes in late. */
  private takeStarts = new Map<string, number>();
  private pings = new Map<number, number>();
  private pingId = 0;
  private pingTimer: NodeJS.Timeout | null = null;
  private lastState: TransportUpdate['state'] = 'stopped';
  private placing = new Set<string>();

  constructor(private deps: RemoteHostDeps) {
    deps.engine.on('remoteFeed', (samples: Float32Array) => this.post({ type: 'feed', samples }));
    deps.engine.on('transport', (u: TransportUpdate) => this.onTransport(u));
  }

  get active(): boolean {
    return !!this.port;
  }

  private creds(): LiveKitCredentials {
    const c = remoteCredentials(this.deps.settings());
    if (!c) throw new Error('Set up remote guests first: Edit › Settings › Remote guests (LiveKit URL, API key and secret).');
    return c;
  }

  async test(): Promise<number> {
    return new RoomService(this.creds()).test();
  }

  /** Starts the episode's session: makes the room name if needed and hands the window a port and a token. */
  start(): RemoteSessionInfo {
    const creds = this.creds();
    let project = this.deps.project();
    if (!project.remoteRoom) {
      project = { ...project, remoteRoom: newRoomName() };
      this.deps.apply(project, 'Remote session');
    }
    this.openInbox();
    if (!this.port) {
      const { port1, port2 } = new MessageChannelMain();
      this.port = port1;
      port1.on('message', (e) => this.onMessage(e.data as ToMain));
      port1.start();
      const wc = this.deps.window();
      if (!wc) throw new Error('No window');
      wc.postMessage(REMOTE_PORT_CHANNEL, null, [port2]);
      this.deps.engine.setRemoteSession(true);
      this.pingTimer = setInterval(() => this.ping(), PING_MS);
      this.pingTimer.unref?.();
    }
    this.sendTakes();
    return { url: creds.url, token: hostToken(creds, project.remoteRoom!), room: project.remoteRoom!, video: this.deps.settings().video };
  }

  /** Ends the session; with `closeRoom`, guests still in the room are sent away too. */
  async stop(closeRoom = false): Promise<void> {
    const room = this.deps.project().remoteRoom;
    if (closeRoom && room && this.port) {
      try {
        await new RoomService(this.creds()).deleteRoom(room);
      } catch (e) {
        console.error(`[remote] could not close the room: ${(e as Error).message}`);
      }
    }
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.port?.close();
    this.port = null;
    this.deps.engine.setRemoteSession(false);
    this.guests.clear();
  }

  /** The episode changed (opened another one): drop the session and the inbox of the old one. */
  projectChanged(): void {
    if (this.inboxDir && this.inboxDir !== this.deps.dir()) {
      void this.stop();
      void this.inbox?.close();
      this.inbox = null;
      this.inboxDir = '';
    }
  }

  private openInbox(): RemoteInbox {
    const dir = this.deps.dir();
    if (!this.inbox || this.inboxDir !== dir) {
      void this.inbox?.close();
      this.inbox = new RemoteInbox(dir);
      this.inboxDir = dir;
    }
    return this.inbox;
  }

  /** Adds a remote guest: a new armed track and its invite link. */
  invite(name: string): { trackId: string; link: string } {
    const clean = name.trim().slice(0, 60) || 'Guest';
    const guestId = newGuestId();
    const before = this.deps.project();
    const project = addTrack(before, { name: clean, armed: true, remote: { guestId } });
    const trackId = project.tracks[project.tracks.length - 1].id;
    this.deps.apply(project, `Invite ${clean}`);
    return { trackId, link: this.link(trackId) };
  }

  /** A fresh invite link for a remote track (tokens expire after a day). */
  link(trackId: string): string {
    const creds = this.creds();
    const project = this.deps.project();
    const t = project.tracks.find((x) => x.id === trackId);
    if (!t?.remote) throw new Error('That track is not a remote guest.');
    let room = project.remoteRoom;
    if (!room) {
      room = newRoomName();
      this.deps.apply({ ...project, remoteRoom: room }, 'Remote session');
    }
    const token = guestToken(creds, room, t.remote.guestId, t.name);
    const s = this.deps.settings();
    return buildInviteLink(s.guestPageUrl || DEFAULT_GUEST_PAGE, { url: creds.url, token, episode: project.name, name: t.name });
  }

  async admit(identity: string): Promise<void> {
    const room = this.deps.project().remoteRoom;
    if (!room) throw new Error('No remote session');
    await new RoomService(this.creds()).admit(room, identity, this.deps.settings().video);
  }

  async holdBack(identity: string): Promise<void> {
    const room = this.deps.project().remoteRoom;
    if (room) await new RoomService(this.creds()).holdBack(room, identity);
  }

  async remove(identity: string): Promise<void> {
    const room = this.deps.project().remoteRoom;
    if (room) await new RoomService(this.creds()).remove(room, identity);
  }

  takes(): RemoteTakeInfo[] {
    return (this.inbox?.list() ?? []).map((t) => ({
      guestId: t.guestId,
      trackId: t.trackId,
      takeId: t.takeId,
      state: t.state,
      received: t.received.length,
      chunks: t.chunks,
      missing: missingChunks(t).length,
      ...(t.note ? { note: t.note } : {}),
    }));
  }

  // ------------------------------------------------------------ bridge

  private post(m: ToWindow): void {
    try {
      this.port?.postMessage(m);
    } catch {
      /* window gone */
    }
  }

  private send(identity: string | null, msg: HostMessage): void {
    this.post({ type: 'send', identity, msg });
  }

  private sendTakes(): void {
    this.post({ type: 'takes', takes: this.takes() });
  }

  private hello(): HostMessage {
    const p = this.deps.project();
    return { v: PROTOCOL_VERSION, type: 'hello', episode: p.name, sampleRate: p.sampleRate, recording: this.take ? { takeId: this.take.takeId } : null, video: this.deps.settings().video };
  }

  private onMessage(m: ToMain): void {
    switch (m.type) {
      case 'audio': {
        const t = this.deps.project().tracks.find((x) => x.id === m.trackId);
        if (t?.remote) this.deps.engine.remoteAudio(m.trackId, m.samples);
        return;
      }
      case 'admitted':
        this.guests.set(m.identity, this.guests.get(m.identity) ?? { rtts: [] });
        this.send(m.identity, this.hello());
        // a take already running: this guest records from now on
        if (this.take) this.send(m.identity, { v: PROTOCOL_VERSION, type: 'rec-start', takeId: this.take.takeId });
        return;
      case 'left':
        this.guests.delete(m.identity);
        return;
      case 'guest':
        this.onGuest(m.identity, m.msg);
        return;
      case 'chunk':
        void this.onChunk(m.identity, m);
        return;
    }
  }

  private onGuest(identity: string, msg: GuestMessage): void {
    const guestId = guestIdOf(identity);
    if (!guestId) return;
    const inbox = this.openInbox();
    switch (msg.type) {
      case 'hello':
        // the guest's page is ready (after being let in, or after a reload): what is going on
        this.guests.set(identity, this.guests.get(identity) ?? { rtts: [] });
        this.send(identity, this.hello());
        if (this.take) this.send(identity, { v: PROTOCOL_VERSION, type: 'rec-start', takeId: this.take.takeId });
        return;
      case 'pong': {
        const sent = this.pings.get(msg.id);
        if (sent === undefined) return;
        const g = this.guests.get(identity) ?? { rtts: [] };
        g.rtts = [...g.rtts, performance.now() - sent].slice(-RTT_SAMPLES);
        this.guests.set(identity, g);
        this.post({ type: 'rtt', identity, rttMs: this.rtt(identity) ?? 0 });
        return;
      }
      case 'rec-started': {
        const track = this.deps.project().tracks.find((t) => t.remote?.guestId === guestId);
        const recordStart = this.takeStarts.get(msg.takeId) ?? this.partStart(identity, msg.takeId);
        if (!track || recordStart === undefined) return;
        const rate = this.deps.project().sampleRate;
        if (msg.sampleRate !== rate) {
          this.send(identity, { v: PROTOCOL_VERSION, type: 'rec-stop', takeId: msg.takeId });
          console.error(`[remote] ${track.name} records at ${msg.sampleRate} Hz, the episode at ${rate} Hz; raw recording skipped`);
          return;
        }
        inbox.begin({
          guestId,
          trackId: track.id,
          trackName: track.name,
          takeId: msg.takeId,
          sampleRate: msg.sampleRate,
          recordStart,
          preRoll: Math.max(0, Math.round(msg.preRoll)),
          rttMs: this.rtt(identity),
        });
        this.sendTakes();
        return;
      }
      case 'rec-finished': {
        const take = inbox.finished(guestId, msg.takeId, msg.chunks, msg.frames);
        if (take) void this.checkComplete(identity, take);
        return;
      }
      case 'inventory':
        for (const it of msg.takes) {
          const take = inbox.get(guestId, it.takeId);
          if (!take) continue;
          if (take.state === 'complete' || take.state === 'placed') {
            this.send(identity, { v: PROTOCOL_VERSION, type: 'take-complete', takeId: take.takeId });
            continue;
          }
          if (it.frames !== null) inbox.finished(guestId, it.takeId, it.chunks, it.frames);
          void this.checkComplete(identity, take);
        }
        return;
      default:
        return;
    }
  }

  private async onChunk(identity: string, m: Extract<ToMain, { type: 'chunk' }>): Promise<void> {
    const guestId = guestIdOf(identity);
    if (!guestId || !this.inbox) return;
    const take = await this.inbox.chunk(guestId, m.header, m.pcm);
    if (!take) return;
    this.send(identity, { v: PROTOCOL_VERSION, type: 'ack', takeId: take.takeId, upTo: this.inbox.ackOf(take) });
    if (take.chunks !== null) await this.checkComplete(identity, take);
    else if (m.header.seq % 5 === 0) this.sendTakes();
  }

  /** Completes and places a finished take, or asks for what is missing. */
  private async checkComplete(identity: string, take: RemoteTake): Promise<void> {
    const inbox = this.inbox;
    if (!inbox || take.chunks === null) return;
    if (take.state === 'complete' || take.state === 'placed') {
      this.send(identity, { v: PROTOCOL_VERSION, type: 'take-complete', takeId: take.takeId });
      return;
    }
    const missing = inbox.missing(take);
    if (missing.length) {
      // ask again only for chunks that should have arrived by now
      this.send(identity, { v: PROTOCOL_VERSION, type: 'resend', takeId: take.takeId, seqs: missing.slice(0, 120) });
      this.sendTakes();
      return;
    }
    if (!(await inbox.complete(take))) return;
    this.send(identity, { v: PROTOCOL_VERSION, type: 'take-complete', takeId: take.takeId });
    this.sendTakes();
    await this.place(take);
  }

  /** Puts a complete take on the timeline and lines it up with the call audio. */
  private async place(take: RemoteTake): Promise<void> {
    const key = `${take.guestId}/${take.takeId}`;
    if (this.placing.has(key) || take.state === 'placed' || !this.inbox) return;
    if (this.deps.engine.transportState === 'recording') {
      // the timeline can't change under a running take: try again when it stops
      return;
    }
    this.placing.add(key);
    try {
      const before = this.deps.project();
      const track = before.tracks.find((t) => t.id === take.trackId);
      if (!track) {
        this.inbox.update(take, { state: 'placed', note: 'The guest track is gone; the file is in the media folder.' });
        return;
      }
      let clip = initialClip(take, before.sampleRate);
      const margin = 2 * before.sampleRate;
      const refClips = callClipsOf(before, take.trackId, clip.start - margin, clip.start + clip.length + margin);
      let note = 'Placed by timing (no call audio to line up with).';
      if (clip.length > 0 && refClips.length) {
        // line it up before it goes on the timeline, so the take lane holds the lined-up clip too
        const scratch: Project = { ...before, tracks: before.tracks.map((t) => (t.id === take.trackId ? { ...t, clips: [...t.clips, clip] } : t)) };
        try {
          const r = await this.deps.align([clip.id], refClips, scratch);
          if (r.confidence >= MIN_ALIGN_CONFIDENCE && r.windows > 0) {
            const moved = applyAlignment(scratch, [clip.id], r, r.files)
              .tracks.find((t) => t.id === take.trackId)
              ?.clips.find((c) => c.id === clip.id);
            if (moved) clip = moved;
            const ms = Math.round((r.shift / before.sampleRate) * 1000);
            note = `Lined up with the call audio (moved ${ms} ms${r.drift ? `, clock drift ${Math.round(r.drift * 1e6)} ppm fixed` : ''}).`;
          } else note = 'Could not line up with the call audio; placed by timing. Check it by ear.';
        } catch (e) {
          note = `Placed by timing; lining up failed: ${(e as Error).message}`;
        }
      }
      // a new recording may have started while lining up: place it when that one stops
      if ((this.deps.engine.transportState as string) === 'recording') return;
      const placed = placeRemoteTake(this.deps.project(), take, clip);
      if (!placed) {
        this.inbox.update(take, { state: 'placed', note: 'The guest’s recording was empty.' });
        return;
      }
      this.deps.apply(placed.project, `${track.name}: local recording`);
      this.inbox.update(take, { state: 'placed', clipId: placed.clip.id, note });
    } finally {
      this.placing.delete(key);
      this.sendTakes();
    }
  }

  // ------------------------------------------------------------ transport and clock

  private onTransport(u: TransportUpdate): void {
    const was = this.lastState;
    this.lastState = u.state;
    if (u.state === 'recording' && was !== 'recording') {
      const takeId = `t${Date.now().toString(36)}`;
      const recordStart = u.position - u.recordedFrames;
      this.take = { takeId, recordStart };
      this.takeStarts.set(takeId, recordStart);
      if (this.port) this.send(null, { v: PROTOCOL_VERSION, type: 'rec-start', takeId });
    } else if (u.state !== 'recording' && was === 'recording' && this.take) {
      if (this.port) this.send(null, { v: PROTOCOL_VERSION, type: 'rec-stop', takeId: this.take.takeId });
      this.take = null;
      // takes that finished uploading during the recording go on the timeline now
      setTimeout(() => {
        for (const t of this.inbox?.list() ?? []) {
          const live = this.inbox?.get(t.guestId, t.takeId);
          if (live?.state === 'complete') void this.place(live);
        }
      }, 0);
    }
  }

  /**
   * Where a later part of the running take starts: the guest reopened the page mid-take and records
   * the rest as `<take>-p2`. Estimated from now, minus the time the message took; lining up with
   * the call audio fixes it.
   */
  private partStart(identity: string, takeId: string): number | undefined {
    const [base] = takeId.split('-p');
    if (base === takeId || this.take?.takeId !== base) return undefined;
    const rate = this.deps.project().sampleRate;
    const rtt = (this.rtt(identity) ?? 0) / 1000;
    // initialClip adds one round trip for the rec-start message; this part had none
    const start = Math.max(0, Math.round(this.deps.engine.position - 1.5 * rtt * rate));
    this.takeStarts.set(takeId, start);
    return start;
  }

  private ping(): void {
    if (!this.port) return;
    const id = ++this.pingId;
    this.pings.set(id, performance.now());
    if (this.pings.size > 20) this.pings.delete(Math.min(...this.pings.keys()));
    this.send(null, { v: PROTOCOL_VERSION, type: 'ping', id });
  }

  /** A guest's round trip: the lower quarter of the recent ones (queueing only adds). */
  rtt(identity: string): number | null {
    const r = [...(this.guests.get(identity)?.rtts ?? [])].sort((a, b) => a - b);
    if (!r.length) return null;
    const low = r.slice(0, Math.max(1, Math.ceil(r.length / 4)));
    return low.reduce((s, v) => s + v, 0) / low.length;
  }
}

export { guestIdentity };
