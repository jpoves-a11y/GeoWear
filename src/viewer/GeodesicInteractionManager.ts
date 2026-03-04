// ============================================================
// GeoWear — GeodesicInteractionManager
// Mouse interaction for selecting geodesic sections
// ============================================================

import * as THREE from 'three';
import type { Geodesic, DoubleGeodesic, GeodesicPoint } from '../types';
import { SceneManager } from './SceneManager';

export interface GeodesicSelectionCallbacks {
  onHover: (doubleGeodesic: DoubleGeodesic | null) => void;
  onSelect: (doubleGeodesic: DoubleGeodesic) => void;
}

export class GeodesicInteractionManager {
  private sceneManager: SceneManager;
  private raycaster: THREE.Raycaster;
  private mouse: THREE.Vector2;
  private enabled: boolean = false;
  private geodesics: Geodesic[] = [];
  private doubleGeodesics: DoubleGeodesic[] = [];
  private callbacks: GeodesicSelectionCallbacks | null = null;
  
  // Invisible tube meshes for easier picking
  private pickingGroup: THREE.Group;
  private tubeToDoubleGeodesic: Map<THREE.Mesh, DoubleGeodesic> = new Map();
  
  // Hover state
  private hoveredDoubleGeodesic: DoubleGeodesic | null = null;
  
  // Offset (same as geodesic rendering offset)
  private groupOffset: THREE.Vector3 = new THREE.Vector3();

  constructor(sceneManager: SceneManager) {
    this.sceneManager = sceneManager;
    this.raycaster = new THREE.Raycaster();
    this.raycaster.params.Line = { threshold: 0.5 };
    this.mouse = new THREE.Vector2();
    
    this.pickingGroup = new THREE.Group();
    this.pickingGroup.name = 'geodesic-picking';
    this.pickingGroup.visible = false; // invisible picking helpers
    this.sceneManager.scene.add(this.pickingGroup);
    
    // Bind event handlers
    this.onMouseMove = this.onMouseMove.bind(this);
    this.onClick = this.onClick.bind(this);
  }

  /**
   * Set the geodesics and build double geodesics (pairs of opposing geodesics).
   */
  setGeodesics(geodesics: Geodesic[], offset: THREE.Vector3): void {
    this.geodesics = geodesics;
    this.groupOffset = offset.clone();
    this.buildDoubleGeodesics();
    this.buildPickingGeometry();
  }

  /**
   * Build double geodesics by pairing opposing geodesics (angle + 180°).
   */
  private buildDoubleGeodesics(): void {
    this.doubleGeodesics = [];
    const paired = new Set<number>();
    
    for (const geoA of this.geodesics) {
      if (paired.has(geoA.angle)) continue;
      
      // Find the opposing geodesic (angle + 180°)
      const oppositeAngle = (geoA.angle + 180) % 360;
      const geoB = this.geodesics.find(g => Math.abs(g.angle - oppositeAngle) < 0.5);
      
      if (geoB && !paired.has(geoB.angle)) {
        const doubleGeo = this.combineGeodesics(geoA, geoB);
        this.doubleGeodesics.push(doubleGeo);
        paired.add(geoA.angle);
        paired.add(geoB.angle);
      }
    }
  }

  /**
   * Combine two opposing geodesics into a single edge-to-edge geodesic.
   * Points go: rimA → pole → rimB
   */
  private combineGeodesics(geoA: Geodesic, geoB: Geodesic): DoubleGeodesic {
    // geoA.points are sorted pole→rim, so we need to reverse for rimA→pole
    const pointsA = [...geoA.points].reverse();
    // geoB.points are pole→rim, which is what we want after the pole
    const pointsB = [...geoB.points];
    
    // Skip the first point of geoB (it's the pole, same as last of reversed geoA)
    const combinedPoints: GeodesicPoint[] = [...pointsA];
    const poleIndex = pointsA.length - 1;
    
    // Add pointsB starting from index 1 (skip duplicate pole)
    for (let i = 1; i < pointsB.length; i++) {
      // Adjust arcLength to continue from pole
      const adjustedPoint: GeodesicPoint = {
        ...pointsB[i],
        arcLength: geoA.totalLength + pointsB[i].arcLength,
      };
      combinedPoints.push(adjustedPoint);
    }
    
    // Also adjust arcLength for pointsA (negative from pole)
    for (let i = 0; i < poleIndex; i++) {
      combinedPoints[i] = {
        ...combinedPoints[i],
        arcLength: combinedPoints[i].arcLength - geoA.totalLength,
      };
    }
    combinedPoints[poleIndex] = {
      ...combinedPoints[poleIndex],
      arcLength: 0, // pole is at 0
    };
    
    return {
      angleA: geoA.angle,
      angleB: geoB.angle,
      points: combinedPoints,
      totalLength: geoA.totalLength + geoB.totalLength,
      poleIndex,
      geodesicA: geoA,
      geodesicB: geoB,
    };
  }

