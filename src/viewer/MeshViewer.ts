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
  private wireframeObject: THREE.LineSegments | null = null;
  private referenceSphereObject: THREE.Mesh | null = null;

  // Materials
  private innerMaterial: THREE.MeshStandardMaterial;
  private outerMaterial: THREE.MeshStandardMaterial;
  private wireframeMaterial: THREE.LineBasicMaterial;

  constructor(sceneManager: SceneManager) {
    this.sceneManager = sceneManager;
    this.originalGroup = new THREE.Group();
    this.originalGroup.name = 'loaded-mesh';
    this.sceneManager.scene.add(this.originalGroup);

    // UHMWPE-like appearance (translucent white plastic)
    this.innerMaterial = new THREE.MeshStandardMaterial({
      color: 0xe8e8f0,
      metalness: 0.05,
      roughness: 0.55,
      side: THREE.DoubleSide,
      transparent: false,
    });

    this.outerMaterial = new THREE.MeshStandardMaterial({
      color: 0xaaaabc,
      metalness: 0.05,
      roughness: 0.65,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.25,
      depthWrite: false,
    });

    this.wireframeMaterial = new THREE.LineBasicMaterial({
      color: 0x00d4ff,
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

    const mesh = new THREE.Mesh(geometry, this.innerMaterial);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'inner-mesh';
    this.innerMeshObject = mesh;
    this.originalGroup.add(mesh);

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

    const mesh = new THREE.Mesh(geometry, this.outerMaterial);
    mesh.name = 'outer-mesh';
    this.outerMeshObject = mesh;
    this.originalGroup.add(mesh);
  }

  /**
   * Show or hide inner mesh wireframe.
   */
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
      opacity: 0.15,
    });
    this.referenceSphereObject = new THREE.Mesh(sphereGeo, sphereMat);
    this.referenceSphereObject.position.copy(center).sub(this.getGroupOffset());
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

  /** Get the position offset applied to the group */
  private getGroupOffset(): THREE.Vector3 {
    return this.originalGroup.position.clone().negate();
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
    this.wireframeObject = null;
    this.referenceSphereObject = null;
  }

  public dispose(): void {
    this.clearAll();
    this.innerMaterial.dispose();
    this.outerMaterial.dispose();
    this.wireframeMaterial.dispose();
  }
}
