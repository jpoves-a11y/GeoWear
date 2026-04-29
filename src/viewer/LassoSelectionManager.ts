// ============================================================
// GeoWear — LassoSelectionManager
// Canvas-overlay polygon lasso for excluding anomalous vertices
// from all analysis algorithms.
//
// Usage:
//   manager.enable(innerMesh, camera, groupOffset)
//   - draws a polygon on a 2D canvas overlaid on the WebGL canvas
//   - on close: tests each vertex against polygon (only front-facing)
//   - calls onSelectionComplete(Set<number>) with excluded vertex indices
//   manager.disable()  — cancel / deactivate without applying
//   manager.clearAll() — remove overlay visuals
// ============================================================

import * as THREE from 'three';
import type { MeshData } from '../types';

export interface LassoCallbacks {
  /** Called when the user closes the lasso polygon. Provides new vertex indices to exclude. */
  onSelectionComplete: (newExcluded: Set<number>) => void;
}

/** Screen-space point [x, y] in CSS pixels */
type Point2D = [number, number];

export class LassoSelectionManager {
  private canvas2d: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  // Lasso polygon vertices in CSS pixel space
  private polygon: Point2D[] = [];
  private active = false;

  // Bound event handlers (kept for removal)
  private onPointerDown!: (e: PointerEvent) => void;
  private onPointerMove!: (e: PointerEvent) => void;
  private onKeyDown!: (e: KeyboardEvent) => void;

  // Reference to the WebGL canvas (for coordinate conversion)
  private webglCanvas: HTMLCanvasElement;

  // Current analysis mesh data + Three.js camera + group offset
  private innerMesh: MeshData | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private groupOffset: THREE.Vector3 = new THREE.Vector3();

  private callbacks: LassoCallbacks | null = null;

  /** Minimum distance in CSS pixels to the first vertex to close the polygon */
  private readonly CLOSE_DISTANCE = 15;

  constructor(webglCanvas: HTMLCanvasElement) {
    this.webglCanvas = webglCanvas;

    // Create and size the overlay canvas
    this.canvas2d = document.createElement('canvas');
    this.canvas2d.style.position = 'absolute';
    this.canvas2d.style.top = '0';
    this.canvas2d.style.left = '0';
    this.canvas2d.style.pointerEvents = 'none'; // inactive by default
    this.canvas2d.style.zIndex = '50';
    this.canvas2d.style.cursor = 'crosshair';

    // Insert right after the WebGL canvas
    webglCanvas.parentElement?.appendChild(this.canvas2d);

    this.ctx = this.canvas2d.getContext('2d')!;

    // Keep the overlay sized to match the WebGL canvas
    const ro = new ResizeObserver(() => this.syncCanvasSize());
    ro.observe(webglCanvas);
    this.syncCanvasSize();
  }

