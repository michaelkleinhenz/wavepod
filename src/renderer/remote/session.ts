// Remote guests, window side: the host's LiveKit connection. The window only carries audio and
// messages between the room and the main process; the main process does the mixing, recording and
// file writing. Guests arrive in a waiting room and are let in from the guest list.
import { ConnectionQuality, Room, RoomEvent, Track, VideoPresets, type Participant, type RemoteParticipant, type RemoteTrack } from 'livekit-client';
import { HOST_IDENTITY, TOPIC_CHUNK, TOPIC_CONTROL, decodeMessage, encodeMessage, guestIdOf, parseChunkAttributes, type GuestMessage } from '../../shared/remoteProtocol';
import { REMOTE_PORT_MESSAGE, type ToMain, type ToWindow } from '../../shared/remoteBridge';
import type { RemoteTakeInfo } from '../../shared/types';
import { api, store } from '../store';
import { listCameras, saveCamera, savedCamera, type CameraChoice } from '../../shared/cameras';

export type GuestStatus = 'waiting' | 'live';

export interface GuestState {
  identity: string;
  guestId: string;
  name: string;
  status: GuestStatus;
  speaking: boolean;
  quality: 'excellent' | 'good' | 'poor' | 'lost' | 'unknown';
  rttMs: number | null;
  /** Upload backlog the guest reports (chunks = seconds). */
  behind: number;
  storage: 'ok' | 'none' | 'full';
  problem: string | null;
  video: HTMLVideoElement | null;
}

type Listener = () => void;

/** Frames per audio block sent to the main process (10 ms at 48 kHz). */
const BRIDGE_BLOCK = 480;

class RemoteSession {
  private room: Room | null = null;
  private port: MessagePort | null = null;
  private ctx: AudioContext | null = null;
  private feedNode: AudioWorkletNode | null = null;
  private sinks = new Map<string, { node: AudioWorkletNode; source: MediaStreamAudioSourceNode; el: HTMLMediaElement }>();
  private listeners = new Set<Listener>();
  /** Guests let in during this session: let in again at once when they reconnect. */
  private admitted = new Set<string>();
  guests = new Map<string, GuestState>();
  takes: RemoteTakeInfo[] = [];
  connecting = false;
  error: string | null = null;
  video = false;
  cameraOn = false;
  localVideo: HTMLVideoElement | null = null;
  /** Cameras to choose from, and the one the host picked ('' = the system's default). */
  cameras: CameraChoice[] = [];
  cameraId = '';

  constructor() {
    window.addEventListener('message', (e) => {
      if (e.data === REMOTE_PORT_MESSAGE && e.ports[0]) this.attachPort(e.ports[0]);
    });
    navigator.mediaDevices?.addEventListener?.('devicechange', () => void this.refreshCameras());
  }

  /** Reads the camera list again (names appear once a camera was used). */
  async refreshCameras(): Promise<void> {
    this.cameras = await listCameras();
    if (!this.cameras.some((c) => c.id === this.cameraId)) this.cameraId = savedCamera(this.cameras);
    this.changed();
  }

  /** Picks the camera; switches over at once if it is on. */
  async selectCamera(id: string): Promise<void> {
    this.cameraId = id;
    saveCamera(id);
    if (this.room && this.cameraOn && id) await this.room.switchActiveDevice('videoinput', id);
    this.changed();
  }

  get connected(): boolean {
    return !!this.room;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }

  private attachPort(port: MessagePort): void {
    this.port?.close();
    this.port = port;
    port.onmessage = (e: MessageEvent<ToWindow>) => this.fromMain(e.data);
    port.start();
  }

  private toMain(m: ToMain): void {
    this.port?.postMessage(m);
  }

  async start(): Promise<void> {
    if (this.room || this.connecting) return;
    this.connecting = true;
    this.error = null;
    this.changed();
    try {
      const info = await api().remoteStart();
      this.video = info.video;
      const ctx = new AudioContext({ sampleRate: store.project.sampleRate, latencyHint: 'interactive' });
      await ctx.audioWorklet.addModule('remote-worklet.js');
      await ctx.resume();
      this.ctx = ctx;
      const room = new Room({ adaptiveStream: true, dynacast: true });
      this.wire(room);
      await room.connect(info.url, info.token, { autoSubscribe: true });
      this.room = room;
      // the feed the guests hear: the engine's mix-minus, posted by the main process
      const feed = new AudioWorkletNode(ctx, 'wp-play', { numberOfInputs: 0, outputCount: 1, outputChannelCount: [1] } as AudioWorkletNodeOptions);
      const dest = ctx.createMediaStreamDestination();
      feed.connect(dest);
      this.feedNode = feed;
      await room.localParticipant.publishTrack(dest.stream.getAudioTracks()[0], {
        name: 'wavepod-feed',
        source: Track.Source.Microphone,
        dtx: false,
        red: true,
        audioPreset: { maxBitrate: 64_000 },
      });
      for (const p of room.remoteParticipants.values()) this.addGuest(p);
      this.takes = await api().remoteTakes();
    } catch (e) {
      this.error = (e as Error).message;
      await this.stop();
    } finally {
      this.connecting = false;
      this.changed();
    }
  }

