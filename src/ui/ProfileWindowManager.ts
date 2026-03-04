// ============================================================
// GeoWear — ProfileWindowManager
// Manages floating, minimizable profile windows
// ============================================================

import type { DoubleGeodesic, MeshData } from '../types';
import { ProfileChart } from './ProfileChart';

export interface ProfileWindow {
  id: string;
  doubleGeodesic: DoubleGeodesic;
  element: HTMLElement;
  chart: ProfileChart;
  isMinimized: boolean;
  position: { x: number; y: number };
}

export class ProfileWindowManager {
  private windows: Map<string, ProfileWindow> = new Map();
  private windowContainer: HTMLElement;
  private minimizedBar: HTMLElement;
  private sphereRadius: number = 0;
  private sphereCenter: [number, number, number] = [0, 0, 0];
  private outerMesh: MeshData | null = null;
  private nextWindowOffset = 0;

  constructor() {
    // Create containers if they don't exist
    this.windowContainer = document.getElementById('profile-windows-container') || this.createWindowContainer();
    this.minimizedBar = document.getElementById('minimized-windows-bar') || this.createMinimizedBar();
  }

  private createWindowContainer(): HTMLElement {
    const container = document.createElement('div');
    container.id = 'profile-windows-container';
    document.body.appendChild(container);
    return container;
  }

  private createMinimizedBar(): HTMLElement {
    const bar = document.createElement('div');
    bar.id = 'minimized-windows-bar';
    bar.className = 'minimized-windows-bar hidden';
    document.body.appendChild(bar);
    return bar;
  }

  /**
   * Set the reference sphere radius (needed for profile chart).
   */
  setSphereRadius(radius: number): void {
    this.sphereRadius = radius;
    // Update existing windows
    for (const win of this.windows.values()) {
      win.chart.setSphereRadius(radius);
    }
  }

  /**
   * Set the reference sphere center (needed for profile chart).
   */
  setSphereCenter(center: [number, number, number]): void {
    this.sphereCenter = center;
    // Update existing windows
    for (const win of this.windows.values()) {
      win.chart.setSphereCenter(center);
    }
  }

  /**
   * Set the outer mesh for real outer surface visualization.
   */
  setOuterMesh(mesh: MeshData): void {
    this.outerMesh = mesh;
    // Update existing windows
    for (const win of this.windows.values()) {
      win.chart.setOuterMesh(mesh);
    }
  }

  /**
   * Open a new profile window for a double geodesic.
   */
  openWindow(doubleGeodesic: DoubleGeodesic): ProfileWindow {
    const windowId = `profile-${doubleGeodesic.angleA}-${doubleGeodesic.angleB}`;
    
    // Check if window already exists
    const existing = this.windows.get(windowId);
    if (existing) {
      // Restore if minimized, bring to front
      if (existing.isMinimized) {
        this.restoreWindow(windowId);
      }
      this.bringToFront(existing);
      return existing;
    }

    // Create window element
    const element = this.createWindowElement(windowId, doubleGeodesic);
    this.windowContainer.appendChild(element);

    // Create chart with loading indicator
    const canvas = element.querySelector('.profile-chart-canvas') as HTMLCanvasElement;
    const loadingOverlay = element.querySelector('.profile-loading-overlay') as HTMLElement;
    const chart = new ProfileChart(canvas);
    chart.setSphereRadius(this.sphereRadius);
    chart.setSphereCenter(this.sphereCenter);
    if (this.outerMesh) {
      chart.setOuterMesh(this.outerMesh);
    }
    
    // Defer heavy processing to show window immediately with loading indicator
    setTimeout(() => {
      chart.setData(doubleGeodesic);
      if (loadingOverlay) {
        loadingOverlay.classList.add('hidden');
      }
    }, 50);

    // Calculate initial position with offset
    const offsetX = 50 + (this.nextWindowOffset % 5) * 30;
    const offsetY = 80 + (this.nextWindowOffset % 5) * 30;
    this.nextWindowOffset++;

    const profileWindow: ProfileWindow = {
      id: windowId,
      doubleGeodesic,
      element,
      chart,
      isMinimized: false,
      position: { x: offsetX, y: offsetY },
    };

    element.style.left = `${offsetX}px`;
    element.style.top = `${offsetY}px`;

    this.windows.set(windowId, profileWindow);
    this.setupWindowEvents(profileWindow);

    return profileWindow;
  }

