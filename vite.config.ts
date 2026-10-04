import { defineConfig } from 'vitest/config';

export default defineConfig({
  // relative base so the build can be hosted from any sub-path (e.g. GitHub Pages, or inside Lemonat later)
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
