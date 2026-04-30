// ============================================================
// GeoWear — RimPlanePickManager
// Click-to-pick 3-D points on the inner mesh to manually define
// the rim cut-plane. Computes a best-fit plane via Newell's method.
//
// Usage:
//   manager.enable(innerMeshTHREE, camera, groupOffset)
//   manager.disable()   — exits mode, keeps accumulated points
//   manager.clear()     — removes all picked points + markers
//
// Events (set via setCallbacks):
//   onPointAdded(pts)   — fired after every click; pts = world-space points
//                         *corrected for groupOffset* (mesh-local coords)
//   onPointRemoved(pts) — fired after right-click removes last point
//   onCancel()          — fired on Escape (mode cancelled, no points kept)
// ============================================================

import * as THREE from 'three';

export interface RimPickCallbacks {
  /** Fired after each new point is added; pts are in mesh-local space. */
  onPointAdded: (pts: THREE.Vector3[]) => void;
  /** Fired when the last point is removed via right-click. */
  onPointRemoved: (pts: THREE.Vector3[]) => void;
  /** Fired on Escape key — caller should treat as cancel. */
  onCancel: () => void;
}

export class RimPlanePickManager {
  private canvas: HTMLCanvasElement;
  private camera: THREE.PerspectiveCamera | null = null;
  private innerMesh: THREE.Mesh | null = null;
  private groupOffset: THREE.Vector3 = new THREE.Vector3();
  private scene: THREE.Scene;

  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();

  /** Picked points in mesh-local coordinates (groupOffset already subtracted). */
  private points: THREE.Vector3[] = [];

  /** Sphere marker objects added to the scene. */
  private markers: THREE.Mesh[] = [];

  private active = false;
  private callbacks: RimPickCallbacks | null = null;

  // Bound handlers stored for cleanup
  private _onClick!: (e: MouseEvent) => void;
  private _onContextMenu!: (e: MouseEvent) => void;
  private _onKeyDown!: (e: KeyboardEvent) => void;

  private static MARKER_RADIUS = 0.8;
  private static MARKER_COLOR = 0xffdd00;  // yellow

  constructor(canvas: HTMLCanvasElement, scene: THREE.Scene) {
    this.canvas = canvas;
    this.scene = scene;
  }

  public setCallbacks(cb: RimPickCallbacks): void {
    this.callbacks = cb;
  }

  /**
   * Activate pick mode.
   * @param innerMesh  The THREE.Mesh of the inner cup surface for raycasting.
   * @param camera     The scene camera.
   * @param groupOffset The position offset of the mesh group (from MeshViewer.getGroupOffset()).
   */
  public enable(
    innerMesh: THREE.Mesh,
    camera: THREE.PerspectiveCamera,
    groupOffset: THREE.Vector3,
  ): void {
    this.innerMesh = innerMesh;
    this.camera = camera;
    this.groupOffset = groupOffset.clone();
    this.active = true;

    this._onClick = this.handleClick.bind(this);
    this._onContextMenu = this.handleRightClick.bind(this);
    this._onKeyDown = this.handleKeyDown.bind(this);

    this.canvas.addEventListener('click', this._onClick);
    this.canvas.addEventListener('contextmenu', this._onContextMenu);
    window.addEventListener('keydown', this._onKeyDown);
  }

  public disable(): void {
    if (!this.active) return;
    this.active = false;
    this.canvas.removeEventListener('click', this._onClick);
    this.canvas.removeEventListener('contextmenu', this._onContextMenu);
    window.removeEventListener('keydown', this._onKeyDown);
  }

  /** Remove all picked points and scene markers. */
  public clear(): void {
    this.points = [];
    for (const m of this.markers) {
      this.scene.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.markers = [];
  }

  /**
   * Remove the most recently picked point and its marker.
   * Same behaviour as a right-click — fires onPointRemoved callback.
   */
  public removeLastPoint(): void {
    if (this.points.length === 0) return;
    this.points.pop();
    const last = this.markers.pop();
    if (last) {
      this.scene.remove(last);
      last.geometry.dispose();
      (last.material as THREE.Material).dispose();
    }
    this.callbacks?.onPointRemoved(this.points.slice());
  }

  /** Get currently picked points (mesh-local coords). */
  public getPoints(): THREE.Vector3[] {
    return this.points.slice();
  }

  // ---- Private handlers ----

  private handleClick(e: MouseEvent): void {
    if (!this.active || !this.innerMesh || !this.camera) return;
    e.preventDefault();
    e.stopPropagation();

    const rect = this.canvas.getBoundingClientRect();
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);
    const hits = this.raycaster.intersectObject(this.innerMesh, false);
    if (hits.length === 0) return;

    // World-space hit → mesh-local (subtract group offset)
    const worldPt = hits[0].point.clone();
    const localPt = worldPt.clone().sub(this.groupOffset);
    this.points.push(localPt);

    // Add yellow sphere marker at the world-space position
    const markerGeo = new THREE.SphereGeometry(RimPlanePickManager.MARKER_RADIUS, 12, 8);
    const markerMat = new THREE.MeshStandardMaterial({
      color: RimPlanePickManager.MARKER_COLOR,
      emissive: 0xaa8800,
      emissiveIntensity: 0.4,
      metalness: 0.1,
      roughness: 0.5,
      depthTest: true,
    });
    const marker = new THREE.Mesh(markerGeo, markerMat);
    marker.position.copy(worldPt);
    marker.renderOrder = 8;
    this.scene.add(marker);
    this.markers.push(marker);

    this.callbacks?.onPointAdded(this.points.slice());
  }

  private handleRightClick(e: MouseEvent): void {
    if (!this.active) return;
    e.preventDefault();
    e.stopPropagation();

    if (this.points.length === 0) return;

    // Remove last point + marker
    this.points.pop();
    const last = this.markers.pop();
    if (last) {
      this.scene.remove(last);
      last.geometry.dispose();
      (last.material as THREE.Material).dispose();
    }

    this.callbacks?.onPointRemoved(this.points.slice());
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (!this.active) return;
    if (e.key === 'Escape') {
      this.callbacks?.onCancel();
    }
  }
}
