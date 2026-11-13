// Video files for the window: reading byte ranges of camera files (the window decodes them with
// WebCodecs), and writing the exported video in pieces at the positions the muxer asks for.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'mkv', 'webm'];

/** A camera file: relative to the episode folder, or absolute when it was left where it was. */
export function resolveMediaPath(dir: string, file: string): string {
  return path.isAbsolute(file) ? file : path.resolve(dir, file);
}

/** How a picked video is stored in the episode: relative when it sits inside the episode folder. */
export function storedVideoPath(dir: string, abs: string): string {
  const rel = path.relative(dir, abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : abs;
}

export function fileSize(p: string): number {
  return fs.statSync(p).size;
}

/** Bytes [start, end) of a file. */
export function readRange(p: string, start: number, end: number): Uint8Array {
  const len = Math.max(0, end - start);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(p, 'r');
  try {
    let got = 0;
    while (got < len) {
      const n = fs.readSync(fd, buf, got, len - got, start + got);
      if (!n) break;
      got += n;
    }
    return new Uint8Array(buf.buffer, buf.byteOffset, got);
  } finally {
    fs.closeSync(fd);
  }
}

/** Video files being written by the window's export, by id. */
export class VideoWriter {
  private files = new Map<string, { fd: number; path: string; tmp: string }>();
  private next = 1;

  /** Writes into `<path>.part` and renames it when done, so a cancelled export leaves no broken file. */
  open(target: string): string {
    const tmp = `${target}.part`;
    const fd = fs.openSync(tmp, 'w');
    const id = `v${this.next++}`;
    this.files.set(id, { fd, path: target, tmp });
    return id;
  }

  write(id: string, position: number, data: Uint8Array): void {
    const f = this.files.get(id);
    if (!f) throw new Error('The video file is not open');
    let done = 0;
    while (done < data.length) done += fs.writeSync(f.fd, data, done, data.length - done, position + done);
  }

  close(id: string, abort = false): string | null {
    const f = this.files.get(id);
    if (!f) return null;
    this.files.delete(id);
    fs.closeSync(f.fd);
    if (abort) {
      fs.rmSync(f.tmp, { force: true });
      return null;
    }
    fs.renameSync(f.tmp, f.path);
    return f.path;
  }

  closeAll(): void {
    for (const id of [...this.files.keys()]) this.close(id, true);
  }
}

/** A temporary folder for the mix the video export renders first. */
export function videoTempBase(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavepod-video-'));
  return path.join(dir, 'mix');
}

/** Removes a temporary mix folder made by videoTempBase (and nothing else). */
export function removeVideoTemp(base: string): void {
  const dir = path.dirname(base);
  if (!path.basename(dir).startsWith('wavepod-video-') || path.dirname(dir) !== os.tmpdir()) return;
  fs.rmSync(dir, { recursive: true, force: true });
}
