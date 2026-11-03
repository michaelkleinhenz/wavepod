import type { AudioApiInfo, AudioDevice } from '../../shared/types';

export interface InputStreamOptions {
  deviceId: number;
  channels: number;
  sampleRate: number;
  frameSize: number;
  /** Interleaved float32 frames. The buffer may be reused after the call returns. */
  onData: (interleaved: Float32Array) => void;
  onError?: (message: string) => void;
}

export interface OutputStreamOptions {
  deviceId: number;
  channels: number;
  sampleRate: number;
  frameSize: number;
  /** Must return exactly frames * channels interleaved float32 samples. */
  pull: (frames: number) => Float32Array;
  onError?: (message: string) => void;
}

export interface StreamHandle {
  readonly channels: number;
  readonly sampleRate: number;
  readonly frameSize: number;
  close(): void;
}

export interface AudioBackend {
  readonly name: string;
  listApis(): AudioApiInfo[];
  /** Currently selected host API id. */
  readonly api: string;
  setApi(api: string): void;
  listDevices(): AudioDevice[];
  openInput(opts: InputStreamOptions): StreamHandle;
  openOutput(opts: OutputStreamOptions): StreamHandle;
  dispose(): void;
}
