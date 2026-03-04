// ============================================================
// GeoWear — Annotations & WearVector Visualization
// CSS2D annotation labels and wear direction arrow
// ============================================================

import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { AnomalyCluster } from '../types';
import { SceneManager } from './SceneManager';

export class AnnotationManager {
  private sceneManager: SceneManager;
  private annotationGroup: THREE.Group;
  private annotations: CSS2DObject[] = [];
  private wearArrow: THREE.ArrowHelper | null = null;
  private wearLine: THREE.Line | null = null;

  constructor(sceneManager: SceneManager) {
    this.sceneManager = sceneManager;
    this.annotationGroup = new THREE.Group();
    this.annotationGroup.name = 'annotations';
    this.sceneManager.scene.add(this.annotationGroup);
  }

  /**
   * Add annotations for anomaly clusters.
   * Optimized: only processes clusters, uses cluster's own maxDeviationPoint.
   */
  addClusterAnnotations(
    clusters: AnomalyCluster[],
    groupOffset: THREE.Vector3,
    meshPositions?: Float32Array,
    vertexDeviations?: Float32Array
  ): void {
    this.clearAnnotations();

    // Pre-compute actual max bump / min dip vertex positions from full mesh
    // Optimized: only iterate once if needed, and only for the two global labels
    let globalMaxBumpPos: THREE.Vector3 | null = null;
    let globalMaxDipPos: THREE.Vector3 | null = null;

    if (meshPositions && vertexDeviations) {
      // Sample every 10th vertex for performance on large meshes
      // This gives a good approximation while being 10x faster
      let maxBump = -Infinity;
      let minDip = Infinity;
      const vertexCount = vertexDeviations.length;
      const stride = Math.max(1, Math.floor(vertexCount / 50000)); // Max ~50k samples
      
      for (let i = 0; i < vertexCount; i += stride) {
        const d = vertexDeviations[i];
        if (d > maxBump) {
          maxBump = d;
          globalMaxBumpPos = new THREE.Vector3(
            meshPositions[i * 3],
            meshPositions[i * 3 + 1],
            meshPositions[i * 3 + 2]
          );
        }
        if (d < minDip) {
          minDip = d;
          globalMaxDipPos = new THREE.Vector3(
            meshPositions[i * 3],
            meshPositions[i * 3 + 1],
            meshPositions[i * 3 + 2]
          );
        }
      }
    }

    for (const cluster of clusters) {
      // Choose position: use global max/min vertex if available
      let labelPos: THREE.Vector3;
      if (cluster.type === 'bump' && globalMaxBumpPos) {
        labelPos = globalMaxBumpPos;
      } else if (cluster.type === 'dip' && globalMaxDipPos) {
        labelPos = globalMaxDipPos;
      } else {
        labelPos = cluster.maxDeviationPoint;
      }

      const label = this.createLabel(cluster, groupOffset, labelPos);
      this.annotations.push(label);
      this.annotationGroup.add(label);
    }
  }

  /**
   * Add pole annotation.
   */
  addPoleAnnotation(position: THREE.Vector3, groupOffset: THREE.Vector3): void {
    const div = document.createElement('div');
    div.className = 'annotation-label pole';
    div.textContent = '⊕ Pole';

    const label = new CSS2DObject(div);
    label.position.copy(position).add(groupOffset);
    label.position.y += 0.5;
    this.annotations.push(label);
    this.annotationGroup.add(label);
  }

  /**
   * Create a CSS2D label for a cluster.
   */
  private createLabel(cluster: AnomalyCluster, groupOffset: THREE.Vector3, position?: THREE.Vector3): CSS2DObject {
    const div = document.createElement('div');
    div.className = `annotation-label ${cluster.type}`;

    const isBump = cluster.type === 'bump';
    const icon = isBump ? '▲' : '▼';
    const typeLabel = isBump ? 'Wear' : 'Dip';
    const devStr = isBump
      ? `+${cluster.maxDeviation.toFixed(1)}`
      : `${cluster.minDeviation.toFixed(1)}`;

    div.innerHTML = `
      <span class="cluster-type">${typeLabel}</span>
      <span>${icon} ${devStr} μm</span>
    `;

    div.title = `${typeLabel} Region #${cluster.id + 1}\n` +
      `Max deviation: ${devStr} μm\n` +
      `Area: ${cluster.area.toFixed(2)} mm²\n` +
      `Volume: ${cluster.volume.toFixed(4)} mm³\n` +
      `Points: ${cluster.points.length}`;

    // Make clickable
    div.style.pointerEvents = 'auto';
    div.style.cursor = 'pointer';
    div.addEventListener('click', () => {
      this.sceneManager.controls.target.copy(
        cluster.centroid.clone().add(groupOffset)
      );
      this.sceneManager.controls.update();
    });

    const label = new CSS2DObject(div);
    // Position at the provided position (global max) or fallback to cluster max
    const pos = position || cluster.maxDeviationPoint;
    label.position.copy(pos).add(groupOffset);
    label.position.y += 0.3; // slight offset above surface
    return label;
  }

