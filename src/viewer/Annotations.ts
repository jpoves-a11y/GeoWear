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
   */
  addClusterAnnotations(
    clusters: AnomalyCluster[],
    groupOffset: THREE.Vector3
  ): void {
    this.clearAnnotations();

    for (const cluster of clusters) {
      const label = this.createLabel(cluster, groupOffset);
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
  private createLabel(cluster: AnomalyCluster, groupOffset: THREE.Vector3): CSS2DObject {
    const div = document.createElement('div');
    div.className = `annotation-label ${cluster.type}`;

    const icon = cluster.type === 'bump' ? '▲' : '▼';
    const devStr = cluster.type === 'bump'
      ? `+${cluster.maxDeviation.toFixed(1)}`
      : `${cluster.minDeviation.toFixed(1)}`;

    div.innerHTML = `
      <span>${icon} ${devStr} μm</span>
    `;

    div.title = `${cluster.type === 'bump' ? 'Bump' : 'Wear'} Region #${cluster.id + 1}\n` +
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
    label.position.copy(cluster.centroid).add(groupOffset);
    label.position.y += 0.3; // slight offset above surface
    return label;
  }

  /**
   * Render the wear vector: line from deepest point to pole.
   */
  renderWearVector(
    deepestPoint: THREE.Vector3,
    polePoint: THREE.Vector3,
    groupOffset: THREE.Vector3,
    maxDepth: number,
    angle: number
  ): void {
    this.clearWearVector();

    const start = deepestPoint.clone().add(groupOffset);
    const end = polePoint.clone().add(groupOffset);

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

    // Arrow at deepest point
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
