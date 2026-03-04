// ============================================================
// GeoWear — GeodesicRenderer
// 3D visualization of geodesic meridians on the mesh
// Per-point irregularity coloring + markers at irregular peaks
// ============================================================

import * as THREE from 'three';
import type { Geodesic } from '../types';
import { SceneManager } from './SceneManager';

export class GeodesicRenderer {
  private sceneManager: SceneManager;
  private geodesicGroup: THREE.Group;
  private geodesicLines: THREE.Line[] = [];
  private lineRegularity: boolean[] = [];
  private poleMarker: THREE.Mesh | null = null;
  private irregularityMarkers: THREE.Mesh[] = [];
  private curvatureThreshold = 0;

  // Shared geometries / materials for irregularity markers
  private static markerGeo: THREE.SphereGeometry | null = null;
  private static markerMat: THREE.MeshBasicMaterial | null = null;

  constructor(sceneManager: SceneManager) {
    this.sceneManager = sceneManager;
    this.geodesicGroup = new THREE.Group();
    this.geodesicGroup.name = 'geodesics';
    this.sceneManager.scene.add(this.geodesicGroup);
  }

  /**
   * Render all geodesics with per-point irregularity coloring.
   *
   * Each vertex of every geodesic is colored individually:
   *   - Regular points → green
   *   - Irregular points (|secondDerivative| > curvatureThreshold) → orange-red
   *     with intensity proportional to severity
   *
   * Additionally, red sphere markers are placed at local peaks
   * of irregular segments.
   */
  renderGeodesics(
    geodesics: Geodesic[],
    groupOffset: THREE.Vector3,
    visible: boolean = true,
    curvatureThreshold: number = 0
  ): void {
    this.clear();
    this.curvatureThreshold = curvatureThreshold;

    // Lazily create shared marker geometry / material
    if (!GeodesicRenderer.markerGeo) {
      GeodesicRenderer.markerGeo = new THREE.SphereGeometry(0.18, 8, 8);
    }
    if (!GeodesicRenderer.markerMat) {
      GeodesicRenderer.markerMat = new THREE.MeshBasicMaterial({
        color: 0xff2222,
        transparent: true,
        opacity: 0.85,
      });
    }

    for (const geo of geodesics) {
      if (geo.points.length < 2) continue;

      const linePoints: THREE.Vector3[] = [];
      const lineColors: number[] = [];

      // ----- per-point coloring -----
      for (const pt of geo.points) {
        const pos = new THREE.Vector3(
          pt.position[0] + groupOffset.x,
          pt.position[1] + groupOffset.y,
          pt.position[2] + groupOffset.z,
        );
        linePoints.push(pos);

        const absD2 = Math.abs(pt.secondDerivative);
        const isIrregular = curvatureThreshold > 0 && absD2 > curvatureThreshold;

        let r: number, g: number, b: number;
        if (isIrregular) {
          // severity ∈ [0,1] clamped
          const severity = Math.min((absD2 - curvatureThreshold) / curvatureThreshold, 1);
          // Gradient from orange (low severity) to red (high severity)
          r = 0.95;
          g = 0.35 * (1 - severity);
          b = 0.05;
        } else {
          r = 0.1; g = 0.75; b = 0.2;
        }
        lineColors.push(r, g, b);
      }

      // ----- irregularity peak markers -----
      // Walk through points and find local-max |d2| within each irregular run
      if (curvatureThreshold > 0) {
        let inIrregular = false;
        let peakIdx = -1;
        let peakVal = 0;

        for (let i = 0; i < geo.points.length; i++) {
          const absD2 = Math.abs(geo.points[i].secondDerivative);
          const isIrr = absD2 > curvatureThreshold;

          if (isIrr) {
            if (!inIrregular) {
              inIrregular = true;
              peakIdx = i;
              peakVal = absD2;
            } else if (absD2 > peakVal) {
              peakIdx = i;
              peakVal = absD2;
            }
          }

          // End of irregular run (or end of array)
          if (inIrregular && (!isIrr || i === geo.points.length - 1)) {
            // place marker at peakIdx
            const marker = new THREE.Mesh(
              GeodesicRenderer.markerGeo!,
              GeodesicRenderer.markerMat!,
            );
            marker.position.copy(linePoints[peakIdx]);
            marker.name = 'irregularity-marker';
            this.irregularityMarkers.push(marker);
            this.geodesicGroup.add(marker);

            if (!isIrr) inIrregular = false;
          }
        }
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
      this.lineRegularity.push(geo.isRegular);
      this.geodesicGroup.add(line);
    }
  }

  /**
   * Render geodesics in batches to avoid UI freezing.
   * Processes BATCH_SIZE geodesics at a time, yielding between batches.
   */
  async renderGeodesicsAsync(
    geodesics: Geodesic[],
    groupOffset: THREE.Vector3,
    visible: boolean = true,
    curvatureThreshold: number = 0,
    onProgress?: (progress: number) => void
  ): Promise<void> {
    this.clear();
    this.curvatureThreshold = curvatureThreshold;

    const BATCH_SIZE = 6; // Process 6 geodesics per batch
    const total = geodesics.length;

    // Lazily create shared marker geometry / material
    if (!GeodesicRenderer.markerGeo) {
      GeodesicRenderer.markerGeo = new THREE.SphereGeometry(0.18, 8, 8);
    }
    if (!GeodesicRenderer.markerMat) {
      GeodesicRenderer.markerMat = new THREE.MeshBasicMaterial({
        color: 0xff2222,
        transparent: true,
        opacity: 0.85,
      });
    }

    for (let batch = 0; batch < total; batch += BATCH_SIZE) {
      const endIdx = Math.min(batch + BATCH_SIZE, total);
      
      for (let idx = batch; idx < endIdx; idx++) {
        const geo = geodesics[idx];
        if (geo.points.length < 2) continue;

        const linePoints: THREE.Vector3[] = [];
        const lineColors: number[] = [];

        for (const pt of geo.points) {
          const pos = new THREE.Vector3(
            pt.position[0] + groupOffset.x,
            pt.position[1] + groupOffset.y,
            pt.position[2] + groupOffset.z,
          );
          linePoints.push(pos);

          const absD2 = Math.abs(pt.secondDerivative);
          const isIrregular = curvatureThreshold > 0 && absD2 > curvatureThreshold;

          let r: number, g: number, b: number;
          if (isIrregular) {
            const severity = Math.min((absD2 - curvatureThreshold) / curvatureThreshold, 1);
            r = 0.95;
            g = 0.35 * (1 - severity);
            b = 0.05;
          } else {
            r = 0.1; g = 0.75; b = 0.2;
          }
          lineColors.push(r, g, b);
        }

        // Irregularity peak markers
        if (curvatureThreshold > 0) {
          let inIrregular = false;
          let peakIdx = -1;
          let peakVal = 0;

          for (let i = 0; i < geo.points.length; i++) {
            const absD2 = Math.abs(geo.points[i].secondDerivative);
            const isIrr = absD2 > curvatureThreshold;

            if (isIrr) {
              if (!inIrregular) {
                inIrregular = true;
                peakIdx = i;
                peakVal = absD2;
              } else if (absD2 > peakVal) {
                peakIdx = i;
                peakVal = absD2;
              }
            }

            if (inIrregular && (!isIrr || i === geo.points.length - 1)) {
              const marker = new THREE.Mesh(
                GeodesicRenderer.markerGeo!,
                GeodesicRenderer.markerMat!,
              );
              marker.position.copy(linePoints[peakIdx]);
              marker.name = 'irregularity-marker';
              this.irregularityMarkers.push(marker);
              this.geodesicGroup.add(marker);

              if (!isIrr) inIrregular = false;
            }
          }
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
        this.lineRegularity.push(geo.isRegular);
        this.geodesicGroup.add(line);
      }

      // Report progress and yield to UI
      if (onProgress) {
        onProgress(endIdx / total);
      }
      
      // Yield to allow UI updates
      await new Promise<void>(r => setTimeout(r, 0));
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
      color: 0x0077cc,
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
   * Highlight a double geodesic (pair of opposing geodesics).
   * Both geodesics in the pair are highlighted, others dimmed.
   */
  highlightDoubleGeodesic(angleA: number, angleB: number): void {
    for (const line of this.geodesicLines) {
      const lineAngle = parseFloat(line.name.replace('geodesic-', ''));
      const mat = line.material as THREE.LineBasicMaterial;
      
      const isMatch = Math.abs(lineAngle - angleA) < 0.5 || Math.abs(lineAngle - angleB) < 0.5;
      
      if (isMatch) {
        mat.opacity = 1.0;
        mat.linewidth = 3;
      } else {
        mat.opacity = 0.15;
        mat.linewidth = 1;
      }
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
   * Set display mode: 'all', 'regular', 'irregular', or 'none'.
   * Also controls irregularity marker visibility.
   */
  setDisplayMode(mode: string): void {
    if (mode === 'none') {
      this.geodesicGroup.visible = false;
      return;
    }
    this.geodesicGroup.visible = true;

    const showIrregular = mode === 'all' || mode === 'irregular';

    for (let i = 0; i < this.geodesicLines.length; i++) {
      const isRegular = this.lineRegularity[i] ?? true;
      switch (mode) {
        case 'regular':
          this.geodesicLines[i].visible = isRegular;
          break;
        case 'irregular':
          this.geodesicLines[i].visible = !isRegular;
          break;
        default: // 'all'
          this.geodesicLines[i].visible = true;
          break;
      }
    }

    // Show/hide irregularity markers based on mode
    for (const marker of this.irregularityMarkers) {
      marker.visible = showIrregular;
    }

    if (this.poleMarker) {
      this.poleMarker.visible = true;
    }
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
    this.lineRegularity = [];

    // Markers share geometry/material — don't dispose shared resources
    this.irregularityMarkers = [];

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