  /**
   * Build invisible tube geometry for each double geodesic for mouse picking.
   */
  private buildPickingGeometry(): void {
    // Clear existing
    this.clearPickingGeometry();
    
    const tubeRadius = 0.4; // picking radius in world units
    const tubeMaterial = new THREE.MeshBasicMaterial({
      visible: false,
      side: THREE.DoubleSide,
    });
    
    for (const dg of this.doubleGeodesics) {
      if (dg.points.length < 2) continue;
      
      // Create curve from points
      const curvePoints = dg.points.map(pt => new THREE.Vector3(
        pt.position[0] + this.groupOffset.x,
        pt.position[1] + this.groupOffset.y,
        pt.position[2] + this.groupOffset.z,
      ));
      
      const curve = new THREE.CatmullRomCurve3(curvePoints, false, 'centripetal');
      const tubeGeometry = new THREE.TubeGeometry(curve, Math.min(curvePoints.length * 2, 200), tubeRadius, 6, false);
      const tubeMesh = new THREE.Mesh(tubeGeometry, tubeMaterial);
      tubeMesh.name = `picking-${dg.angleA}-${dg.angleB}`;
      
      this.tubeToDoubleGeodesic.set(tubeMesh, dg);
      this.pickingGroup.add(tubeMesh);
    }
  }

  private clearPickingGeometry(): void {
    for (const child of [...this.pickingGroup.children]) {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        this.pickingGroup.remove(child);
      }
    }
    this.tubeToDoubleGeodesic.clear();
  }

  /**
   * Enable/disable section selection mode.
   */
  setEnabled(enabled: boolean): void {
    const canvas = this.sceneManager.renderer.domElement;
    
    if (enabled && !this.enabled) {
      canvas.addEventListener('mousemove', this.onMouseMove);
      canvas.addEventListener('click', this.onClick);
      canvas.style.cursor = 'crosshair';
    } else if (!enabled && this.enabled) {
      canvas.removeEventListener('mousemove', this.onMouseMove);
      canvas.removeEventListener('click', this.onClick);
      canvas.style.cursor = 'default';
      // Clear hover state
      if (this.hoveredDoubleGeodesic && this.callbacks) {
        this.callbacks.onHover(null);
      }
      this.hoveredDoubleGeodesic = null;
    }
    
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Set callbacks for hover and selection events.
   */
  setCallbacks(callbacks: GeodesicSelectionCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * Handle mouse move - check for geodesic hover.
   */
  private onMouseMove(event: MouseEvent): void {
    if (!this.enabled) return;
    
    this.updateMouse(event);
    this.raycaster.setFromCamera(this.mouse, this.sceneManager.camera);
    
    // Enable visibility temporarily for raycasting
    this.pickingGroup.visible = true;
    const intersects = this.raycaster.intersectObjects(this.pickingGroup.children, false);
    this.pickingGroup.visible = false;
    
    let found: DoubleGeodesic | null = null;
    if (intersects.length > 0) {
      const mesh = intersects[0].object as THREE.Mesh;
      found = this.tubeToDoubleGeodesic.get(mesh) || null;
    }
    
    // Update cursor
    const canvas = this.sceneManager.renderer.domElement;
    canvas.style.cursor = found ? 'pointer' : 'crosshair';
    
    // Notify if hover state changed
    if (found !== this.hoveredDoubleGeodesic) {
      this.hoveredDoubleGeodesic = found;
      if (this.callbacks) {
        this.callbacks.onHover(found);
      }
    }
  }

  /**
   * Handle click - select geodesic.
   */
  private onClick(event: MouseEvent): void {
    if (!this.enabled) return;
    
    this.updateMouse(event);
    this.raycaster.setFromCamera(this.mouse, this.sceneManager.camera);
    
    this.pickingGroup.visible = true;
    const intersects = this.raycaster.intersectObjects(this.pickingGroup.children, false);
    this.pickingGroup.visible = false;
    
    if (intersects.length > 0) {
      const mesh = intersects[0].object as THREE.Mesh;
      const dg = this.tubeToDoubleGeodesic.get(mesh);
      if (dg && this.callbacks) {
        this.callbacks.onSelect(dg);
      }
    }
  }

  /**
   * Update normalized mouse coordinates.
   */
  private updateMouse(event: MouseEvent): void {
    const canvas = this.sceneManager.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  /**
   * Get all double geodesics.
   */
  getDoubleGeodesics(): DoubleGeodesic[] {
    return this.doubleGeodesics;
  }

  /**
   * Dispose resources.
   */
  dispose(): void {
    this.setEnabled(false);
    this.clearPickingGeometry();
    this.sceneManager.scene.remove(this.pickingGroup);
  }
}
