// The page a remote guest opens from the host's invite link (site/join/v1/). No install, no account.
//
// It does two things at once:
//  - the live call: the guest's microphone goes to the room as Opus, and the guest hears the host's
//    feed (and the other guests) — good enough to talk, never used in the episode;
//  - the recording: the same microphone, untouched (no echo cancellation, noise suppression or
//    automatic gain), is recorded here at the episode's sample rate, kept in the browser's private
//    storage in one-second chunks, and sent to the host's WavePod while the take runs. A chunk is
//    only deleted once the host has the whole take, so a closed tab or a dropped connection loses
//    nothing: opening the link again sends the rest.
import { DisconnectReason, Room, RoomEvent, Track, VideoPresets, type LocalTrackPublication, type Participant, type RemoteTrack } from 'livekit-client';
import {
  CHUNK_SECONDS,
  HOST_IDENTITY,
  PRE_ROLL_SECONDS,
  PROTOCOL_VERSION,
  TOPIC_CHUNK,
  TOPIC_CONTROL,
  chunkAttributes,
  decodeMessage,
  encodeMessage,
  floatToPcm24,
  parseInviteLink,
  type GuestMessage,
  type HostMessage,
} from '../shared/remoteProtocol';
import { ChunkStore, openChunkStore } from './store';
import { listCameras, saveCamera, savedCamera, type CameraChoice } from '../shared/cameras';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const app = $('#app');
const MAX_IN_FLIGHT = 4;

type Screen = 'invalid' | 'join' | 'setup' | 'waiting' | 'live' | 'ended' | 'unsupported';

interface TakeState {
  takeId: string;
  sampleRate: number;
  seq: number;
  frames: number;
  pending: Float32Array[];
  pendingFrames: number;
  stopping: boolean;
}

const link = parseInviteLink(location.hash);
let screen: Screen = link ? 'join' : 'invalid';
let name = link?.name ?? '';
let stream: MediaStream | null = null;
let devices: MediaDeviceInfo[] = [];
let deviceId = '';
let room: Room | null = null;
let micPub: LocalTrackPublication | null = null;
let muted = false;
let videoAllowed = false;
let cameraOn = false;
let cameras: CameraChoice[] = [];
let cameraId = '';
let ctx: AudioContext | null = null;
let meterLevel = 0;
let recorderNode: AudioWorkletNode | null = null;
let preRoll: Float32Array[] = [];
let preRollFrames = 0;
let take: TakeState | null = null;
let store: ChunkStore | null = null;
let storeState: 'ok' | 'none' | 'full' = 'ok';
let hostRate = 0;
let recordingBadge: string | null = null;
let recordStartedAt = 0;
let message = '';
let errorText = '';
/** Chunks waiting to go: [takeId, seq]. */
const queue: Array<[string, number]> = [];
let inFlight = 0;
/** Highest chunk the host confirmed per take. */
const acked = new Map<string, number>();
/** Takes the host has completely. */
const complete = new Set<string>();
const speaking = new Set<string>();

function send(m: GuestMessage): void {
  room?.localParticipant.publishData(encodeMessage(m), { reliable: true, topic: TOPIC_CONTROL, destinationIdentities: [HOST_IDENTITY] }).catch(() => {});
}

// ------------------------------------------------------------------ screens

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> | null, ...children: Array<Node | string | null | false | undefined>): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

function render(): void {
  // redrawing would close a list the guest has open: wait until they pick or leave it
  if (document.activeElement instanceof HTMLSelectElement && app.contains(document.activeElement)) return;
  app.replaceChildren(...view().filter((n): n is Node => !!n));
}

