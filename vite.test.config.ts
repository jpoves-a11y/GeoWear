// Vite configuration used only by `npm test`: bundles the phantom regression tests
// (tests/phantom.test.ts) for Node, resolving the same extensionless imports as the app.
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: 'tests/phantom.test.ts',
    outDir: '.test-dist',
    emptyOutDir: true,
    target: 'node20',
    sourcemap: false,
    rollupOptions: {
      output: { format: 'es', entryFileNames: '[name].mjs' },
    },
  },
});
