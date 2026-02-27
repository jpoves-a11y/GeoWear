import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  base: '/',
  build: {
    outDir: 'dist',
    target: 'es2020',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          math: ['ml-matrix'],
          export: ['jspdf', 'html2canvas'],
        },
      },
    },
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
    open: true,
  },
});
