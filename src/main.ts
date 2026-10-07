// ============================================================
// HipWear — Main Entry Point
// ============================================================

import { App } from './app';

// Wait for DOM
document.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  app.init();

  // Expose for debugging
  (window as any).__hipwear = app;
  (window as any).__geowear = app;   // old name, kept for existing scripts
});
