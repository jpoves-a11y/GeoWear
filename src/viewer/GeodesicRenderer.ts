// ============================================================
// GeoWear — GeodesicRenderer
// 3D visualization of geodesic meridians on the mesh
// ============================================================

import * as THREE from 'three';
import type { Geodesic } from '../types';
import { SceneManager } from './SceneManager';

export class GeodesicRenderer {
  private sceneManager: SceneManager;
  private geodesicGroup: THREE.Group;
  private geodesicLines: THREE.Line[] = [];
  private poleMarker: THREE.Mesh | null = null;

  constructor(sceneManager: SceneManager) {
    this.sceneManager = sceneManager;
    this.geodesicGroup = new THREE.Group();
    this.geodesicGroup.name = 'geodesics';
    this.sceneManager.scene.add(this.geodesicGroup);
  }

  /**
   * Render all geodesics as colored lines on the mesh.
   */
  renderGeodesics(
    geodesics: Geodesic[],
    groupOffset: THREE.Vector3,
    visible: boolean = true
  ): void {
    this.clear();

    for (const geo of geodesics) {
      if (geo.points.length < 2) continue;

      // Build geometry for this geodesic
      const linePoints: THREE.Vector3[] = [];
      const lineColors: number[] = [];

      for (const point of geo.points) {
        linePoints.push(
          new THREE.Vector3(
            point.position[0] + groupOffset.x,
            point.position[1] + groupOffset.y,
            point.position[2] + groupOffset.z,
          )
        );

        // Color based on deviation: green=nominal, red=bump, blue=dip
        const dev = point.deviation;
        let r: number, g: number, b: number;
        if (Math.abs(dev) <= 1) {
          // Nominal
          r = 0.2; g = 0.8; b = 0.2;
        } else if (dev > 0) {
          // Bump
          const intensity = Math.min(1, dev / 50);
          r = 0.8 + 0.2 * intensity;
          g = 0.3 * (1 - intensity);
          b = 0.1;
        } else {
          // Dip
          const intensity = Math.min(1, Math.abs(dev) / 50);
          r = 0.2 * (1 - intensity);
          g = 0.1;
          b = 0.5 + 0.5 * intensity;
        }
        lineColors.push(r, g, b);
      }

      const geometry = new THREE.BufferGeometry().setFromPoints(linePoints);
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(lineColors, 3));

      const material = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.6,
        linewidth: 1,
      });

      const line = new THREE.Line(geometry, material);
      line.name = `geodesic-${geo.angle}`;
      line.visible = visible;
      this.geodesicLines.push(line);
      this.geodesicGroup.add(line);
    }
  }

  /**
   * Render the pole marker.
   */
  renderPole(position: THREE.Vector3, groupOffset: THREE.Vector3): void {
    if (this.poleMarker) {
      this.geodesicGroup.remove(this.poleMarker);
      this.poleMarker.geometry.dispose();
    }

    const geometry = new THREE.SphereGeometry(0.3, 16, 16);
    const material = new THREE.MeshBasicMaterial({
      color: 0x00d4ff,
      transparent: true,
      opacity: 0.9,
    });
    this.poleMarker = new THREE.Mesh(geometry, material);
    this.poleMarker.position.copy(position).add(groupOffset);
    this.poleMarker.name = 'pole-marker';
    this.geodesicGroup.add(this.poleMarker);
  }

  /**
   * Highlight a specific geodesic.
   */
  highlightGeodesic(angle: number): void {
    for (const line of this.geodesicLines) {
      const lineAngle = parseFloat(line.name.replace('geodesic-', ''));
      const mat = line.material as THREE.LineBasicMaterial;
      if (Math.abs(lineAngle - angle) < 0.5) {
        mat.opacity = 1.0;
        mat.linewidth = 2;
      } else {
        mat.opacity = 0.3;
        mat.linewidth = 1;
      }
      mat.needsUpdate = true;
    }
  }

  /**
   * Reset all geodesic highlights.
   */
  resetHighlight(): void {
    for (const line of this.geodesicLines) {
      const mat = line.material as THREE.LineBasicMaterial;
      mat.opacity = 0.6;
      mat.linewidth = 1;
      mat.needsUpdate = true;
    }
  }

  /**
   * Set visibility of all geodesics.
   */
  setVisible(visible: boolean): void {
    this.geodesicGroup.visible = visible;
  }

  /**
   * Clear all geodesic visualizations.
   */
  clear(): void {
    for (const line of this.geodesicLines) {
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    }
    this.geodesicLines = [];

    while (this.geodesicGroup.children.length > 0) {
      const child = this.geodesicGroup.children[0];
      this.geodesicGroup.remove(child);
    }
  }

  dispose(): void {
    this.clear();
    this.sceneManager.scene.remove(this.geodesicGroup);
  }
}
