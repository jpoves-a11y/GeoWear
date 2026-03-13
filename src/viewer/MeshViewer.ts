// ============================================================
// GeoWear — MeshViewer
// STL file loading, display, and visual controls
// ============================================================

import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { SceneManager } from './SceneManager';
import type { MeshData } from '../types';

export class MeshViewer {
  private sceneManager: SceneManager;
  private originalGroup: THREE.Group;
  private innerMeshObject: THREE.Mesh | null = null;
  private outerMeshObject: THREE.Mesh | null = null;
  private ghostMeshObject: THREE.Mesh | null = null;
  private wireframeObject: THREE.LineSegments | null = null;
  private referenceSphereObject: THREE.Mesh | null = null;
  private commercialSphereObject: THREE.Mesh | null = null;
  private wornSphereObject: THREE.Mesh | null = null;
  private unwornSphereObject: THREE.Mesh | null = null;
  private rimPlaneObject: THREE.Mesh | null = null;
  private wearPlaneObject: THREE.Mesh | null = null;

  // Materials
  private innerMaterial: THREE.MeshStandardMaterial;
  private outerMaterial: THREE.Material;
  private ghostMaterial: THREE.Material;
  private wireframeMaterial: THREE.LineBasicMaterial;

  constructor(sceneManager: SceneManager) {
    this.sceneManager = sceneManager;
    this.originalGroup = new THREE.Group();
    this.originalGroup.name = 'loaded-mesh';
    this.sceneManager.scene.add(this.originalGroup);

    // Slightly warm off-white for a professional clinical look
    this.innerMaterial = new THREE.MeshStandardMaterial({
      color: 0xe0ddd8,
      metalness: 0.08,
      roughness: 0.55,
      side: THREE.DoubleSide,
      transparent: false,
    });

    // Super transparent for outer (non-inner) areas
    this.outerMaterial = new THREE.MeshStandardMaterial({
      color: 0xd0d0d0,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.06,
      depthWrite: false,
    });

    // Super transparent ghost mesh for trimmed rim region
    this.ghostMaterial = new THREE.MeshStandardMaterial({
      color: 0xd0d0d0,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.06,
      depthWrite: false,
    });

    this.wireframeMaterial = new THREE.LineBasicMaterial({
      color: 0x0077cc,
      transparent: true,
      opacity: 0.15,
    });
  }

  /**
   * Load a STL file from an ArrayBuffer and return the raw geometry data.
   */
  public async loadSTL(buffer: ArrayBuffer, fileName: string): Promise<{
    geometry: THREE.BufferGeometry;
    meshData: MeshData;
  }> {
    const loader = new STLLoader();
    const geometry = loader.parse(buffer);

    // Compute normals if not present
    if (!geometry.attributes.normal) {
      geometry.computeVertexNormals();
    }

    const positions = geometry.attributes.position.array as Float32Array;
    const normals = geometry.attributes.normal.array as Float32Array;
    const vertexCount = positions.length / 3;
    const faceCount = vertexCount / 3;

    // Build indices if non-indexed
    let indices: Uint32Array;
    if (geometry.index) {
      indices = new Uint32Array(geometry.index.array);
    } else {
      indices = new Uint32Array(vertexCount);
      for (let i = 0; i < vertexCount; i++) indices[i] = i;
    }

    const meshData: MeshData = {
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      indices,
      vertexCount,
      faceCount,
    };

    return { geometry, meshData };
  }