function view(): Array<Node | null> {
  const episode = link?.episode ? h('p', { class: 'episode' }, 'Recording: ', h('strong', null, link.episode)) : null;
  switch (screen) {
    case 'invalid':
      return [h('h1', null, 'This invite link is incomplete'), h('p', null, 'Ask the host for a new link and open it in full.')];
    case 'unsupported':
      return [h('h1', null, 'This browser can’t record here'), h('p', null, errorText), h('p', null, 'Please open the link in a current Chrome, Edge, Firefox or Safari on a computer.')];
    case 'join':
      return [
        h('h1', null, 'You’re invited to a recording'),
        episode,
        h('label', { class: 'field' }, 'Your name', h('input', { type: 'text', value: name, oninput: (e: Event) => (name = (e.target as HTMLInputElement).value) })),
        h('p', { class: 'note' }, 'Your microphone is recorded in full quality in this browser and sent to the host while you talk. Please use headphones, so the others don’t echo into your microphone.'),
        h('button', { class: 'primary', onclick: () => void setup() }, 'Set up microphone'),
        errorText ? h('p', { class: 'error' }, errorText) : null,
      ];
    case 'setup':
      return [
        h('h1', null, 'Check your microphone'),
        episode,
        h(
          'label',
          { class: 'field' },
          'Microphone',
          micSelect(),
        ),
        h('div', { class: 'meter' }, h('div', { class: 'meter-fill', id: 'meter' })),
        h('p', { class: 'note' }, 'Speak normally: the bar should move well into the middle without hitting the end. Headphones on? Then join.'),
        h('button', { class: 'primary', onclick: () => void join() }, 'Join'),
        errorText ? h('p', { class: 'error' }, errorText) : null,
      ];
    case 'waiting':
      return [h('h1', null, 'Waiting for the host'), episode, h('p', null, 'The host lets you in in a moment.'), h('div', { class: 'meter' }, h('div', { class: 'meter-fill', id: 'meter' })), message ? h('p', { class: 'note' }, message) : null];
    case 'live':
      return liveView(episode);
    case 'ended':
      return [h('h1', null, 'Thanks!'), h('p', null, message || 'You’ve left the recording.'), downloadButtons()];
  }
}

function liveView(episode: Node | null): Array<Node | null> {
  const people = [...(room?.remoteParticipants.values() ?? [])];
  const list = h(
    'ul',
    { class: 'people' },
    h('li', { class: speaking.has(room?.localParticipant.identity ?? '') ? 'speaking' : '' }, `${name || 'You'} (you)`, muted ? ' · muted' : ''),
    ...people.map((p) => h('li', { class: speaking.has(p.identity) ? 'speaking' : '' }, p.identity === HOST_IDENTITY ? 'Host' : p.name || 'Guest')),
  );
  const backlog = queue.length + inFlight;
  const saved = recordingBadge ? (backlog > 2 ? `Sending your recording… ${backlog} s behind` : 'Your recording is being sent as you talk') : pendingTakes() ? 'Finishing your recording…' : 'All audio saved';
  const videos = h('div', { class: 'videos' });
  for (const p of [room?.localParticipant, ...people]) {
    const pub = p?.getTrackPublication(Track.Source.Camera);
    const t = pub?.track;
    if (t && !pub?.isMuted) {
      const el = t.attach() as HTMLVideoElement;
      el.muted = true;
      videos.append(el);
    }
  }
  return [
    h('div', { class: 'top' }, h('h1', null, link?.episode || 'Recording'), recordingBadge ? h('span', { class: 'rec' }, recordingBadge) : h('span', { class: 'idle' }, 'Not recording')),
    videos.childElementCount ? videos : null,
    list,
    h('div', { class: 'meter' }, h('div', { class: 'meter-fill', id: 'meter' })),
    h('p', { class: `saved${storeState !== 'ok' ? ' warn' : ''}` }, storeState === 'none' ? 'This browser can’t keep a copy: keep this tab open until the host has everything.' : storeState === 'full' ? 'The browser’s storage is full: keep this tab open until your recording is sent.' : saved),
    devices.length > 1 || (videoAllowed && cameras.length > 1) ? h('div', { class: 'devices' }, devices.length > 1 ? micSelect() : null, cameraSelect()) : null,
    h(
      'div',
      { class: 'buttons' },
      h('button', { onclick: () => void toggleMute() }, muted ? 'Unmute' : 'Mute'),
      videoAllowed ? h('button', { onclick: () => void toggleCamera() }, cameraOn ? 'Camera off' : 'Camera on') : null,
      h('button', { onclick: () => void leave() }, 'Leave'),
    ),
    message ? h('p', { class: 'note' }, message) : null,
    episode && !link?.episode ? episode : null,
  ];
}