  async stop(): Promise<void> {
    const room = this.room;
    this.room = null;
    for (const s of this.sinks.values()) this.dropSink(s);
    this.sinks.clear();
    this.feedNode?.disconnect();
    this.feedNode = null;
    await room?.disconnect();
    await this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.guests.clear();
    this.admitted.clear();
    this.cameraOn = false;
    this.localVideo = null;
    try {
      await api().remoteStop();
    } catch {
      /* the main process cleans up when the window goes */
    }
    this.changed();
  }

  private wire(room: Room): void {
    room
      .on(RoomEvent.ParticipantConnected, (p) => this.addGuest(p))
      .on(RoomEvent.ParticipantDisconnected, (p) => {
        this.guests.delete(p.identity);
        const s = this.sinks.get(p.identity);
        if (s) this.dropSink(s);
        this.sinks.delete(p.identity);
        this.toMain({ type: 'left', identity: p.identity });
        this.changed();
      })
      .on(RoomEvent.ParticipantPermissionsChanged, (_prev, p) => {
        const g = this.guests.get(p.identity);
        if (g) g.status = p.permissions?.canPublish ? 'live' : 'waiting';
        this.changed();
      })
      .on(RoomEvent.TrackSubscribed, (track, _pub, p) => this.onTrack(track, p))
      .on(RoomEvent.TrackUnsubscribed, (track, _pub, p) => {
        if (track.kind === Track.Kind.Video) {
          const g = this.guests.get(p.identity);
          if (g) g.video = null;
          track.detach();
          this.changed();
        }
      })
      .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
        const ids = new Set(speakers.map((s) => s.identity));
        for (const g of this.guests.values()) g.speaking = ids.has(g.identity);
        this.changed();
      })
      .on(RoomEvent.ConnectionQualityChanged, (q, p) => {
        const g = this.guests.get(p.identity);
        if (!g) return;
        g.quality = q === ConnectionQuality.Excellent ? 'excellent' : q === ConnectionQuality.Good ? 'good' : q === ConnectionQuality.Poor ? 'poor' : q === ConnectionQuality.Lost ? 'lost' : 'unknown';
        this.changed();
      })
      .on(RoomEvent.DataReceived, (payload, p, _kind, topic) => {
        if (topic !== TOPIC_CONTROL || !p) return;
        const msg = decodeMessage<GuestMessage>(payload);
        if (msg) this.onGuestMessage(p.identity, msg);
      })
      .on(RoomEvent.Disconnected, () => {
        if (!this.room) return;
        this.error = 'The connection to the LiveKit server was lost.';
        void this.stop();
      });
    room.registerByteStreamHandler(TOPIC_CHUNK, (reader, { identity }) => {
      const header = parseChunkAttributes(reader.info.attributes);
      if (!header) return;
      void reader.readAll().then((parts) => {
        const n = parts.reduce((s, x) => s + x.length, 0);
        const pcm = new Uint8Array(n);
        let o = 0;
        for (const x of parts) {
          pcm.set(x, o);
          o += x.length;
        }
        this.toMain({ type: 'chunk', identity, header, pcm });
      });
    });
  }

  private addGuest(p: RemoteParticipant): void {
    const guestId = guestIdOf(p.identity);
    if (!guestId || p.identity === HOST_IDENTITY) return;
    this.guests.set(p.identity, {
      identity: p.identity,
      guestId,
      name: p.name || this.trackOf(guestId)?.name || 'Guest',
      status: p.permissions?.canPublish ? 'live' : 'waiting',
      speaking: false,
      quality: 'unknown',
      rttMs: null,
      behind: 0,
      storage: 'ok',
      problem: null,
      video: null,
    });
    // back after a reload or a dropped connection: no need to wait in the waiting room again
    if (this.admitted.has(p.identity)) void this.admit(p.identity);
    this.changed();
  }

  private trackOf(guestId: string) {
    return store.project.tracks.find((t) => t.remote?.guestId === guestId);
  }

  async admit(identity: string): Promise<void> {
    await api().remoteAdmit(identity);
    this.admitted.add(identity);
    this.toMain({ type: 'admitted', identity });
    const g = this.guests.get(identity);
    if (g) g.status = 'live';
    this.changed();
  }

  async holdBack(identity: string): Promise<void> {
    this.admitted.delete(identity);
    await api().remoteHoldBack(identity);
    const g = this.guests.get(identity);
    if (g) g.status = 'waiting';
    this.changed();
  }

  async remove(identity: string): Promise<void> {
    this.admitted.delete(identity);
    await api().remoteRemove(identity);
  }

  /** The host's own camera, so guests can see the host (video is never recorded). */
  async setCamera(on: boolean): Promise<void> {
    if (!this.room) return;
    const pub = await this.room.localParticipant.setCameraEnabled(
      on,
      { resolution: VideoPresets.h360.resolution, ...(this.cameraId ? { deviceId: { exact: this.cameraId } } : {}) },
      { simulcast: true, videoSimulcastLayers: [VideoPresets.h180] },
    );
    this.cameraOn = on;
    // the names (and any camera the default picked) are known now
    if (on) {
      const id = pub?.videoTrack?.mediaStreamTrack.getSettings().deviceId;
      await this.refreshCameras();
      if (id && !this.cameraId) this.cameraId = id;
    }
    const track = pub?.videoTrack;
    this.localVideo = on && track ? (track.attach() as HTMLVideoElement) : null;
    this.changed();
  }

  private onTrack(track: RemoteTrack, p: RemoteParticipant): void {
    const guestId = guestIdOf(p.identity);
    if (!guestId) return;
    if (track.kind === Track.Kind.Video) {
      const g = this.guests.get(p.identity);
      if (g) g.video = track.attach() as HTMLVideoElement;
      this.changed();
      return;
    }
    if (track.kind !== Track.Kind.Audio || !this.ctx) return;
    const ctx = this.ctx;
    // Chromium only hands remote WebRTC audio to Web Audio while a media element plays the stream
    const el = track.attach();
    el.muted = true;
    const source = ctx.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
    const node = new AudioWorkletNode(ctx, 'wp-capture', { processorOptions: { block: BRIDGE_BLOCK } });
    const silent = ctx.createGain();
    silent.gain.value = 0;
    source.connect(node);
    // a node is only processed while it leads to the destination; this path stays silent
    node.connect(silent).connect(ctx.destination);
    node.port.onmessage = (e: MessageEvent<{ samples: Float32Array }>) => {
      const t = this.trackOf(guestId);
      if (t) this.toMain({ type: 'audio', trackId: t.id, samples: e.data.samples });
    };
    const old = this.sinks.get(p.identity);
    if (old) this.dropSink(old);
    this.sinks.set(p.identity, { node, source, el });
  }

  private dropSink(s: { node: AudioWorkletNode; source: MediaStreamAudioSourceNode; el: HTMLMediaElement }): void {
    s.node.port.onmessage = null;
    s.source.disconnect();
    s.node.disconnect();
    s.el.srcObject = null;
    s.el.remove();
  }

  private onGuestMessage(identity: string, msg: GuestMessage): void {
    const g = this.guests.get(identity);
    if (g) {
      if (msg.type === 'status') {
        g.behind = msg.behindChunks;
        g.storage = msg.storage;
        this.changed();
      } else if (msg.type === 'problem') {
        g.problem = msg.text;
        this.changed();
      } else if (msg.type === 'hello' && msg.name && !g.name) g.name = msg.name;
    }
    this.toMain({ type: 'guest', identity, msg });
  }

  private fromMain(m: ToWindow): void {
    switch (m.type) {
      case 'feed':
        this.feedNode?.port.postMessage(m.samples);
        return;
      case 'send': {
        const room = this.room;
        if (!room) return;
        const opts = { reliable: true, topic: TOPIC_CONTROL, ...(m.identity ? { destinationIdentities: [m.identity] } : {}) };
        room.localParticipant.publishData(encodeMessage(m.msg), opts).catch(() => {});
        return;
      }
      case 'takes':
        this.takes = m.takes;
        this.changed();
        return;
      case 'rtt': {
        const g = this.guests.get(m.identity);
        if (g) g.rttMs = Math.round(m.rttMs);
        this.changed();
        return;
      }
    }
  }
}

export const remoteSession = new RemoteSession();
