import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// One build, three pages: /golden-wheel/, /fortune-ferris/, /teen-patti/ — each loaded by the
// app in a WebView. Relative base so the bundle can be hosted under any path.
export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        goldenWheel: resolve(import.meta.dirname, 'golden-wheel/index.html'),
        fortuneFerris: resolve(import.meta.dirname, 'fortune-ferris/index.html'),
        teenPatti: resolve(import.meta.dirname, 'teen-patti/index.html'),
      },
    },
  },
});