/** The camera list (only when video is on and there is a choice). */
function cameraSelect(): HTMLSelectElement | null {
  return videoAllowed && cameras.length > 1
    ? h(
        'select',
        {
          class: 'camera',
          'aria-label': 'Camera',
          onchange: (e: Event) => {
            const sel = e.target as HTMLSelectElement;
            sel.blur();
            void pickCamera(sel.value);
          },
          onblur: () => render(),
        },
        ...(cameraId ? [] : [h('option', { value: '', selected: true }, 'Default camera')]),
        ...cameras.map((c) => h('option', { value: c.id, selected: c.id === cameraId }, c.label)),
      )
    : null;
}

/** The microphone list: before joining, and during the call (the recording carries on). */
function micSelect(): HTMLSelectElement {
  return h(
    'select',
    {
      class: 'mic',
      'aria-label': 'Microphone',
      onchange: (e: Event) => {
        const sel = e.target as HTMLSelectElement;
        sel.blur();
        void pickDevice(sel.value).catch((err) => {
          message = `Microphone: ${(err as Error).message}`;
          render();
        });
      },
      onblur: () => render(),
    },
    ...devices.map((d, i) => h('option', { value: d.deviceId, selected: d.deviceId === deviceId }, d.label || `Microphone ${i + 1}`)),
  );
}

function pendingTakes(): boolean {
  return queue.length + inFlight > 0 || (store?.takeIds().some((t) => !complete.has(t)) ?? false);
}

function downloadButtons(): Node | null {
  const ids = store?.takeIds() ?? [];
  if (!ids.length) return null;
  return h('div', { class: 'downloads' }, h('p', { class: 'note' }, 'Your recording is still kept in this browser. If the host asks for it, download it here:'), ...ids.map((id, i) => h('button', { onclick: () => void download(id) }, `Download take ${i + 1}`)));
}

// ------------------------------------------------------------------ microphone

async function setup(): Promise<void> {
  errorText = '';
  if (!window.AudioWorkletNode || !navigator.mediaDevices?.getUserMedia) {
    screen = 'unsupported';
    errorText = 'It is missing the audio features WavePod needs.';
    return render();
  }
  try {
    await openMic('');
    devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    deviceId = stream?.getAudioTracks()[0]?.getSettings().deviceId ?? '';
    screen = 'setup';
    render();
  } catch (e) {
    errorText = `The microphone could not be opened: ${(e as Error).message}. Allow microphone access for this page and try again.`;
    render();
  }
}

async function openMic(id: string): Promise<void> {
  stream?.getTracks().forEach((t) => t.stop());
  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(id ? { deviceId: { exact: id } } : {}),
      // the recording must be the plain microphone: no processing of any kind
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  });
  await startAudio(hostRate || undefined);
}

async function pickDevice(id: string): Promise<void> {
  deviceId = id;
  await openMic(id);
  if (micPub && stream) await micPub.audioTrack?.replaceTrack(stream.getAudioTracks()[0]);
  render();
}

