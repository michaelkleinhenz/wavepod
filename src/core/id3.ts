// Minimal ID3v2.3 writer with text frames and chapter frames (CHAP/CTOC, ID3v2 Chapter Frame Addendum).
import type { Chapter } from './chapters';

/** An embedded picture (APIC). */
export interface Id3Picture {
  /** 'image/jpeg' or 'image/png'. */
  mime: string;
  data: Buffer;
}

/** A chapter as written into the tag; `picture` is embedded in its CHAP frame. */
export interface Id3Chapter extends Chapter {
  picture?: Id3Picture;
}

export interface Id3Tags {
  title?: string;
  artist?: string;
  album?: string;
  year?: string;
  track?: string;
  comment?: string;
  genre?: string;
  /** Episode cover. */
  cover?: Id3Picture;
  chapters?: Id3Chapter[];
  /** Total duration in seconds; used to close the last chapter. */
  durationSeconds?: number;
}

function utf16(text: string, terminate: boolean): Buffer {
  const body = Buffer.from('﻿' + text, 'utf16le');
  return terminate ? Buffer.concat([body, Buffer.from([0, 0])]) : body;
}

function latin1(text: string, terminate: boolean): Buffer {
  const body = Buffer.from(text, 'latin1');
  return terminate ? Buffer.concat([body, Buffer.from([0])]) : body;
}

function frame(id: string, body: Buffer): Buffer {
  const h = Buffer.alloc(10);
  h.write(id, 0, 'latin1');
  h.writeUInt32BE(body.length, 4);
  return Buffer.concat([h, body]);
}

function textFrame(id: string, text: string): Buffer {
  return frame(id, Buffer.concat([Buffer.from([1]), utf16(text, false)]));
}

function urlFrame(url: string): Buffer {
  // WXXX: encoding, description (empty), url (latin1)
  return frame('WXXX', Buffer.concat([Buffer.from([1]), utf16('', true), latin1(url, false)]));
}

function commentFrame(text: string): Buffer {
  return frame('COMM', Buffer.concat([Buffer.from([1]), Buffer.from('eng', 'latin1'), utf16('', true), utf16(text, false)]));
}

/** APIC: encoding, MIME type, picture type (3 = front cover, 0 = other), description, image data. */
function pictureFrame(pic: Id3Picture, type: number, description = ''): Buffer {
  return frame('APIC', Buffer.concat([Buffer.from([1]), latin1(pic.mime, true), Buffer.from([type]), utf16(description, true), pic.data]));
}

/** MIME type of a JPEG or PNG file, from its first bytes (null for anything else). */
export function imageMime(data: Buffer): string | null {
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length > 8 && data.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  return null;
}

function syncsafe(n: number): Buffer {
  const b = Buffer.alloc(4);
  b[0] = (n >> 21) & 0x7f;
  b[1] = (n >> 14) & 0x7f;
  b[2] = (n >> 7) & 0x7f;
  b[3] = n & 0x7f;
  return b;
}

export function buildId3Tag(tags: Id3Tags): Buffer {
  const frames: Buffer[] = [];
  if (tags.title) frames.push(textFrame('TIT2', tags.title));
  if (tags.artist) frames.push(textFrame('TPE1', tags.artist));
  if (tags.album) frames.push(textFrame('TALB', tags.album));
  if (tags.year) frames.push(textFrame('TYER', tags.year));
  if (tags.track) frames.push(textFrame('TRCK', tags.track));
  if (tags.genre) frames.push(textFrame('TCON', tags.genre));
  if (tags.comment) frames.push(commentFrame(tags.comment));
  if (tags.cover) frames.push(pictureFrame(tags.cover, 3));

  const chapters = [...(tags.chapters ?? [])].sort((a, b) => a.start - b.start);
  if (chapters.length) {
    const ids = chapters.map((_, i) => `chp${i}`);
    // CTOC entry count is one byte, so split into sub-tables beyond 255 (rare in practice).
    const childIds = ids.slice(0, 255);
    const ctocBody = Buffer.concat([
      latin1('toc', true),
      Buffer.from([0x03, childIds.length]), // top-level + ordered
      ...childIds.map((id) => latin1(id, true)),
    ]);
    frames.push(frame('CTOC', ctocBody));
    chapters.forEach((c, i) => {
      const startMs = Math.round(c.start * 1000);
      const next = chapters[i + 1]?.start ?? tags.durationSeconds ?? c.start;
      const endMs = Math.max(startMs, Math.round(next * 1000));
      const times = Buffer.alloc(16);
      times.writeUInt32BE(startMs, 0);
      times.writeUInt32BE(endMs, 4);
      times.writeUInt32BE(0xffffffff, 8);
      times.writeUInt32BE(0xffffffff, 12);
      const sub = [textFrame('TIT2', c.title)];
      if (c.url) sub.push(urlFrame(c.url));
      if (c.picture) sub.push(pictureFrame(c.picture, 0, c.title));
      frames.push(frame('CHAP', Buffer.concat([latin1(ids[i], true), times, ...sub])));
    });
  }

  const body = Buffer.concat(frames);
  const padding = Buffer.alloc(256);
  const header = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0]), syncsafe(body.length + padding.length)]);
  return Buffer.concat([header, body, padding]);
}

