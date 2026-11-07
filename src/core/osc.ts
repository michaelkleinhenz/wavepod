// OSC remote control: decoding UDP packets (Open Sound Control 1.0) and mapping addresses to
// WavePod actions, so Stream Deck via Bitfocus Companion, TouchOSC and the like can drive it.
import type { MidiAction, OscSettings, RemoteCommand } from '../shared/types';

export const DEFAULT_OSC_PORT = 9000;

export type OscArg = number | string | boolean | null;

export interface OscMessage {
  address: string;
  args: OscArg[];
}

/** The addresses WavePod listens to, for the Setup card and the README. */
export const OSC_ADDRESSES: Array<{ address: string; what: string }> = [
  { address: '/wavepod/record', what: 'Record on / off' },
  { address: '/wavepod/record/start', what: 'Start recording' },
  { address: '/wavepod/record/stop', what: 'Stop recording' },
  { address: '/wavepod/punch', what: 'Punch in: re-record the selection with pre-roll' },
  { address: '/wavepod/play', what: 'Play / pause' },
  { address: '/wavepod/stop', what: 'Stop' },
  { address: '/wavepod/marker/chapter', what: 'Chapter marker' },
  { address: '/wavepod/marker/edit', what: 'Edit marker' },
  { address: '/wavepod/prepare', what: 'Prepare for editing' },
  { address: '/wavepod/cough/1…6', what: 'Cough button: 1 mutes the speaker, 0 releases' },
  { address: '/wavepod/sound/1…9', what: 'Play soundboard slot' },
  { address: '/wavepod/sounds/stop', what: 'Stop all sounds' },
  { address: '/wavepod/preshow', what: 'Pre-show on / off (only the soundboard is heard)' },
];

const FIXED: Record<string, MidiAction> = {
  '/wavepod/record': 'record-toggle',
  '/wavepod/record/toggle': 'record-toggle',
  '/wavepod/record/start': 'record-start',
  '/wavepod/record/stop': 'record-stop',
  '/wavepod/punch': 'punch-in',
  '/wavepod/play': 'play-toggle',
  '/wavepod/stop': 'stop',
  '/wavepod/marker/chapter': 'chapter-marker',
  '/wavepod/marker/edit': 'edit-marker',
  '/wavepod/prepare': 'prepare-for-editing',
  '/wavepod/sounds/stop': 'sounds-stop',
  '/wavepod/preshow': 'preshow-toggle',
};

/** OSC strings and blobs are padded to a multiple of 4 bytes. */
const pad4 = (n: number) => (n + 3) & ~3;

function readString(buf: Buffer, at: number): { value: string; next: number } {
  const end = buf.indexOf(0, at);
  if (end < 0) throw new Error('unterminated OSC string');
  return { value: buf.toString('utf8', at, end), next: pad4(end + 1) };
}

function parseMessage(buf: Buffer): OscMessage {
  const addr = readString(buf, 0);
  if (!addr.value.startsWith('/')) throw new Error('not an OSC message');
  const args: OscArg[] = [];
  if (addr.next >= buf.length) return { address: addr.value, args };
  const tags = readString(buf, addr.next);
  if (!tags.value.startsWith(',')) return { address: addr.value, args };
  let at = tags.next;
  for (const t of tags.value.slice(1)) {
    switch (t) {
      case 'i':
        args.push(buf.readInt32BE(at));
        at += 4;
        break;
      case 'f':
        args.push(buf.readFloatBE(at));
        at += 4;
        break;
      case 'd':
        args.push(buf.readDoubleBE(at));
        at += 8;
        break;
      case 'h':
        args.push(Number(buf.readBigInt64BE(at)));
        at += 8;
        break;
      case 's':
      case 'S': {
        const s = readString(buf, at);
        args.push(s.value);
        at = s.next;
        break;
      }
      case 'b': {
        const len = buf.readInt32BE(at);
        args.push(null);
        at = pad4(at + 4 + len);
        break;
      }
      case 'T':
        args.push(true);
        break;
      case 'F':
        args.push(false);
        break;
      case 'N':
      case 'I':
        args.push(null);
        break;
      default:
        // an unknown type tag: its size is unknown, so stop reading arguments
        return { address: addr.value, args };
    }
  }
  return { address: addr.value, args };
}

/** All messages in a packet (bundles are flattened; time tags are ignored, everything runs now). */
export function parseOscPacket(buf: Buffer, depth = 0): OscMessage[] {
  if (buf.length >= 16 && buf.toString('latin1', 0, 8) === '#bundle\0') {
    if (depth > 8) return [];
    const out: OscMessage[] = [];
    let at = 16;
    while (at + 4 <= buf.length) {
      const size = buf.readInt32BE(at);
      at += 4;
      if (size <= 0 || at + size > buf.length) break;
      out.push(...parseOscPacket(buf.subarray(at, at + size), depth + 1));
      at += size;
    }
    return out;
  }
  return [parseMessage(buf)];
}

/** Is the message's first argument "on"? No argument counts as on (a plain trigger). */
function isOn(args: OscArg[]): boolean {
  const a = args[0];
  if (a === undefined || a === null) return true;
  if (typeof a === 'boolean') return a;
  if (typeof a === 'number') return a >= 0.5;
  return !['0', 'off', 'false', 'up', 'release'].includes(a.toLowerCase());
}

/**
 * The command for a message, or null if WavePod doesn't know the address. Buttons that send
 * 1 on press and 0 on release fire once; cough buttons mute on 1 and release on 0.
 */
export function oscCommand(msg: OscMessage): RemoteCommand | null {
  const address = msg.address.replace(/\/+$/, '').toLowerCase();
  const on = isOn(msg.args);
  const fixed = FIXED[address];
  if (fixed) return on ? { action: fixed, pressed: true } : null;
  const cough = /^\/wavepod\/cough\/([1-6])$/.exec(address);
  if (cough) return { action: `cough-${Number(cough[1])}` as MidiAction, pressed: on };
  const sound = /^\/wavepod\/sound\/([1-9])$/.exec(address);
  if (sound) return on ? { action: `sound-${Number(sound[1])}` as MidiAction, pressed: true } : null;
  return null;
}

export function normalizeOscSettings(raw: unknown): OscSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<OscSettings>;
  const port = Number(r.port);
  return {
    enabled: r.enabled === true,
    port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_OSC_PORT,
    allowNetwork: r.allowNetwork === true,
  };
}

/** Encodes a message (used by tests and handy for a "send test message" button). */
export function encodeOscMessage(address: string, args: Array<number | string> = []): Buffer {
  const str = (s: string) => {
    const b = Buffer.from(`${s}\0`, 'utf8');
    return Buffer.concat([b, Buffer.alloc(pad4(b.length) - b.length)]);
  };
  const tags = `,${args.map((a) => (typeof a === 'string' ? 's' : Number.isInteger(a) ? 'i' : 'f')).join('')}`;
  const parts = [str(address), str(tags)];
  for (const a of args) {
    if (typeof a === 'string') parts.push(str(a));
    else {
      const b = Buffer.alloc(4);
      if (Number.isInteger(a)) b.writeInt32BE(a);
      else b.writeFloatBE(a);
      parts.push(b);
    }
  }
  return Buffer.concat(parts);
}
