// ============================================================
// GeoWear — Main Entry Point
// ============================================================

import { App } from './app';

// Wait for DOM
document.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  app.init();

  // Expose for debugging
  (window as any).__geowear = app;
});