  private createWindowElement(id: string, dg: DoubleGeodesic): HTMLElement {
    const win = document.createElement('div');
    win.className = 'profile-window';
    win.id = id;
    // Set initial size explicitly to prevent auto-resize issues
    win.style.width = '550px';
    win.style.height = '400px';
    win.innerHTML = `
      <div class="profile-window-header">
        <span class="profile-window-title">Section ${dg.angleA}° — ${dg.angleB}°</span>
        <div class="profile-window-controls">
          <button class="profile-btn-minimize" title="Minimize">−</button>
          <button class="profile-btn-close" title="Close">✕</button>
        </div>
      </div>
      <div class="profile-window-content">
        <div class="profile-loading-overlay">
          <div class="profile-loading-spinner"></div>
          <span>Computing profile...</span>
        </div>
        <canvas class="profile-chart-canvas" width="500" height="300"></canvas>
        <div class="profile-chart-controls">
          <label class="profile-checkbox">
            <input type="checkbox" class="show-sphere-checkbox" checked>
            <span>Show ideal sphere</span>
          </label>
          <button class="profile-btn-reset" title="Reset view">Reset View</button>
        </div>
      </div>
    `;
    return win;
  }

  private setupWindowEvents(win: ProfileWindow): void {
    const header = win.element.querySelector('.profile-window-header') as HTMLElement;
    const btnMinimize = win.element.querySelector('.profile-btn-minimize') as HTMLButtonElement;
    const btnClose = win.element.querySelector('.profile-btn-close') as HTMLButtonElement;
    const btnReset = win.element.querySelector('.profile-btn-reset') as HTMLButtonElement;
    const showSphereCheckbox = win.element.querySelector('.show-sphere-checkbox') as HTMLInputElement;

    // Drag to move
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let initialX = 0;
    let initialY = 0;

    header.addEventListener('mousedown', (e: MouseEvent) => {
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      isDragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      initialX = win.position.x;
      initialY = win.position.y;
      win.element.style.zIndex = '1001';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e: MouseEvent) => {
      if (!isDragging) return;
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      win.position.x = initialX + dx;
      win.position.y = initialY + dy;
      win.element.style.left = `${win.position.x}px`;
      win.element.style.top = `${win.position.y}px`;
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        win.element.style.zIndex = '1000';
      }
    });

    // Minimize button
    btnMinimize.addEventListener('click', () => {
      this.minimizeWindow(win.id);
    });

    // Close button
    btnClose.addEventListener('click', () => {
      this.closeWindow(win.id);
    });

    // Reset view button
    btnReset.addEventListener('click', () => {
      win.chart.resetView();
    });

    // Show sphere checkbox
    showSphereCheckbox.addEventListener('change', () => {
      win.chart.setShowSphere(showSphereCheckbox.checked);
    });

    // Bring to front on click
    win.element.addEventListener('mousedown', () => {
      this.bringToFront(win);
    });

    // Handle resize events with ResizeObserver (with debounce to prevent infinite loop)
    const canvas = win.element.querySelector('.profile-chart-canvas') as HTMLCanvasElement;
    let lastWidth = 0;
    let lastHeight = 0;
    let resizeTimeout: number | null = null;
    