/** The audio context the meter and the recorder run in, at the episode's rate once it is known. */
async function startAudio(rate?: number): Promise<void> {
  if (ctx && (!rate || ctx.sampleRate === rate) && recorderNode) {
    reconnectSource();
    return;
  }
  await ctx?.close().catch(() => {});
  ctx = new AudioContext(rate ? { sampleRate: rate, latencyHint: 'interactive' } : { latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule('remote-worklet.js');
  await ctx.resume();
  recorderNode = new AudioWorkletNode(ctx, 'wp-capture', { processorOptions: { block: 2048 } });
  const silent = ctx.createGain();
  silent.gain.value = 0;
  recorderNode.connect(silent).connect(ctx.destination);
  recorderNode.port.onmessage = (e: MessageEvent<{ samples: Float32Array; frame: number }>) => onAudio(e.data.samples);
  preRoll = [];
  preRollFrames = 0;
  reconnectSource();
}

let source: MediaStreamAudioSourceNode | null = null;
function reconnectSource(): void {
  if (!ctx || !stream || !recorderNode) return;
  source?.disconnect();
  source = ctx.createMediaStreamSource(stream);
  source.connect(recorderNode);
}

function onAudio(samples: Float32Array): void {
  let peak = 0;
  for (const v of samples) peak = Math.max(peak, Math.abs(v));
  meterLevel = Math.max(peak, meterLevel * 0.85);
  const fill = document.getElementById('meter');
  if (fill) fill.style.width = `${Math.min(100, Math.round(Math.sqrt(meterLevel) * 100))}%`;
  const data = muted ? new Float32Array(samples.length) : samples;
  // the post-roll after the host's stop still goes into the take
  if (take) addToTake(data);
  // the last seconds are kept, so a take starts a little before the host's start reached us
  preRoll.push(data);
  preRollFrames += data.length;
  const keep = PRE_ROLL_SECONDS * (ctx?.sampleRate ?? 48000);
  while (preRoll.length && preRollFrames - preRoll[0].length >= keep) preRollFrames -= preRoll.shift()!.length;
}

// ------------------------------------------------------------------ room

async function join(): Promise<void> {
  if (!link) return;
  errorText = '';
  screen = 'waiting';
  message = '';
  render();
  try {
    store = await openChunkStore(roomKey());
    storeState = store.persistent ? 'ok' : 'none';
  } catch {
    store = null;
    storeState = 'none';
  }
  const r = new Room({ adaptiveStream: true, dynacast: true });
  r.on(RoomEvent.ParticipantPermissionsChanged, (_prev, p) => {
    if (p === r.localParticipant) void onPermissions();
  })
    .on(RoomEvent.DataReceived, (payload, p, _k, topic) => {
      if (topic !== TOPIC_CONTROL || p?.identity !== HOST_IDENTITY) return;
      const m = decodeMessage<HostMessage>(payload);
      if (m) void onHost(m);
    })
    .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (track.kind === Track.Kind.Audio) document.body.append(track.attach());
      if (screen === 'live') render();
    })
    .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      track.detach().forEach((el) => el.remove());
      if (screen === 'live') render();
    })
    .on(RoomEvent.ActiveSpeakersChanged, (s: Participant[]) => {
      speaking.clear();
      s.forEach((p) => speaking.add(p.identity));
      if (screen === 'live') render();
    })
    .on(RoomEvent.ParticipantConnected, () => screen === 'live' && render())
    .on(RoomEvent.ParticipantDisconnected, () => screen === 'live' && render())
    .on(RoomEvent.Reconnecting, () => {
      message = 'Connection lost, reconnecting… Your recording continues.';
      render();
    })
    .on(RoomEvent.Reconnected, () => {
      message = '';
      send({ v: PROTOCOL_VERSION, type: 'hello', name, userAgent: navigator.userAgent });
      render();
    })
    .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
      if (room !== r) return;
      room = null;
      micPub = null;
      screen = 'ended';
      cameraOn = false;
      const byHost = reason === DisconnectReason.ROOM_DELETED || reason === DisconnectReason.PARTICIPANT_REMOVED;
      const ended = reason === DisconnectReason.PARTICIPANT_REMOVED ? 'The host removed you from the session.' : 'The host ended the session.';
      message = pendingTakes()
        ? `${byHost ? ended + ' ' : 'The connection ended. '}Part of your recording hasn’t been sent yet: open the invite link again when the host is back to send the rest.`
        : byHost
          ? ended
          : 'The session has ended.';
      render();
    });
  try {
    await r.connect(link.url, link.token, { autoSubscribe: true });
    if (name) await r.localParticipant.setName(name).catch(() => {});
    room = r;
    if (r.localParticipant.permissions?.canPublish) await onPermissions();
    else render();
  } catch (e) {
    screen = 'setup';
    errorText = /token|401|expired/i.test((e as Error).message) ? 'This invite link has expired. Ask the host for a new one.' : `Could not connect: ${(e as Error).message}`;
    render();
  }
}