// ---- minimal reader, used by tests and to show chapters of imported MP3s

export interface ParsedFrame {
  id: string;
  body: Buffer;
}

export function readSyncsafe(b: Buffer, o: number): number {
  return ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
}

export function parseId3Frames(buf: Buffer): ParsedFrame[] {
  if (buf.toString('latin1', 0, 3) !== 'ID3') return [];
  const size = readSyncsafe(buf, 6);
  return parseFrameList(buf.subarray(10, 10 + size));
}

function parseFrameList(buf: Buffer): ParsedFrame[] {
  const out: ParsedFrame[] = [];
  let o = 0;
  while (o + 10 <= buf.length) {
    const id = buf.toString('latin1', o, o + 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const size = buf.readUInt32BE(o + 4);
    out.push({ id, body: buf.subarray(o + 10, o + 10 + size) });
    o += 10 + size;
  }
  return out;
}

function decodeText(body: Buffer): string {
  const enc = body[0];
  const data = body.subarray(1);
  if (enc === 1) return data.toString('utf16le').replace(/^﻿/, '').replace(/\0+$/, '');
  if (enc === 3) return data.toString('utf8').replace(/\0+$/, '');
  return data.toString('latin1').replace(/\0+$/, '');
}

function parsePicture(body: Buffer): Id3Picture {
  const mimeEnd = body.indexOf(0, 1);
  const mime = body.toString('latin1', 1, mimeEnd);
  // after the picture type: description in the frame's encoding
  let o = mimeEnd + 2;
  if (body[0] === 1 || body[0] === 2) {
    while (o + 1 < body.length && !(body[o] === 0 && body[o + 1] === 0)) o += 2;
    o += 2;
  } else {
    o = body.indexOf(0, o) + 1;
  }
  return { mime, data: body.subarray(o) };
}

/** The episode cover of a tag, if it has one. */
export function readId3Cover(buf: Buffer): Id3Picture | null {
  const f = parseId3Frames(buf).find((x) => x.id === 'APIC');
  return f ? parsePicture(f.body) : null;
}

export function readId3Chapters(buf: Buffer): Id3Chapter[] {
  const chapters: Id3Chapter[] = [];
  for (const f of parseId3Frames(buf)) {
    if (f.id !== 'CHAP') continue;
    const end = f.body.indexOf(0);
    const startMs = f.body.readUInt32BE(end + 1);
    const subs = parseFrameList(f.body.subarray(end + 17));
    const title = subs.find((s) => s.id === 'TIT2');
    const url = subs.find((s) => s.id === 'WXXX');
    let urlText: string | undefined;
    if (url) {
      // skip encoding byte + UTF-16 empty description (BOM + 00 00)
      const desc = url.body.indexOf(Buffer.from([0, 0]), 1);
      urlText = url.body.subarray(desc + 2).toString('latin1');
    }
    const pic = subs.find((s) => s.id === 'APIC');
    chapters.push({
      start: startMs / 1000,
      title: title ? decodeText(title.body) : '',
      ...(urlText ? { url: urlText } : {}),
      ...(pic ? { picture: parsePicture(pic.body) } : {}),
    });
  }
  return chapters.sort((a, b) => a.start - b.start);
}
