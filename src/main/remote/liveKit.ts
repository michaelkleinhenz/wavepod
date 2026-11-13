// LiveKit without a backend: WavePod signs the access tokens itself with the user's API key and
// secret (HS256 JWTs, as LiveKit's own server SDK makes them) and calls the room service directly.
// Works the same with LiveKit Cloud and a self-hosted livekit-server: only the URL differs.
import { createHmac, randomBytes } from 'node:crypto';
import { HOST_IDENTITY, guestIdentity } from '../../shared/remoteProtocol';

export interface LiveKitCredentials {
  /** wss://<project>.livekit.cloud, or the self-hosted server's URL. */
  url: string;
  apiKey: string;
  apiSecret: string;
}

export interface VideoGrant {
  room?: string;
  roomJoin?: boolean;
  roomList?: boolean;
  roomAdmin?: boolean;
  canPublish?: boolean;
  canSubscribe?: boolean;
  canPublishData?: boolean;
  canUpdateOwnMetadata?: boolean;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** An access token (JWT, HS256) for `identity`, valid for `ttlSeconds`. */
export function signToken(creds: Pick<LiveKitCredentials, 'apiKey' | 'apiSecret'>, identity: string, grant: VideoGrant, opts: { name?: string; ttlSeconds?: number; now?: number } = {}): string {
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const payload: Record<string, unknown> = {
    iss: creds.apiKey,
    sub: identity,
    nbf: now - 10,
    exp: now + (opts.ttlSeconds ?? 6 * 3600),
    jti: identity,
    video: grant,
  };
  if (opts.name) payload.name = opts.name;
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', creds.apiSecret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

/** Reads a token's claims without checking the signature (for tests and the guest list). */
export function tokenClaims(token: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** A fresh room name for an episode's remote session. */
export function newRoomName(): string {
  return `wp-${randomBytes(12).toString('hex')}`;
}

/** A new guest id (also the end of the guest's identity). */
export function newGuestId(): string {
  return randomBytes(6).toString('hex');
}

/** The host's token: joins, publishes the feed, receives everyone, and may run the room. */
export function hostToken(creds: LiveKitCredentials, room: string): string {
  return signToken(creds, HOST_IDENTITY, { room, roomJoin: true, roomAdmin: true, canPublish: true, canSubscribe: true, canPublishData: true }, { name: 'Host' });
}

/**
 * A guest's invite token. The guest arrives in the waiting room: connected, but not allowed to
 * publish or hear anything until the host lets them in (which grants both).
 */
export function guestToken(creds: LiveKitCredentials, room: string, guestId: string, name: string, ttlHours = 24): string {
  return signToken(
    creds,
    guestIdentity(guestId),
    { room, roomJoin: true, canPublish: false, canSubscribe: false, canPublishData: false, canUpdateOwnMetadata: false },
    { name, ttlSeconds: ttlHours * 3600 },
  );
}

/** The HTTP base of the server's API from its WebSocket URL. */
export function apiBase(url: string): string {
  const u = new URL(url.replace(/^ws/, 'http'));
  return `${u.protocol}//${u.host}`;
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** The parts of LiveKit's room service (Twirp, JSON) WavePod needs. */
export class RoomService {
  constructor(
    private creds: LiveKitCredentials,
    private fetchFn: Fetch = fetch as unknown as Fetch,
  ) {}

  private async call<T>(method: string, room: string | undefined, body: Record<string, unknown>): Promise<T> {
    const grant: VideoGrant = room ? { room, roomAdmin: true } : { roomList: true };
    const token = signToken(this.creds, 'wavepod-admin', grant, { ttlSeconds: 600 });
    let res;
    try {
      res = await this.fetchFn(`${apiBase(this.creds.url)}/twirp/livekit.RoomService/${method}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(`Could not reach the LiveKit server at ${this.creds.url}: ${(e as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 401) throw new Error('LiveKit refused the API key or secret. Check them in Settings › Remote guests.');
      let msg = text;
      try {
        msg = (JSON.parse(text) as { msg?: string }).msg ?? text;
      } catch {
        /* plain text */
      }
      throw new Error(`LiveKit: ${msg || `HTTP ${res.status}`}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Checks URL, key and secret; returns how many rooms are open. */
  async test(): Promise<number> {
    const r = await this.call<{ rooms?: unknown[] }>('ListRooms', undefined, {});
    return r.rooms?.length ?? 0;
  }

  /** Lets a waiting guest in: they may now speak, hear the others and send their recording. */
  admit(room: string, identity: string, video: boolean): Promise<unknown> {
    return this.call('UpdateParticipant', room, {
      room,
      identity,
      permission: {
        canSubscribe: true,
        canPublish: true,
        canPublishData: true,
        canPublishSources: video ? ['MICROPHONE', 'CAMERA'] : ['MICROPHONE'],
      },
    });
  }

  /** Sends a guest back to the waiting room (they stay connected, silent and deaf). */
  holdBack(room: string, identity: string): Promise<unknown> {
    return this.call('UpdateParticipant', room, { room, identity, permission: { canSubscribe: false, canPublish: false, canPublishData: true } });
  }

  remove(room: string, identity: string): Promise<unknown> {
    return this.call('RemoveParticipant', room, { room, identity });
  }
}
