// The user guide's Markdown files are bundled as text (esbuild's text loader, a Vite plugin in tests).
declare module '*.md' {
  const text: string;
  export default text;
}