  /**
   * Display a full loaded mesh (before separation).
   */
  public displayOriginalMesh(geometry: THREE.BufferGeometry): void {
    this.clearAll();

    const mesh = new THREE.Mesh(geometry, this.innerMaterial.clone());
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'original-mesh';
    this.originalGroup.add(mesh);

    // Reset group position before centering (critical for second+ loads)
    this.originalGroup.position.set(0, 0, 0);

    // Auto-center and focus camera
    const box = new THREE.Box3().setFromBufferAttribute(geometry.attributes.position as THREE.BufferAttribute);
    const center = box.getCenter(new THREE.Vector3());
    this.originalGroup.position.sub(center);

    const worldBox = new THREE.Box3().setFromObject(this.originalGroup);
    this.sceneManager.focusOn(worldBox);

    // Update mesh info
    const vertexCount = geometry.attributes.position.count;
    const faceCount = geometry.index
      ? geometry.index.count / 3
      : vertexCount / 3;
    const meshInfo = document.getElementById('mesh-info');
    if (meshInfo) {
      meshInfo.textContent = `${(faceCount).toLocaleString()} triangles · ${(vertexCount).toLocaleString()} vertices`;
    }
  }

  /**
   * Display the separated inner mesh (for analysis).
   */
  public displayInnerMesh(meshData: MeshData): THREE.Mesh {
    // Remove previous inner mesh
    if (this.innerMeshObject) {
      this.originalGroup.remove(this.innerMeshObject);
      this.innerMeshObject.geometry.dispose();
    }

    const geometry = this.meshDataToGeometry(meshData);
    geometry.computeVertexNormals();

    const mesh = new THREE.Mesh(geometry, this.innerMaterial.clone());
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'inner-mesh';
    this.innerMeshObject = mesh;
    
    // Add in correct order: first remove/re-add to ensure proper depth ordering
    this.originalGroup.add(mesh);
    this.reorderMeshes();

    return mesh;
  }

  /**
   * Display the outer mesh as transparent overlay.
   */
  public displayOuterMesh(meshData: MeshData): void {
    if (this.outerMeshObject) {
      this.originalGroup.remove(this.outerMeshObject);
      this.outerMeshObject.geometry.dispose();
    }

    const geometry = this.meshDataToGeometry(meshData);
    geometry.computeVertexNormals();

    const mesh = new THREE.Mesh(geometry, this.outerMaterial.clone());
    mesh.name = 'outer-mesh';
    mesh.renderOrder = 10;
    this.outerMeshObject = mesh;
    this.originalGroup.add(mesh);
    this.reorderMeshes();
  }

  /**
   * Display a transparent ghost mesh (e.g., trimmed-away region reference).
   */
  public displayGhostMesh(meshData: MeshData): void {
    if (this.ghostMeshObject) {
      this.originalGroup.remove(this.ghostMeshObject);
      this.ghostMeshObject.geometry.dispose();
    }

    const geometry = this.meshDataToGeometry(meshData);
    geometry.computeVertexNormals();

    const mesh = new THREE.Mesh(geometry, this.ghostMaterial.clone());
    mesh.name = 'ghost-mesh';
    mesh.renderOrder = 10;
    this.ghostMeshObject = mesh;
    this.originalGroup.add(mesh);
    this.reorderMeshes();
  }

  /**
   * Show or hide inner mesh wireframe.
   */
  /**
   * Toggle context meshes between opaque and translucent.
   */
  public setContextOpaque(opaque: boolean): void {
    const opacity = opaque ? 1.0 : 0.06;
    const depthWrite = opaque;
    const transparent = !opaque;
    if (this.outerMeshObject) {
      const mat = this.outerMeshObject.material as THREE.MeshStandardMaterial;
      mat.opacity = opacity;
      mat.transparent = transparent;
      mat.depthWrite = depthWrite;
      mat.needsUpdate = true;
    }
    if (this.ghostMeshObject) {
      const mat = this.ghostMeshObject.material as THREE.MeshStandardMaterial;
      mat.opacity = opacity;
      mat.transparent = transparent;
      mat.depthWrite = depthWrite;
      mat.needsUpdate = true;
    }
  }