  public setCallbacks(callbacks: LassoCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * Activate lasso mode. Calling code is responsible for disabling
   * orbit controls while this is active.
   */
  public enable(
    innerMesh: MeshData,
    camera: THREE.PerspectiveCamera,
    groupOffset: THREE.Vector3,
  ): void {
    this.innerMesh = innerMesh;
    this.camera = camera;
    this.groupOffset = groupOffset.clone();

    this.polygon = [];
    this.active = true;

    // Make overlay interactive
    this.canvas2d.style.pointerEvents = 'all';
    this.canvas2d.style.cursor = 'crosshair';

    // Bind and attach event listeners
    this.onPointerDown = this.handlePointerDown.bind(this);
    this.onPointerMove = this.handlePointerMove.bind(this);
    this.onKeyDown = this.handleKeyDown.bind(this);

    this.canvas2d.addEventListener('pointerdown', this.onPointerDown);
    this.canvas2d.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('keydown', this.onKeyDown);

    this.redraw();
  }

  /** Deactivate without applying selection */
  public disable(): void {
    if (!this.active) return;
    this.active = false;
    this.canvas2d.style.pointerEvents = 'none';
    this.canvas2d.style.cursor = 'default';
    this.canvas2d.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas2d.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('keydown', this.onKeyDown);
    this.polygon = [];
    this.redraw();
  }

  /** True while lasso drawing mode is on */
  public get isActive(): boolean {
    return this.active;
  }

  // ---- Event handlers ----

  private handlePointerDown(e: PointerEvent): void {
    if (!this.active) return;
    e.preventDefault();

    const pt: Point2D = [e.offsetX, e.offsetY];

    // Check if close to first vertex → close polygon
    if (this.polygon.length >= 3) {
      const [fx, fy] = this.polygon[0];
      const dx = pt[0] - fx;
      const dy = pt[1] - fy;
      if (Math.sqrt(dx * dx + dy * dy) <= this.CLOSE_DISTANCE) {
        this.closePolygon();
        return;
      }
    }

    this.polygon.push(pt);
    this.redraw();
  }

  private handlePointerMove(e: PointerEvent): void {
    if (!this.active || this.polygon.length === 0) return;
    // Redraw with a preview line to the current mouse position
    this.redraw([e.offsetX, e.offsetY]);
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (!this.active) return;
    if (e.key === 'Escape') {
      this.disable();
      return;
    }
    if (e.key === 'Enter' && this.polygon.length >= 3) {
      this.closePolygon();
    }
  }

  // ---- Polygon drawing ----

  private redraw(mousePt?: Point2D): void {
    const w = this.canvas2d.width;
    const h = this.canvas2d.height;
    this.ctx.clearRect(0, 0, w, h);

    if (this.polygon.length === 0) return;

    this.ctx.save();

    // Semi-transparent fill
    this.ctx.beginPath();
    this.ctx.moveTo(this.polygon[0][0], this.polygon[0][1]);
    for (let i = 1; i < this.polygon.length; i++) {
      this.ctx.lineTo(this.polygon[i][0], this.polygon[i][1]);
    }
    if (mousePt) this.ctx.lineTo(mousePt[0], mousePt[1]);
    this.ctx.closePath();
    this.ctx.fillStyle = 'rgba(255, 60, 60, 0.12)';
    this.ctx.fill();

    // Stroke
    this.ctx.beginPath();
    this.ctx.moveTo(this.polygon[0][0], this.polygon[0][1]);
    for (let i = 1; i < this.polygon.length; i++) {
      this.ctx.lineTo(this.polygon[i][0], this.polygon[i][1]);
    }
    if (mousePt) this.ctx.lineTo(mousePt[0], mousePt[1]);
    this.ctx.strokeStyle = 'rgba(220, 30, 30, 0.9)';
    this.ctx.lineWidth = 1.5;
    this.ctx.setLineDash([4, 3]);
    this.ctx.stroke();

    // First vertex marker (close zone indicator)
    const [fx, fy] = this.polygon[0];
    this.ctx.beginPath();
    this.ctx.arc(fx, fy, this.CLOSE_DISTANCE / 2, 0, Math.PI * 2);
    this.ctx.fillStyle = 'rgba(220, 30, 30, 0.5)';
    this.ctx.fill();

    // Vertex dots
    this.ctx.setLineDash([]);
    for (const [px, py] of this.polygon) {
      this.ctx.beginPath();
      this.ctx.arc(px, py, 3, 0, Math.PI * 2);
      this.ctx.fillStyle = 'rgba(220, 30, 30, 0.85)';
      this.ctx.fill();
    }

    this.ctx.restore();
  }

  // ---- Selection computation ----

  private closePolygon(): void {
    if (!this.innerMesh || !this.camera || this.polygon.length < 3) {
      this.disable();
      return;
    }

    const excluded = this.computeExcludedVertices();
    this.disable(); // clears overlay + event listeners

    if (this.callbacks && excluded.size > 0) {
      this.callbacks.onSelectionComplete(excluded);
    }
  }

  /**
   * Project every vertex of innerMesh to screen space and test against the
   * lasso polygon. Only front-facing vertices (normal dot camera direction > 0)
   * are eligible for exclusion.
   */
  private computeExcludedVertices(): Set<number> {
    const excluded = new Set<number>();
    if (!this.innerMesh || !this.camera) return excluded;

    const { positions, normals, vertexCount } = this.innerMesh;
    const cw = this.canvas2d.width;
    const ch = this.canvas2d.height;

    // World→NDC matrix (projection × view)
    const projViewMatrix = new THREE.Matrix4()
      .multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);

    // Camera-forward vector in world space (points away from camera)
    const camDir = new THREE.Vector3();
    this.camera.getWorldDirection(camDir); // already normalized

    const worldPos = new THREE.Vector3();
    const worldNorm = new THREE.Vector3();
    const ndcPos = new THREE.Vector3();

    for (let i = 0; i < vertexCount; i++) {
      // World position (apply group offset)
      worldPos.set(
        positions[i * 3]     + this.groupOffset.x,
        positions[i * 3 + 1] + this.groupOffset.y,
        positions[i * 3 + 2] + this.groupOffset.z,
      );

      // Project to NDC
      ndcPos.copy(worldPos).applyMatrix4(projViewMatrix);

      // Discard if outside frustum
      if (ndcPos.z < -1 || ndcPos.z > 1) continue;
      if (Math.abs(ndcPos.x) > 1.05 || Math.abs(ndcPos.y) > 1.05) continue;

      // Convert NDC → CSS pixel coordinates
      const sx = (ndcPos.x + 1) * 0.5 * cw;
      const sy = (1 - ndcPos.y) * 0.5 * ch;

      // Front-face test: vertex normal vs camera direction
      // Normal is in mesh-local space (no rotation applied to group), so use as-is
      worldNorm.set(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]).normalize();
      if (worldNorm.dot(camDir) >= 0) continue; // back-facing (normal points away)

      // Point-in-polygon test (ray casting)
      if (this.pointInPolygon(sx, sy)) {
        excluded.add(i);
      }
    }

    return excluded;
  }

  /**
   * Ray-casting point-in-polygon test.
   * @returns true if (px, py) is inside the polygon
   */
  private pointInPolygon(px: number, py: number): boolean {
    const poly = this.polygon;
    const n = poly.length;
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      const intersect =
        yi > py !== yj > py &&
        px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  // ---- Utilities ----

  private syncCanvasSize(): void {
    const rect = this.webglCanvas.getBoundingClientRect();
    this.canvas2d.width = rect.width;
    this.canvas2d.height = rect.height;
    this.canvas2d.style.width = `${rect.width}px`;
    this.canvas2d.style.height = `${rect.height}px`;
    this.redraw();
  }

  /** Remove the canvas overlay from the DOM entirely */
  public destroy(): void {
    this.disable();
    this.canvas2d.remove();
  }
}
