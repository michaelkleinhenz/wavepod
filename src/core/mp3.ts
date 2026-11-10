// MP3 export: the reference LAME 3.100 encoder as WebAssembly (from wasm-media-encoders, MIT; LAME
// itself is LGPL). The package's own wrapper only loads asynchronously, so the export worker drives
// the module's small C interface directly. The .wasm is bundled as bytes (esbuild binary loader).
//
// This replaced lamejs, a JavaScript port that is fixed to plain stereo without the bit reservoir:
// each channel got half the bitrate and the difference between left and right came out badly
// quantised, which sounds like a faint room on speech even at 128 kbps.
import wasm from 'wasm-media-encoders/wasm/mp3';

let compiled: WebAssembly.Module | null = null;

interface LameExports {
  memory: WebAssembly.Memory;
  _initialize(): void;
  malloc(size: number): number;
  free(ptr: number): void;
  enc_init(params: number): number;
  enc_get_pcm(ref: number, samples: number): number;
  enc_encode(ref: number, samples: number): number;
  enc_flush(ref: number): number;
  enc_get_out_buf(ref: number): number;
  enc_free(ref: number): void;
}

/** Constant-bitrate MP3 encoder (joint stereo for two channels, LAME's defaults otherwise). */
export class Mp3Encoder {
  private readonly lame: LameExports;
  private ref: number;

  constructor(private readonly channels: 1 | 2, sampleRate: number, kbps: number) {
    compiled ??= new WebAssembly.Module(wasm);
    const instance = new WebAssembly.Instance(compiled, {
      wasi_snapshot_preview1: { proc_exit: (code: number) => { throw new Error(`MP3 encoder exited (${code})`); } },
      env: { emscripten_notify_memory_growth: () => {} },
    });
    this.lame = instance.exports as unknown as LameExports;
    this.lame._initialize();
    // parameters: channels, input rate (uint32); bitrate, VBR quality (-1 = CBR, float), output rate (0 = same)
    const p = this.lame.malloc(20);
    if (!p) throw new Error('MP3 encoder: out of memory');
    const v = new DataView(this.lame.memory.buffer);
    v.setUint32(p, channels, true);
    v.setUint32(p + 4, sampleRate, true);
    v.setInt32(p + 8, kbps, true);
    v.setFloat32(p + 12, -1, true);
    v.setInt32(p + 16, 0, true);
    try {
      this.ref = this.lame.enc_init(p);
    } finally {
      this.lame.free(p);
    }
    if (!this.ref) throw new Error(`MP3 encoder: cannot encode ${channels} channel(s) at ${sampleRate} Hz, ${kbps} kbps`);
  }

  /** Encodes `n` frames of float samples (-1…1, one array per channel); returns a copy of the MP3 bytes. */
  encode(input: Float32Array[], n: number): Uint8Array {
    if (n <= 0) return new Uint8Array(0);
    const pcm = this.lame.enc_get_pcm(this.ref, n);
    if (!pcm) throw new Error('MP3 encoder: out of memory');
    // the buffers may move when memory grows, so views are taken after each call into the module
    const ptrs = new Int32Array(this.lame.memory.buffer, pcm, this.channels);
    for (let c = 0; c < this.channels; c++) {
      const dst = new Float32Array(this.lame.memory.buffer, ptrs[c], n);
      const src = input[c];
      for (let i = 0; i < n; i++) {
        const s = src[i];
        dst[i] = s > 1 ? 1 : s < -1 ? -1 : s;
      }
    }
    return this.output(this.lame.enc_encode(this.ref, n));
  }

  /** The last frames; the encoder is freed afterwards. */
  flush(): Uint8Array {
    const out = this.output(this.lame.enc_flush(this.ref));
    this.lame.enc_free(this.ref);
    this.ref = 0;
    return out;
  }

  private output(size: number): Uint8Array {
    if (size < 0) throw new Error(`MP3 encoder error ${size}`);
    return new Uint8Array(this.lame.memory.buffer, this.lame.enc_get_out_buf(this.ref), size).slice();
  }
}