/** The host let us in (or put us back in the waiting room). */
async function onPermissions(): Promise<void> {
  if (!room || !stream) return;
  const canPublish = !!room.localParticipant.permissions?.canPublish;
  if (canPublish && screen !== 'live') {
    screen = 'live';
    micPub = await room.localParticipant.publishTrack(stream.getAudioTracks()[0], { source: Track.Source.Microphone, dtx: false, red: true, audioPreset: { maxBitrate: 48_000 } });
    send({ v: PROTOCOL_VERSION, type: 'hello', name, userAgent: navigator.userAgent });
  } else if (!canPublish && screen === 'live') {
    screen = 'waiting';
    message = 'The host has put you back in the waiting room.';
    micPub = null;
  }
  render();
}

async function onHost(m: HostMessage): Promise<void> {
  switch (m.type) {
    case 'hello':
      videoAllowed = m.video;
      if (videoAllowed) void refreshCameras().then(render);
      if (m.sampleRate !== hostRate) {
        hostRate = m.sampleRate;
        // the recording runs at the episode's rate, so nothing is resampled
        if (!take) await startAudio(hostRate);
      }
      if (store) send({ v: PROTOCOL_VERSION, type: 'inventory', takes: await store.inventory() });
      render();
      return;
    case 'rec-start':
      startTake(m.takeId);
      return;
    case 'rec-stop':
      if (take && hostTakeOf(take.takeId) === m.takeId && !take.stopping) {
        take.stopping = true;
        // a moment of post-roll, then the take is closed
        setTimeout(() => void finishTake(), 1000);
      }
      return;
    case 'ack':
      acked.set(m.takeId, Math.max(acked.get(m.takeId) ?? -1, m.upTo));
      return;
    case 'take-complete':
      complete.add(m.takeId);
      await store?.remove(m.takeId);
      render();
      return;
    case 'resend':
      for (const seq of m.seqs) if (!queue.some(([t, s]) => t === m.takeId && s === seq)) queue.push([m.takeId, seq]);
      pump();
      return;
    case 'ping':
      if (ctx) send({ v: PROTOCOL_VERSION, type: 'pong', id: m.id, guestSample: Math.round(ctx.currentTime * ctx.sampleRate) });
      return;
    case 'video':
      videoAllowed = m.on;
      if (videoAllowed) await refreshCameras();
      render();
      return;
  }
}

// ------------------------------------------------------------------ recording

/**
 * The host's take a recording belongs to. When the page was closed in the middle of a take and
 * opened again, the rest is recorded as another part (`<take>-p2`), so nothing already kept is
 * overwritten.
 */
function hostTakeOf(takeId: string): string {
  return takeId.split('-p')[0];
}

