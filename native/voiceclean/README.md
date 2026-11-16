# Voice cleanup (WebAssembly)

The engine behind WavePod's **AI voice cleanup** filter. It splits a voice recording into three
parts and mixes them back at the levels the user picks:

- **voice**: the dry voice,
- **ambience**: what DeepFilterNet 3 says is not voice (noise, hum, traffic, background music),
- **reverb**: the late reverberation of the room, taken from both of the above with a statistical
  model (Lebart et al. 2001; Habets 2007) and a blind reverberation-time estimate from the decay
  after words.

`src/lib.rs` is the whole engine around DeepFilterNet: resampling for 44.1 and 96 kHz projects,
the room model and a small C interface (`vc_*`) that `src/core/fx/voiceClean.ts` calls. It is
compiled to `wasm32-unknown-unknown` with SIMD, so the same file runs on Linux, Windows (including
the Microsoft Store package) and macOS, needs no imports and loads synchronously in Node.

## Build

```sh
rustup target add wasm32-unknown-unknown
make voiceclean        # or: native/voiceclean/build.sh
```

This writes `voiceclean.wasm` here; it is checked in, so building WavePod does not need Rust.
`npm run build` copies it to `dist/main/`, and electron-builder puts it into the app's
`resources/` folder.

## Vendored code

`deep_filter/` is DeepFilterNet's `libDF`
(<https://github.com/Rikorose/DeepFilterNet>, `libDF/`, MIT OR Apache-2.0) with:

- `Cargo.toml` trimmed to the real-time tract runtime (no dataset, Python, CLI, C or wasm-bindgen
  parts) and tract pinned to 0.21.4, the version upstream tests with;
- `tract.rs`: `DfTract::process_mix`, which hands the time-aligned noisy and enhanced spectra to a
  callback before the inverse STFT (`process` calls it with a no-op).

`models/DeepFilterNet3_onnx.tar.gz` is upstream's model file, unchanged. It is compiled into the
module.

## Numbers

On one core of a 2.1 GHz Xeon cloud machine in Node 22: about 9 % of real time per mono channel at 48 kHz
(11 % at 44.1 kHz, which adds resampling), 0.7 s to load the model once per thread. Latency is
40 ms (1920 samples at 48 kHz, 1825 at 44.1 kHz). With all three levels at 0 dB the output equals
the input, delayed.
