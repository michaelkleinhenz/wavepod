import { defineConfig } from 'vitest/config';

export default defineConfig({
  // the user guide's Markdown pages are imported as text, as esbuild's text loader does in the build
  plugins: [
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
    testTimeout: 20000,
  },
});
