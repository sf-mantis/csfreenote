import { defineConfig } from 'vite';

export default defineConfig({
  // Electron loads dist/index.html from disk, so assets must be referenced relatively.
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
