// AudioWorklet processors for remote guests, used by both the WavePod window and the guest page:
//  - wp-capture: hands the input (mono) to the page in blocks, stamped with the audio clock's frame
//    (the context's own sample counter, the clock the recording and the sync are measured on);
//  - wp-play: plays mono audio the page posts to it, with a small jitter buffer.
// Built as its own file (worklets load a module by URL).

declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

class CaptureProcessor extends AudioWorkletProcessor {
  private buf: Float32Array;
  private n = 0;
  private startFrame = 0;

  constructor(options: { processorOptions?: { block?: number } }) {
    super();
    this.buf = new Float32Array(Math.max(128, options.processorOptions?.block ?? 1024));
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const frames = input?.[0]?.length ?? 128;
    if (this.n === 0) this.startFrame = currentFrame;
    for (let i = 0; i < frames; i++) {
      let v = 0;
      if (input && input.length) {
        for (const ch of input) v += ch[i];
        v /= input.length;
      }
      this.buf[this.n++] = v;
      if (this.n === this.buf.length) {
        this.port.postMessage({ samples: this.buf.slice(), frame: this.startFrame, rate: sampleRate });
        this.n = 0;
        this.startFrame = currentFrame + i + 1;
      }
    }
    return true;
  }
}

class PlayProcessor extends AudioWorkletProcessor {
  private ring = new Float32Array(Math.round(sampleRate * 2));
  private read = 0;
  private count = 0;
  private started = false;
  private readonly target = Math.round(sampleRate * 0.04);
  private readonly max = Math.round(sampleRate * 0.2);

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<Float32Array>) => this.write(e.data);
  }

  private write(s: Float32Array): void {
    const cap = this.ring.length;
    for (let i = 0; i < s.length; i++) {
      if (this.count >= this.max) {
        this.read = (this.read + 1) % cap;
        this.count--;
      }
      this.ring[(this.read + this.count) % cap] = s[i];
      this.count++;
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const frames = out[0].length;
    if (!this.started && this.count >= this.target) this.started = true;
    const cap = this.ring.length;
    for (let i = 0; i < frames; i++) {
      let v = 0;
      if (this.started && this.count > 0) {
        v = this.ring[this.read];
        this.read = (this.read + 1) % cap;
        this.count--;
      } else if (this.started) this.started = false;
      for (const ch of out) ch[i] = v;
    }
    return true;
  }
}

registerProcessor('wp-capture', CaptureProcessor);
registerProcessor('wp-play', PlayProcessor);