  /**
   * Render the wear vector: arrow from pole to most-worn point.
   */
  renderWearVector(
    deepestPoint: THREE.Vector3,
    polePoint: THREE.Vector3,
    groupOffset: THREE.Vector3,
    maxDepth: number,
    angle: number
  ): void {
    this.clearWearVector();

    const start = polePoint.clone().add(groupOffset);  // starts at pole
    const end = deepestPoint.clone().add(groupOffset);  // ends at wear point

    // Dashed line
    const points = [start, end];
    const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
    const lineMat = new THREE.LineDashedMaterial({
      color: 0xff6644,
      dashSize: 0.5,
      gapSize: 0.2,
      linewidth: 2,
    });
    this.wearLine = new THREE.Line(lineGeo, lineMat);
    this.wearLine.computeLineDistances();
    this.wearLine.name = 'wear-line';
    this.annotationGroup.add(this.wearLine);

    // Arrow from pole toward wear point
    const direction = end.clone().sub(start).normalize();
    const length = start.distanceTo(end);
    this.wearArrow = new THREE.ArrowHelper(
      direction, start, length,
      0xff6644, // color
      0.8,       // head length
      0.4        // head width
    );
    this.wearArrow.name = 'wear-arrow';
    this.annotationGroup.add(this.wearArrow);

    // Label at midpoint
    const midpoint = start.clone().lerp(end, 0.5);
    const div = document.createElement('div');
    div.className = 'annotation-label dip';
    div.innerHTML = `
      <strong>Wear Vector</strong><br/>
      Depth: ${maxDepth.toFixed(1)} μm<br/>
      Angle: ${angle.toFixed(1)}°
    `;
    div.style.pointerEvents = 'auto';

    const label = new CSS2DObject(div);
    label.position.copy(midpoint);
    label.position.y += 1;
    this.annotations.push(label);
    this.annotationGroup.add(label);

    // Deepest point marker (red sphere)
    const markerGeo = new THREE.SphereGeometry(0.4, 16, 16);
    const markerMat = new THREE.MeshBasicMaterial({ color: 0xff2222 });
    const marker = new THREE.Mesh(markerGeo, markerMat);
    marker.position.copy(start);
    marker.name = 'deepest-point-marker';
    this.annotationGroup.add(marker);
  }

  /**
   * Set visibility of all annotations.
   */
  setVisible(visible: boolean): void {
    this.annotationGroup.visible = visible;
  }

  /**
   * Clear all annotations.
   */
  clearAnnotations(): void {
    for (const anno of this.annotations) {
      if (anno.element && anno.element.parentNode) {
        anno.element.parentNode.removeChild(anno.element);
      }
      this.annotationGroup.remove(anno);
    }
    this.annotations = [];
  }

  /**
   * Clear wear vector visualization.
   */
  clearWearVector(): void {
    if (this.wearLine) {
      this.wearLine.geometry.dispose();
      (this.wearLine.material as THREE.Material).dispose();
      this.annotationGroup.remove(this.wearLine);
      this.wearLine = null;
    }
    if (this.wearArrow) {
      this.annotationGroup.remove(this.wearArrow);
      this.wearArrow = null;
    }

    // Remove deepest point marker
    const marker = this.annotationGroup.getObjectByName('deepest-point-marker');
    if (marker) {
      this.annotationGroup.remove(marker);
      if (marker instanceof THREE.Mesh) {
        marker.geometry.dispose();
        (marker.material as THREE.Material).dispose();
      }
    }
  }

  dispose(): void {
    this.clearAnnotations();
    this.clearWearVector();
    this.sceneManager.scene.remove(this.annotationGroup);
  }
}