    const resizeObserver = new ResizeObserver((entries) => {
      // Get the new size from the content rect
      const entry = entries[0];
      if (!entry) return;
      
      const rect = canvas.getBoundingClientRect();
      const newWidth = Math.floor(rect.width);
      const newHeight = Math.floor(rect.height);
      
      // Only update if size actually changed significantly (avoid loop)
      if (Math.abs(newWidth - lastWidth) < 2 && Math.abs(newHeight - lastHeight) < 2) return;
      if (newWidth < 100 || newHeight < 100) return;
      
      // Debounce the resize
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }
      
      resizeTimeout = window.setTimeout(() => {
        lastWidth = newWidth;
        lastHeight = newHeight;
        canvas.width = newWidth * window.devicePixelRatio;
        canvas.height = newHeight * window.devicePixelRatio;
        win.chart.render();
      }, 50);
    });
    
    // Only observe the window element, not content
    resizeObserver.observe(win.element);
    
    // Initialize canvas size immediately
    const initialRect = canvas.getBoundingClientRect();
    if (initialRect.width > 100 && initialRect.height > 100) {
      lastWidth = Math.floor(initialRect.width);
      lastHeight = Math.floor(initialRect.height);
      canvas.width = lastWidth * window.devicePixelRatio;
      canvas.height = lastHeight * window.devicePixelRatio;
    }
  }

  private bringToFront(win: ProfileWindow): void {
    // Reset all z-indices
    for (const w of this.windows.values()) {
      if (!w.isMinimized) {
        w.element.style.zIndex = '1000';
      }
    }
    win.element.style.zIndex = '1001';
  }

  /**
   * Minimize a window to the bottom bar.
   */
  minimizeWindow(windowId: string): void {
    const win = this.windows.get(windowId);
    if (!win || win.isMinimized) return;

    win.isMinimized = true;
    win.element.classList.add('hidden');

    // Create minimized tab
    const tab = document.createElement('div');
    tab.className = 'minimized-tab';
    tab.id = `min-tab-${windowId}`;
    tab.innerHTML = `
      <span>${win.doubleGeodesic.angleA}°—${win.doubleGeodesic.angleB}°</span>
      <button class="min-tab-close" title="Close">✕</button>
    `;
    
    tab.querySelector('span')!.addEventListener('click', () => {
      this.restoreWindow(windowId);
    });
    
    tab.querySelector('.min-tab-close')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeWindow(windowId);
    });

    this.minimizedBar.appendChild(tab);
    this.updateMinimizedBarVisibility();
  }

  /**
   * Restore a minimized window.
   */
  restoreWindow(windowId: string): void {
    const win = this.windows.get(windowId);
    if (!win || !win.isMinimized) return;

    win.isMinimized = false;
    win.element.classList.remove('hidden');

    // Remove minimized tab
    const tab = document.getElementById(`min-tab-${windowId}`);
    if (tab) {
      tab.remove();
    }

    this.updateMinimizedBarVisibility();
    this.bringToFront(win);
    
    // Redraw chart (in case canvas was invalidated)
    win.chart.render();
  }

  /**
   * Close a window completely.
   */
  closeWindow(windowId: string): void {
    const win = this.windows.get(windowId);
    if (!win) return;

    // Remove minimized tab if exists
    const tab = document.getElementById(`min-tab-${windowId}`);
    if (tab) {
      tab.remove();
    }

    // Remove window element
    win.element.remove();
    win.chart.dispose();
    
    this.windows.delete(windowId);
    this.updateMinimizedBarVisibility();
  }

  /**
   * Close all windows.
   */
  closeAll(): void {
    for (const windowId of [...this.windows.keys()]) {
      this.closeWindow(windowId);
    }
  }

  private updateMinimizedBarVisibility(): void {
    const hasMinimized = Array.from(this.windows.values()).some(w => w.isMinimized);
    this.minimizedBar.classList.toggle('hidden', !hasMinimized);
  }

  /**
   * Check if a specific geodesic profile is already open.
   */
  hasWindow(angleA: number, angleB: number): boolean {
    const id = `profile-${angleA}-${angleB}`;
    return this.windows.has(id);
  }
}
