// Waveform data for drawing: the coarse peak levels of each file are kept whole, the finest
// peak level and raw samples are fetched in tiles around the visible range and kept in a
// size-limited LRU cache, so deep zoom works on long multitrack recordings.
import type { WaveformPeaks } from '../shared/types';
import { PEAK_TILE, SAMPLE_TILE } from '../core/peaks';

type Tile = Int8Array | Float32Array;

/** Bytes of tiles kept before the least recently used are dropped. */
const TILE_BUDGET = 48 * 1024 * 1024;
/** Tiles fetched beyond each side of the visible range, so scrolling finds them ready. */
const PREFETCH = 1;

export interface TileSource {
  getPeaks(file: string): Promise<WaveformPeaks | null>;
  getPeakTile(file: string, samplesPerPeak: number, tile: number): Promise<Int8Array | null>;
  getSampleTile(file: string, tile: number): Promise<Float32Array | null>;
}

/** Consecutive tiles covering a range; `at(i)` reads item i counted from the file start. */
export class TileSpan<T extends Tile> {
  private shift: number;
  private mask: number;

  constructor(
    private tiles: T[],
    private first: number,
    /** Items per tile, a power of two. */
    size: number,
    /** Values per item: 2 for min,max pairs, 1 for samples. */
    private stride: number,
  ) {
    this.shift = Math.log2(size);
    this.mask = size - 1;
  }

  /** Value `which` (0 = min, 1 = max for pairs) of item `i`; 0 outside the loaded tiles. */
  at(i: number, which = 0): number {
    const t = this.tiles[(i >> this.shift) - this.first];
    if (t === undefined) return 0;
    const v = t[(i & this.mask) * this.stride + which];
    return v === undefined ? 0 : v;
  }
}

export class WaveCache {
  private coarse = new Map<string, WaveformPeaks | 'loading' | null>();
  /** Insertion order is the LRU order (oldest first). */
  private tiles = new Map<string, Tile | 'loading' | null>();
  private bytes = 0;
  private generation = 0;

  constructor(
    private source: () => TileSource,
    private onLoaded: () => void,
  ) {}

  /** Drops everything, e.g. when another project is opened. */
  clear(): void {
    this.coarse.clear();
    this.tiles.clear();
    this.bytes = 0;
    this.generation++;
  }

  peaks(file: string): WaveformPeaks | null {
    const cached = this.coarse.get(file);
    if (cached === 'loading') return null;
    if (cached !== undefined) return cached;
    this.coarse.set(file, 'loading');
    const gen = this.generation;
    this.source()
      .getPeaks(file)
      .then((p) => {
        if (gen !== this.generation) return;
        this.coarse.set(file, p);
        this.onLoaded();
      })
      .catch(() => gen === this.generation && this.coarse.set(file, null));
    return null;
  }

  /** Buckets [a, b) of a tiled peak level, or null while any of them is still loading. */
  peakSpan(file: string, samplesPerPeak: number, a: number, b: number): TileSpan<Int8Array> | null {
    return this.span(`p:${samplesPerPeak}:${file}`, PEAK_TILE, 2, a, b, (tile) => this.source().getPeakTile(file, samplesPerPeak, tile));
  }

  /** Mono samples [a, b) of a file, or null while any of them is still loading. */
  sampleSpan(file: string, a: number, b: number): TileSpan<Float32Array> | null {
    return this.span(`s:${file}`, SAMPLE_TILE, 1, a, b, (tile) => this.source().getSampleTile(file, tile));
  }

  private span<T extends Tile>(prefix: string, size: number, stride: number, a: number, b: number, fetch: (tile: number) => Promise<T | null>): TileSpan<T> | null {
    const first = Math.max(0, Math.floor(a / size));
    const last = Math.max(first, Math.floor((Math.max(a, b) - 1) / size));
    const tiles: T[] = [];
    let ready = true;
    for (let t = first; t <= last; t++) {
      const tile = this.tile(prefix, t, fetch);
      if (tile === undefined) ready = false;
      else tiles.push((tile ?? new (stride === 2 ? Int8Array : Float32Array)(0)) as T);
    }
    for (let k = 1; k <= PREFETCH; k++) {
      if (first - k >= 0) this.tile(prefix, first - k, fetch);
      this.tile(prefix, last + k, fetch);
    }
    return ready ? new TileSpan(tiles, first, size, stride) : null;
  }

  /** A tile if loaded (null if unavailable), undefined while loading. */
  private tile<T extends Tile>(prefix: string, index: number, fetch: (tile: number) => Promise<T | null>): T | null | undefined {
    const key = `${prefix}#${index}`;
    const hit = this.tiles.get(key);
    if (hit === 'loading') return undefined;
    if (hit !== undefined) {
      // refresh LRU position
      this.tiles.delete(key);
      this.tiles.set(key, hit);
      return hit as T | null;
    }
    this.tiles.set(key, 'loading');
    const gen = this.generation;
    fetch(index)
      .then((t) => {
        if (gen !== this.generation) return;
        this.tiles.set(key, t);
        this.bytes += t?.byteLength ?? 0;
        this.evict();
        this.onLoaded();
      })
      .catch(() => {
        if (gen === this.generation) this.tiles.set(key, null);
      });
    return undefined;
  }

  private evict(): void {
    for (const [key, t] of this.tiles) {
      if (this.bytes <= TILE_BUDGET) break;
      if (t === 'loading') continue;
      this.bytes -= t?.byteLength ?? 0;
      this.tiles.delete(key);
    }
  }
}