function startTake(hostTakeId: string): void {
  if (!ctx) return;
  if (take && hostTakeOf(take.takeId) === hostTakeId) return;
  let takeId = hostTakeId;
  const held = new Set([...(store?.takeIds() ?? []), ...complete]);
  for (let n = 2; held.has(takeId); n++) takeId = `${hostTakeId}-p${n}`;
  if (take) void finishTake();
  if (ctx.sampleRate !== hostRate && hostRate) {
    send({ v: PROTOCOL_VERSION, type: 'problem', text: `This browser records at ${ctx.sampleRate} Hz instead of ${hostRate} Hz; only the call audio is kept.` });
    return;
  }
  const pre = [...preRoll];
  const preFrames = preRollFrames;
  take = { takeId, sampleRate: ctx.sampleRate, seq: 0, frames: 0, pending: [], pendingFrames: 0, stopping: false };
  void store?.begin(takeId, ctx.sampleRate);
  send({ v: PROTOCOL_VERSION, type: 'rec-started', takeId, sampleRate: ctx.sampleRate, startSample: Math.round(ctx.currentTime * ctx.sampleRate) - preFrames, preRoll: preFrames });
  for (const b of pre) addToTake(b);
  recordStartedAt = Date.now();
  recordingBadge = 'Recording';
  render();
}

function addToTake(data: Float32Array): void {
  const t = take;
  if (!t) return;
  t.pending.push(data);
  t.pendingFrames += data.length;
  const size = Math.round(t.sampleRate * CHUNK_SECONDS);
  while (t.pendingFrames >= size) emitChunk(t, size);
}

