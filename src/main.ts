// ============================================================
// GeoWear — Main Entry Point
// ============================================================

import 'lil-gui/dist/lil-gui.css';
import { App } from './app';

// Wait for DOM
document.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  app.init();

  // Expose for debugging
  (window as any).__geowear = app;
});
