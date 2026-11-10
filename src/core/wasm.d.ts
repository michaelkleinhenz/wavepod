// WebAssembly bundled as bytes (esbuild binary loader in the build, a plugin in vitest.config.ts)
declare module 'wasm-media-encoders/wasm/mp3' {
  const bytes: Uint8Array<ArrayBuffer>;
  export default bytes;
}
