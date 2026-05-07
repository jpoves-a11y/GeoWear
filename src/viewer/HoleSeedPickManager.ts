// ============================================================
// GeoWear — HoleSeedPickManager
// Click-to-seed mode: the user clicks inside large holes so that
// fillSmallBoundaryHoles can fill them even when they exceed the
// maxHoleLoopSize auto-fill limit.
//
// Usage:
//   manager.enable(innerMeshTHREE, camera, groupOffset)
//   manager.disable()   — exits mode, keeps accumulated seeds
//   manager.clear()     — removes all seeds + markers
//
// Events (set via setCallbacks):
//   onSeedsChanged(seeds)  — fired after every add/remove; seeds are mesh-local
//   onCancel()             — fired on Escape (mode cancelled, seeds NOT cleared)
// ============================================================

import * as THREE from 'three';

export interface HoleSeedCallbacks {
  /** Fired after each seed is added or removed; seeds are in mesh-local space. */
  onSeedsChanged: (seeds: THREE.Vector3[]) => void;
  /** Fired on Escape key — caller should treat as cancel. */
  onCancel: () => void;
}

export class HoleSeedPickManager {
  private canvas: HTMLCanvasElement;
  private camera: THREE.PerspectiveCamera | null = null;
  private innerMesh: THREE.Mesh | null = null;
  private groupOffset: THREE.Vector3 = new THREE.Vector3();
  private scene: THREE.Scene;

  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();

  /** Seed points in mesh-local coordinates. */
  private seeds: THREE.Vector3[] = [];

  /** Sphere marker objects added to the scene. */
  private markers: THREE.Mesh[] = [];

  private active = false;
  private callbacks: HoleSeedCallbacks | null = null;

  // Bound handlers stored for cleanup
  private _onClick!: (e: MouseEvent) => void;
  private _onContextMenu!: (e: MouseEvent) => void;
  private _onKeyDown!: (e: KeyboardEvent) => void;

  private static readonly MARKER_RADIUS = 0.5;
  private static readonly MARKER_COLOR = 0xff4400;  // red-orange

  constructor(canvas: HTMLCanvasElement, scene: THREE.Scene) {
    this.canvas = canvas;
    this.scene = scene;
  }

  public setCallbacks(cb: HoleSeedCallbacks): void {
    this.callbacks = cb;
  }

  /**
   * Activate seed pick mode.
   * @param innerMesh   The THREE.Mesh of the inner cup surface for raycasting.
   * @param camera      The scene camera.
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

  /** Remove all seeds and scene markers. */
  public clear(): void {
    this.seeds = [];
    for (const m of this.markers) {
      this.scene.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.markers = [];
  }

  /** Remove the most recently placed seed and its marker. */
  public removeLastSeed(): void {
    if (this.seeds.length === 0) return;
    this.seeds.pop();
    const last = this.markers.pop();
    if (last) {
      this.scene.remove(last);
      last.geometry.dispose();
      (last.material as THREE.Material).dispose();
    }
    this.callbacks?.onSeedsChanged(this.seeds.slice());
  }

  /** Return current seeds in mesh-local coordinates. */
  public getSeeds(): THREE.Vector3[] {
    return this.seeds.slice();
  }

  /** Number of seeds currently placed. */
  public get seedCount(): number {
    return this.seeds.length;
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
    this.seeds.push(localPt);

    // Add red-orange sphere marker at the world-space position
    const markerGeo = new THREE.SphereGeometry(HoleSeedPickManager.MARKER_RADIUS, 10, 7);
    const markerMat = new THREE.MeshStandardMaterial({
      color: HoleSeedPickManager.MARKER_COLOR,
      emissive: 0xaa2200,
      emissiveIntensity: 0.5,
      metalness: 0.1,
      roughness: 0.5,
      depthTest: true,
    });
    const marker = new THREE.Mesh(markerGeo, markerMat);
    marker.position.copy(worldPt);
    marker.renderOrder = 9;
    this.scene.add(marker);
    this.markers.push(marker);

    this.callbacks?.onSeedsChanged(this.seeds.slice());
  }

  private handleRightClick(e: MouseEvent): void {
    if (!this.active) return;
    e.preventDefault();
    e.stopPropagation();
    this.removeLastSeed();
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (!this.active) return;
    if (e.key === 'Escape') {
      this.callbacks?.onCancel();
    }
  }
}
