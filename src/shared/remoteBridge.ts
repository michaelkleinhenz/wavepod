// Messages between the window (which holds the LiveKit connection) and the main process (audio
// engine, files), over a dedicated MessagePort so audio never queues behind other IPC.
import type { ChunkHeader, GuestMessage, HostMessage } from './remoteProtocol';
import type { RemoteTakeInfo } from './types';

/** Name of the window message the preload uses to hand over the port. */
export const REMOTE_PORT_MESSAGE = 'wavepod-remote-port';
/** IPC channel the main process sends the port on. */
export const REMOTE_PORT_CHANNEL = 'wavepod:remote-port';

export type ToMain =
  /** A guest's call audio, mono at the project rate. */
  | { type: 'audio'; trackId: string; samples: Float32Array }
  /** A control message from a guest. */
  | { type: 'guest'; identity: string; msg: GuestMessage }
  /** A chunk of a guest's raw recording. */
  | { type: 'chunk'; identity: string; header: ChunkHeader; pcm: Uint8Array }
  /** A guest was let in (main re-sends what it needs, e.g. a take in progress). */
  | { type: 'admitted'; identity: string }
  | { type: 'left'; identity: string };

export type ToWindow =
  /** The feed the guests hear, mono at the project rate. */
  | { type: 'feed'; samples: Float32Array }
  /** Send a control message to one guest (or every guest for null). */
  | { type: 'send'; identity: string | null; msg: HostMessage }
  /** The uploaded recordings and their state. */
  | { type: 'takes'; takes: RemoteTakeInfo[] }
  /** Round trip to a guest (ms). */
  | { type: 'rtt'; identity: string; rttMs: number };
