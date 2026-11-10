import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // the user guide's Markdown pages are imported as text, as esbuild's text loader does in the build
  plugins: [
    {
      // the MP3 encoder's WebAssembly is bundled as bytes, as esbuild's binary loader does in the build
      name: 'wasm-as-bytes',
      enforce: 'pre',
      resolveId(id) {
        return id.startsWith('wasm-media-encoders/wasm/') ? createRequire(__filename).resolve(id) : null;
      },
      load(id) {
        if (!id.endsWith('.wasm')) return null;
        const b64 = readFileSync(id).toString('base64');
        return { code: `export default new Uint8Array(Buffer.from(${JSON.stringify(b64)}, 'base64'));`, map: null };
      },
    },
    {
      name: 'markdown-as-text',
      transform(code, id) {
        return id.endsWith('.md') ? { code: `export default ${JSON.stringify(code)};`, map: null } : null;
      },
    },
  ],
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // run through the plugin above instead of being loaded by Node
    server: { deps: { inline: ['wasm-media-encoders'] } },
    testTimeout: 20000,
  },
});
