// The guest's copy of its recording: one-second chunks in the browser's private file system (OPFS),
// per take, until the host confirms it has the whole take. Survives a closed tab or a crash; the
// page sends what is left when the invite link is opened again. Without OPFS the chunks stay in
// memory only (the page says so).
import type { InventoryTake } from '../shared/remoteProtocol';

export interface TakeMeta {
  takeId: string;
  sampleRate: number;
  /** Known once the take finished. */
  chunks: number | null;
  frames: number | null;
}

export interface ChunkStore {
  readonly persistent: boolean;
  begin(takeId: string, sampleRate: number): Promise<void>;
  put(takeId: string, seq: number, pcm: Uint8Array<ArrayBuffer>): Promise<void>;
  get(takeId: string, seq: number): Promise<Uint8Array<ArrayBuffer> | null>;
  finish(takeId: string, chunks: number, frames: number): Promise<void>;
  meta(takeId: string): Promise<TakeMeta | null>;
  seqs(takeId: string): Promise<number[]>;
  inventory(): Promise<InventoryTake[]>;
  remove(takeId: string): Promise<void>;
  /** Takes held now (from the last inventory or this session). */
  takeIds(): string[];
}

class MemoryStore implements ChunkStore {
  readonly persistent: boolean = false;
  protected metas = new Map<string, TakeMeta>();
  private data = new Map<string, Uint8Array<ArrayBuffer>>();
  async begin(takeId: string, sampleRate: number) {
    if (!this.metas.has(takeId)) this.metas.set(takeId, { takeId, sampleRate, chunks: null, frames: null });
  }
  async put(takeId: string, seq: number, pcm: Uint8Array<ArrayBuffer>) {
    this.data.set(`${takeId}/${seq}`, pcm);
  }
  async get(takeId: string, seq: number) {
    return this.data.get(`${takeId}/${seq}`) ?? null;
  }
  async finish(takeId: string, chunks: number, frames: number) {
    const m = this.metas.get(takeId);
    if (m) Object.assign(m, { chunks, frames });
  }
  async meta(takeId: string) {
    return this.metas.get(takeId) ?? null;
  }
  async seqs(takeId: string) {
    return [...this.data.keys()].filter((k) => k.startsWith(`${takeId}/`)).map((k) => Number(k.split('/')[1])).sort((a, b) => a - b);
  }
  async inventory() {
    const out: InventoryTake[] = [];
    for (const m of this.metas.values()) out.push({ takeId: m.takeId, sampleRate: m.sampleRate, chunks: m.chunks ?? (await this.seqs(m.takeId)).length, frames: m.frames });
    return out;
  }
  async remove(takeId: string) {
    this.metas.delete(takeId);
    for (const k of [...this.data.keys()]) if (k.startsWith(`${takeId}/`)) this.data.delete(k);
  }
  takeIds() {
    return [...this.metas.keys()];
  }
}

class OpfsStore implements ChunkStore {
  readonly persistent = true;
  private metas = new Map<string, TakeMeta>();
  constructor(private root: FileSystemDirectoryHandle) {}

  static async open(key: string): Promise<OpfsStore> {
    const base = await navigator.storage.getDirectory();
    const wp = await base.getDirectoryHandle('wavepod', { create: true });
    const dir = await wp.getDirectoryHandle(key.replace(/[^\w-]+/g, '_').slice(0, 120), { create: true });
    const s = new OpfsStore(dir);
    // takes left from an earlier visit
    for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (handle.kind !== 'directory') continue;
      const meta = await s.readMeta(name);
      if (meta) s.metas.set(name, meta);
    }
    // a take the page was recording when it closed or crashed ends with the last chunk it kept
    for (const meta of s.metas.values()) if (meta.chunks === null) await s.close(meta);
    return s;
  }

  private async close(meta: TakeMeta) {
    const have = new Set(await this.seqs(meta.takeId));
    let chunks = 0;
    let frames = 0;
    for (; have.has(chunks); chunks++) {
      const f = await (await (await this.takeDir(meta.takeId)).getFileHandle(`${chunks}.pcm`)).getFile();
      frames += f.size / 3;
    }
    await this.finish(meta.takeId, chunks, frames);
  }

  private async takeDir(takeId: string, create = false) {
    return this.root.getDirectoryHandle(takeId, { create });
  }

  private async writeFile(dir: FileSystemDirectoryHandle, name: string, data: Uint8Array<ArrayBuffer> | string) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(data);
    await w.close();
  }

  private async readMeta(takeId: string): Promise<TakeMeta | null> {
    try {
      const f = await (await (await this.takeDir(takeId)).getFileHandle('meta.json')).getFile();
      return JSON.parse(await f.text()) as TakeMeta;
    } catch {
      return null;
    }
  }

  async begin(takeId: string, sampleRate: number) {
    if (this.metas.has(takeId)) return;
    const meta = { takeId, sampleRate, chunks: null, frames: null };
    this.metas.set(takeId, meta);
    await this.writeFile(await this.takeDir(takeId, true), 'meta.json', JSON.stringify(meta));
  }
  async put(takeId: string, seq: number, pcm: Uint8Array<ArrayBuffer>) {
    await this.writeFile(await this.takeDir(takeId, true), `${seq}.pcm`, pcm);
  }
  async get(takeId: string, seq: number) {
    try {
      const f = await (await (await this.takeDir(takeId)).getFileHandle(`${seq}.pcm`)).getFile();
      return new Uint8Array(await f.arrayBuffer());
    } catch {
      return null;
    }
  }
  async finish(takeId: string, chunks: number, frames: number) {
    const m = this.metas.get(takeId) ?? { takeId, sampleRate: 48000, chunks: null, frames: null };
    m.chunks = chunks;
    m.frames = frames;
    this.metas.set(takeId, m);
    await this.writeFile(await this.takeDir(takeId, true), 'meta.json', JSON.stringify(m));
  }
  async meta(takeId: string) {
    return this.metas.get(takeId) ?? (await this.readMeta(takeId));
  }
  async seqs(takeId: string) {
    const out: number[] = [];
    try {
      for await (const name of ((await this.takeDir(takeId)) as unknown as { keys(): AsyncIterable<string> }).keys()) {
        const m = /^(\d+)\.pcm$/.exec(name);
        if (m) out.push(Number(m[1]));
      }
    } catch {
      /* gone */
    }
    return out.sort((a, b) => a - b);
  }
  async inventory() {
    const out: InventoryTake[] = [];
    for (const m of this.metas.values()) out.push({ takeId: m.takeId, sampleRate: m.sampleRate, chunks: m.chunks ?? (await this.seqs(m.takeId)).length, frames: m.frames });
    return out;
  }
  async remove(takeId: string) {
    this.metas.delete(takeId);
    await this.root.removeEntry(takeId, { recursive: true }).catch(() => {});
  }
  takeIds() {
    return [...this.metas.keys()];
  }
}

export async function openChunkStore(key: string): Promise<ChunkStore> {
  try {
    if (typeof navigator.storage?.getDirectory === 'function' && typeof FileSystemFileHandle !== 'undefined' && 'createWritable' in FileSystemFileHandle.prototype) {
      void navigator.storage.persist?.();
      return await OpfsStore.open(key);
    }
  } catch {
    /* private mode or no OPFS */
  }
  return new MemoryStore();
}