function emitChunk(t: TakeState, size: number): void {
  const out = new Float32Array(size);
  let o = 0;
  while (o < size) {
    const head = t.pending[0];
    const n = Math.min(head.length, size - o);
    out.set(head.subarray(0, n), o);
    o += n;
    if (n === head.length) t.pending.shift();
    else t.pending[0] = head.subarray(n);
  }
  t.pendingFrames -= size;
  const seq = t.seq++;
  t.frames += size;
  const pcm = floatToPcm24(out);
  memory.set(`${t.takeId}/${seq}`, pcm);
  void store
    ?.put(t.takeId, seq, pcm)
    .then(() => memory.delete(`${t.takeId}/${seq}`))
    .catch(() => {
      storeState = 'full';
    });
  queue.push([t.takeId, seq]);
  pump();
  if (recordingBadge) {
    const s = Math.round((Date.now() - recordStartedAt) / 1000);
    recordingBadge = `Recording ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (screen === 'live') render();
  }
}

/** Chunks not yet in the browser's storage (or with no storage at all). */
const memory = new Map<string, Uint8Array<ArrayBuffer>>();

async function finishTake(): Promise<void> {
  const t = take;
  if (!t) return;
  take = null;
  if (t.pendingFrames > 0) emitChunk(t, t.pendingFrames);
  await store?.finish(t.takeId, t.seq, t.frames);
  send({ v: PROTOCOL_VERSION, type: 'rec-finished', takeId: t.takeId, chunks: t.seq, frames: t.frames });
  recordingBadge = null;
  render();
}

function pump(): void {
  while (room && inFlight < MAX_IN_FLIGHT && queue.length) {
    const [takeId, seq] = queue.shift()!;
    if (complete.has(takeId) || (acked.get(takeId) ?? -1) >= seq) continue;
    inFlight++;
    void sendChunk(takeId, seq)
      .catch(() => queue.push([takeId, seq]))
      .finally(() => {
        inFlight--;
        pump();
      });
  }
}

async function sendChunk(takeId: string, seq: number): Promise<void> {
  const pcm = memory.get(`${takeId}/${seq}`) ?? (await store?.get(takeId, seq));
  const rate = take?.takeId === takeId ? take.sampleRate : (await store?.meta(takeId))?.sampleRate;
  if (!pcm || !rate || !room) return;
  const w = await room.localParticipant.streamBytes({
    topic: TOPIC_CHUNK,
    destinationIdentities: [HOST_IDENTITY],
    attributes: chunkAttributes({ takeId, seq, sampleRate: rate, frames: pcm.length / 3 }),
    totalSize: pcm.length,
    mimeType: 'application/octet-stream',
  });
  await w.write(pcm);
  await w.close();
}

async function toggleMute(): Promise<void> {
  muted = !muted;
  if (muted) await micPub?.mute();
  else await micPub?.unmute();
  render();
}

async function toggleCamera(): Promise<void> {
  if (!room) return;
  cameraOn = !cameraOn;
  const pub = await room.localParticipant
    .setCameraEnabled(
      cameraOn,
      { resolution: VideoPresets.h360.resolution, ...(cameraId ? { deviceId: { exact: cameraId } } : {}) },
      { simulcast: true, videoSimulcastLayers: [VideoPresets.h180] },
    )
    .catch((e) => {
      cameraOn = false;
      message = `Camera: ${(e as Error).message}`;
      return undefined;
    });
  if (cameraOn) {
    // the cameras have names now, and the default one is known
    const id = pub?.videoTrack?.mediaStreamTrack.getSettings().deviceId;
    await refreshCameras();
    if (id && !cameraId) cameraId = id;
  }
  render();
}

async function refreshCameras(): Promise<void> {
  cameras = await listCameras();
  if (!cameras.some((c) => c.id === cameraId)) cameraId = savedCamera(cameras);
}

async function pickCamera(id: string): Promise<void> {
  cameraId = id;
  saveCamera(id);
  if (room && cameraOn && id) await room.switchActiveDevice('videoinput', id).catch((e) => (message = `Camera: ${(e as Error).message}`));
  render();
}

async function leave(): Promise<void> {
  if (take) await finishTake();
  // give the last chunks a moment to go out
  const until = Date.now() + 15_000;
  while ((queue.length || inFlight) && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
  await room?.disconnect();
}

async function download(takeId: string): Promise<void> {
  if (!store) return;
  const meta = await store.meta(takeId);
  if (!meta) return;
  const parts: Uint8Array[] = [];
  for (let s = 0; s < (meta.chunks ?? (await store.seqs(takeId)).length); s++) {
    const p = await store.get(takeId, s);
    if (p) parts.push(p);
  }
  const blob = wavBlob(parts, meta.sampleRate);
  const a = h('a', { href: URL.createObjectURL(blob), download: `${(name || 'guest').replace(/[^\w-]+/g, '_')}-${takeId}.wav` });
  a.click();
}

function wavBlob(parts: Uint8Array[], rate: number): Blob {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const head = new DataView(new ArrayBuffer(44));
  const str = (o: number, s: string) => [...s].forEach((c, i) => head.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  head.setUint32(4, 36 + n, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  head.setUint32(16, 16, true);
  head.setUint16(20, 1, true);
  head.setUint16(22, 1, true);
  head.setUint32(24, rate, true);
  head.setUint32(28, rate * 3, true);
  head.setUint16(32, 3, true);
  head.setUint16(34, 24, true);
  str(36, 'data');
  head.setUint32(40, n, true);
  return new Blob([head.buffer, ...parts.map((p) => p.slice().buffer)], { type: 'audio/wav' });
}

function roomKey(): string {
  try {
    const claims = JSON.parse(atob(link!.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { video?: { room?: string }; sub?: string };
    return `${claims.video?.room ?? 'room'}-${claims.sub ?? 'guest'}`;
  } catch {
    return 'room';
  }
}

// upload health for the host, every two seconds
setInterval(() => {
  if (!room || screen !== 'live') return;
  send({ v: PROTOCOL_VERSION, type: 'status', behindChunks: queue.length + inFlight, storage: storeState });
  if (screen === 'live') render();
}, 2000);

// a microphone or camera plugged in or out
navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  void (async () => {
    if (stream) devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    if (videoAllowed) await refreshCameras();
    render();
  })();
});

window.addEventListener('beforeunload', (e) => {
  if (take || queue.length || inFlight) {
    e.preventDefault();
    e.returnValue = '';
  }
});

render();
