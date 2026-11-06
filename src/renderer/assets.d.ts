// esbuild inlines imported SVGs as data: URLs (see scripts/build.mjs).
declare module '*.svg' {
  const url: string;
  export default url;
}