  public setWireframe(visible: boolean): void {
    if (visible && this.innerMeshObject) {
      if (!this.wireframeObject) {
        const wireGeo = new THREE.WireframeGeometry(this.innerMeshObject.geometry);
        this.wireframeObject = new THREE.LineSegments(wireGeo, this.wireframeMaterial);
        this.wireframeObject.name = 'wireframe';
        this.originalGroup.add(this.wireframeObject);
      }
      this.wireframeObject.visible = true;
    } else if (this.wireframeObject) {
      this.wireframeObject.visible = false;
    }
  }

  /**
   * Display a reference sphere (wireframe).
   */
  public displayReferenceSphere(center: THREE.Vector3, radius: number, visible: boolean = true): void {
    if (this.referenceSphereObject) {
      this.originalGroup.remove(this.referenceSphereObject);
      this.referenceSphereObject.geometry.dispose();
    }

    const sphereGeo = new THREE.SphereGeometry(radius, 64, 32);
    const sphereMat = new THREE.MeshStandardMaterial({
      color: 0x00ff88,
      wireframe: true,
      transparent: true,
      opacity: 0.05,
    });
    this.referenceSphereObject = new THREE.Mesh(sphereGeo, sphereMat);
    this.referenceSphereObject.position.copy(center);
    this.referenceSphereObject.name = 'reference-sphere';
    this.referenceSphereObject.visible = visible;
    this.originalGroup.add(this.referenceSphereObject);
  }

  public setReferenceSphereVisible(visible: boolean): void {
    if (this.referenceSphereObject) {
      this.referenceSphereObject.visible = visible;
    }
  }

