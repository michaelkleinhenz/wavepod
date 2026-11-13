// Remote guests: what WavePod (the host) and the guest page say to each other over LiveKit.
// Shared by the app and the guest web page (site/join/v1/), so both sides agree byte for byte.
//
// Two lanes travel through one LiveKit room:
//  - the live call: Opus audio (and, if switched on, small camera video only to see each other),
//  - the recording: each guest records its own raw microphone in the browser and sends it to the
//    host in one-second chunks (byte streams), which the host writes into a lossless WAV file.
// Small control messages (record start/stop, acks, clock pings) go as reliable data packets.

/** Bumped on a breaking change; the guest page refuses a host that speaks another version. */
export const PROTOCOL_VERSION = 1;

/** The host's identity in every room. */
export const HOST_IDENTITY = 'host';
/** Guests join as `guest-<id>`. */
export const GUEST_PREFIX = 'guest-';

export const TOPIC_CONTROL = 'wp-control';
export const TOPIC_CHUNK = 'wp-chunk';

/** Length of one upload chunk, in seconds of audio. */
export const CHUNK_SECONDS = 1;
/** Audio the guest keeps from before the host's record start, so a late message loses nothing. */
export const PRE_ROLL_SECONDS = 2;
/** Bytes per sample of the raw upload (24-bit PCM, little-endian). */
export const BYTES_PER_SAMPLE = 3;

export const guestIdentity = (guestId: string) => `${GUEST_PREFIX}${guestId}`;
export function guestIdOf(identity: string): string | null {
  return identity.startsWith(GUEST_PREFIX) ? identity.slice(GUEST_PREFIX.length) : null;
}

/** Host → guest. */
export type HostMessage =
  /** Sent on admit and on request: who the guest is to the host, and what the host is doing. */
  | { v: number; type: 'hello'; episode: string; sampleRate: number; recording: RecordingState | null; video: boolean }
  /** A take starts: the guest records from now (plus its pre-roll) until `rec-stop`. */
  | { v: number; type: 'rec-start'; takeId: string }
  | { v: number; type: 'rec-stop'; takeId: string }
  /** Every contiguous chunk up to and including `upTo` is safely on the host's disk. */
  | { v: number; type: 'ack'; takeId: string; upTo: number }
  /** The host has the whole take: the guest may delete its local copy. */
  | { v: number; type: 'take-complete'; takeId: string }
  /** Please (re)send these chunks. */
  | { v: number; type: 'resend'; takeId: string; seqs: number[] }
  /** Clock ping; the guest answers with `pong` at once. */
  | { v: number; type: 'ping'; id: number }
  | { v: number; type: 'video'; on: boolean };

/** Guest → host. */
export type GuestMessage =
  | { v: number; type: 'hello'; name: string; userAgent: string }
  /** The guest's recorder started the take: `startSample` is the first recorded sample on its counter. */
  | { v: number; type: 'rec-started'; takeId: string; sampleRate: number; startSample: number; preRoll: number }
  /** The take ended with `chunks` chunks (0 … chunks-1) and `frames` samples in all. */
  | { v: number; type: 'rec-finished'; takeId: string; chunks: number; frames: number }
  /** Takes still held locally (after a reload or reconnect): what the guest can send. */
  | { v: number; type: 'inventory'; takes: InventoryTake[] }
  | { v: number; type: 'pong'; id: number; guestSample: number }
  /** Upload health for the host's guest list. */
  | { v: number; type: 'status'; behindChunks: number; storage: 'ok' | 'none' | 'full' }
  /** Something went wrong on the guest's side that the host should see. */
  | { v: number; type: 'problem'; text: string };

export interface InventoryTake {
  takeId: string;
  sampleRate: number;
  chunks: number;
  /** Known once the take finished; null while it is still going. */
  frames: number | null;
}

export interface RecordingState {
  takeId: string;
}

export type ControlMessage = HostMessage | GuestMessage;

const enc = new TextEncoder();
const dec = new TextDecoder();

export function encodeMessage(m: ControlMessage): Uint8Array<ArrayBuffer> {
  return enc.encode(JSON.stringify(m));
}

/** Parses a control message; null for anything malformed or from another protocol version. */
export function decodeMessage<T extends ControlMessage = ControlMessage>(data: Uint8Array): T | null {
  try {
    const m = JSON.parse(dec.decode(data)) as Partial<ControlMessage>;
    if (!m || typeof m !== 'object' || typeof m.type !== 'string' || m.v !== PROTOCOL_VERSION) return null;
    return m as T;
  } catch {
    return null;
  }
}

/** What travels with every upload chunk, as byte stream attributes (all strings on the wire). */
export interface ChunkHeader {
  takeId: string;
  /** 0-based chunk number within the take. */
  seq: number;
  /** Sample rate of the guest's recording. */
  sampleRate: number;
  /** Samples in this chunk (the last one is usually shorter). */
  frames: number;
}

export function chunkAttributes(h: ChunkHeader): Record<string, string> {
  return { v: String(PROTOCOL_VERSION), takeId: h.takeId, seq: String(h.seq), sampleRate: String(h.sampleRate), frames: String(h.frames) };
}

export function parseChunkAttributes(a: Record<string, string> | undefined): ChunkHeader | null {
  if (!a || a.v !== String(PROTOCOL_VERSION) || !a.takeId) return null;
  const seq = Number(a.seq);
  const sampleRate = Number(a.sampleRate);
  const frames = Number(a.frames);
  if (!Number.isInteger(seq) || seq < 0 || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) return null;
  if (!Number.isInteger(frames) || frames < 0 || frames > sampleRate * CHUNK_SECONDS * 2) return null;
  if (!/^[\w-]{1,64}$/.test(a.takeId)) return null;
  return { takeId: a.takeId, seq, sampleRate, frames };
}

/** Float samples to 24-bit little-endian PCM (clipped to ±1). */
export function floatToPcm24(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(samples.length * 3);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    let v = Math.round(s * 8388607);
    if (v < 0) v += 0x1000000;
    out[i * 3] = v & 0xff;
    out[i * 3 + 1] = (v >> 8) & 0xff;
    out[i * 3 + 2] = (v >> 16) & 0xff;
  }
  return out;
}

export function pcm24ToFloat(bytes: Uint8Array): Float32Array {
  const n = Math.floor(bytes.length / 3);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = bytes[i * 3] | (bytes[i * 3 + 1] << 8) | (bytes[i * 3 + 2] << 16);
    if (v & 0x800000) v -= 0x1000000;
    out[i] = v / 8388607;
  }
  return out;
}

// ------------------------------------------------------------------ invite links

/** What an invite link carries, in the URL fragment so it never reaches the web server's logs. */
export interface InviteLink {
  /** LiveKit server (wss://…). */
  url: string;
  token: string;
  /** Episode name, shown to the guest before joining. */
  episode: string;
  /** Guest name the host typed, prefilled. */
  name: string;
}

export function buildInviteLink(pageUrl: string, link: InviteLink): string {
  const q = new URLSearchParams({ u: link.url, t: link.token, e: link.episode, n: link.name });
  return `${pageUrl.replace(/#.*$/, '')}#${q.toString()}`;
}

export function parseInviteLink(hash: string): InviteLink | null {
  const q = new URLSearchParams(hash.replace(/^#/, ''));
  const url = q.get('u') ?? '';
  const token = q.get('t') ?? '';
  if (!/^wss?:\/\//.test(url) || token.split('.').length !== 3) return null;
  return { url, token, episode: q.get('e') ?? '', name: q.get('n') ?? '' };
}