  /**
   * Display the commercial sphere (orange wireframe).
   */
  public displayCommercialSphere(center: THREE.Vector3, radius: number, visible: boolean = true): void {
    this.removeNamedObject('commercial-sphere');
    if (this.commercialSphereObject) {
      this.originalGroup.remove(this.commercialSphereObject);
      this.commercialSphereObject.geometry.dispose();
    }
    const geo = new THREE.SphereGeometry(radius, 64, 32);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffaa00,
      wireframe: true,
      transparent: true,
      opacity: 0.1,
    });
    this.commercialSphereObject = new THREE.Mesh(geo, mat);
    this.commercialSphereObject.position.copy(center);
    this.commercialSphereObject.name = 'commercial-sphere';
    this.commercialSphereObject.visible = visible;
    this.originalGroup.add(this.commercialSphereObject);
  }

  /**
   * Display the worn zone sphere (red, transparent solid).
   */
  public displayWornSphere(center: THREE.Vector3, radius: number, visible: boolean = true): void {
    this.removeNamedObject('worn-sphere');
    if (this.wornSphereObject) {
      this.originalGroup.remove(this.wornSphereObject);
      this.wornSphereObject.geometry.dispose();
    }
    const geo = new THREE.SphereGeometry(radius, 64, 32);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xff3333,
      transparent: true,
      opacity: 0.25,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.wornSphereObject = new THREE.Mesh(geo, mat);
    this.wornSphereObject.position.copy(center);
    this.wornSphereObject.name = 'worn-sphere';
    this.wornSphereObject.visible = visible;
    this.wornSphereObject.renderOrder = 5;
    this.originalGroup.add(this.wornSphereObject);
  }

  /**
   * Display the unworn zone sphere (green, transparent solid).
   */
  public displayUnwornSphere(center: THREE.Vector3, radius: number, visible: boolean = true): void {
    this.removeNamedObject('unworn-sphere');
    if (this.unwornSphereObject) {
      this.originalGroup.remove(this.unwornSphereObject);
      this.unwornSphereObject.geometry.dispose();
    }
    const geo = new THREE.SphereGeometry(radius, 64, 32);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x33ff33,
      transparent: true,
      opacity: 0.25,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.unwornSphereObject = new THREE.Mesh(geo, mat);
    this.unwornSphereObject.position.copy(center);
    this.unwornSphereObject.name = 'unworn-sphere';
    this.unwornSphereObject.visible = visible;
    this.unwornSphereObject.renderOrder = 5;
    this.originalGroup.add(this.unwornSphereObject);
  }

  /**
   * Display the rim plane as a semi-transparent disc.
   */
  public displayRimPlane(center: THREE.Vector3, normal: THREE.Vector3, radius: number, visible: boolean = true): void {
    this.removeNamedObject('rim-plane');
    if (this.rimPlaneObject) {
      this.originalGroup.remove(this.rimPlaneObject);
      this.rimPlaneObject.geometry.dispose();
    }
    const geo = new THREE.CircleGeometry(radius * 1.3, 64);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x4488ff,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.rimPlaneObject = new THREE.Mesh(geo, mat);
    this.rimPlaneObject.position.copy(center);
    // Orient disc so its normal aligns with the plane normal
    const up = new THREE.Vector3(0, 0, 1);
    const quat = new THREE.Quaternion().setFromUnitVectors(up, normal.clone().normalize());
    this.rimPlaneObject.quaternion.copy(quat);
    this.rimPlaneObject.name = 'rim-plane';
    this.rimPlaneObject.visible = visible;
    this.rimPlaneObject.renderOrder = 6;
    this.originalGroup.add(this.rimPlaneObject);
  }

  public setCommercialSphereVisible(visible: boolean): void {
    if (this.commercialSphereObject) this.commercialSphereObject.visible = visible;
  }
  public setWornSphereVisible(visible: boolean): void {
    if (this.wornSphereObject) this.wornSphereObject.visible = visible;
  }
  public setUnwornSphereVisible(visible: boolean): void {
    if (this.unwornSphereObject) this.unwornSphereObject.visible = visible;
  }
  public setRimPlaneVisible(visible: boolean): void {
    if (this.rimPlaneObject) this.rimPlaneObject.visible = visible;
  }

  /**
   * Display the wear-section plane (passes through pole and max-wear point).
   * Uses a PlaneGeometry oriented by the given normal.
   */
  public displayWearPlane(
    center: THREE.Vector3,
    normal: THREE.Vector3,
    size: number,
    visible: boolean = false
  ): void {
    this.removeNamedObject('wear-plane');
    if (this.wearPlaneObject) {
      this.originalGroup.remove(this.wearPlaneObject);
      this.wearPlaneObject.geometry.dispose();
    }
    const geo = new THREE.PlaneGeometry(size * 2.6, size * 2.6);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xff8800,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.wearPlaneObject = new THREE.Mesh(geo, mat);
    this.wearPlaneObject.position.copy(center);
    const up = new THREE.Vector3(0, 0, 1);
    const quat = new THREE.Quaternion().setFromUnitVectors(up, normal.clone().normalize());
    this.wearPlaneObject.quaternion.copy(quat);
    this.wearPlaneObject.name = 'wear-plane';
    this.wearPlaneObject.visible = visible;
    this.wearPlaneObject.renderOrder = 7;
    this.originalGroup.add(this.wearPlaneObject);
  }

  public setWearPlaneVisible(visible: boolean): void {
    if (this.wearPlaneObject) this.wearPlaneObject.visible = visible;
  }

  /** Remove a named object from the group */
  private removeNamedObject(name: string): void {
    const obj = this.originalGroup.getObjectByName(name);
    if (obj) {
      this.originalGroup.remove(obj);
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
        else obj.material.dispose();
      }
    }
  }

  /** Clear zone spheres, commercial sphere, and rim plane */
  public clearZoneSpheres(): void {
    for (const name of ['commercial-sphere', 'worn-sphere', 'unworn-sphere', 'rim-plane', 'wear-plane']) {
      this.removeNamedObject(name);
    }
    this.commercialSphereObject = null;
    this.wornSphereObject = null;
    this.unwornSphereObject = null;
    this.rimPlaneObject = null;
    this.wearPlaneObject = null;
  }

  /**
   * Reorder meshes in the group to ensure correct depth rendering.
   * Order: outer (back) -> ghost (middle) -> inner (front)
   */
  private reorderMeshes(): void {
    const outer = this.originalGroup.getObjectByName('outer-mesh');
    const ghost = this.originalGroup.getObjectByName('ghost-mesh');
    const inner = this.originalGroup.getObjectByName('inner-mesh');

    // Remove all mesh objects
    if (outer) this.originalGroup.remove(outer);
    if (ghost) this.originalGroup.remove(ghost);
    if (inner) this.originalGroup.remove(inner);

    // Re-add in correct order (back to front)
    if (outer) this.originalGroup.add(outer);
    if (ghost) this.originalGroup.add(ghost);
    if (inner) this.originalGroup.add(inner);
  }

  /**
   * Apply vertex colors (heat map).
   */
  public applyVertexColors(colors: Float32Array): void {
    if (!this.innerMeshObject) return;

    const geometry = this.innerMeshObject.geometry;
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

    const mat = this.innerMeshObject.material as THREE.MeshStandardMaterial;
    mat.vertexColors = true;
    mat.needsUpdate = true;
  }

  /**
   * Remove vertex colors (back to uniform).
   */
  public removeVertexColors(): void {
    if (!this.innerMeshObject) return;

    const geometry = this.innerMeshObject.geometry;
    geometry.deleteAttribute('color');

    const mat = this.innerMeshObject.material as THREE.MeshStandardMaterial;
    mat.vertexColors = false;
    mat.needsUpdate = true;
  }

  /** Get the Three.js inner mesh object */
  public getInnerMesh(): THREE.Mesh | null {
    return this.innerMeshObject;
  }

  /** Get the group (for position offset calculations) */
  public getGroup(): THREE.Group {
    return this.originalGroup;
  }

  /** Get the scene offset to apply to objects outside originalGroup */
  public getGroupOffset(): THREE.Vector3 {
    return this.originalGroup.position.clone();
  }

  /**
   * Make the inner mesh semi-transparent so geodesics are visible on top.
   */
  public setInnerTransparency(opacity: number): void {
    if (!this.innerMeshObject) return;
    const mat = this.innerMeshObject.material as THREE.MeshStandardMaterial;
    mat.transparent = opacity < 1;
    mat.opacity = opacity;
    mat.needsUpdate = true;
  }

  /**
   * Hide original mesh (when inner/outer are displayed separately).
   */
  public hideOriginal(): void {
    const orig = this.originalGroup.getObjectByName('original-mesh');
    if (orig) orig.visible = false;
  }

  /**
   * Convert MeshData to Three.js BufferGeometry.
   */
  public meshDataToGeometry(data: MeshData): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3));
    if (data.normals.length > 0) {
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(data.normals, 3));
    }
    if (data.indices.length !== data.vertexCount) {
      // We have real indices (not identity)
      geometry.setIndex(new THREE.Uint32BufferAttribute(data.indices, 1));
    }
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }

  /** Clear all meshes and reset */
  public clearAll(): void {
    while (this.originalGroup.children.length > 0) {
      const child = this.originalGroup.children[0];
      this.originalGroup.remove(child);
      if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
        child.geometry.dispose();
        if (Array.isArray(child.material)) {
          child.material.forEach(m => m.dispose());
        } else {
          child.material.dispose();
        }
      }
    }
    this.innerMeshObject = null;
    this.outerMeshObject = null;
    this.ghostMeshObject = null;
    this.wireframeObject = null;
    this.referenceSphereObject = null;
    this.commercialSphereObject = null;
    this.wornSphereObject = null;
    this.unwornSphereObject = null;
    this.rimPlaneObject = null;
    this.wearPlaneObject = null;
  }

  public dispose(): void {
    this.clearAll();
    this.innerMaterial.dispose();
    this.outerMaterial.dispose();
    this.ghostMaterial.dispose();
    this.wireframeMaterial.dispose();
  }
}
