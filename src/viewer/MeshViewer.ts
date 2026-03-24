// ============================================================
// GeoWear — MeshViewer
// STL file loading, display, and visual controls
// ============================================================

import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { SceneManager } from './SceneManager';
import type { MeshData } from '../types';

/** Face count threshold above which display geometry is decimated */
const DECIMATE_THRESHOLD = 500_000;
/** Target face count for decimated display geometry */
const DISPLAY_FACE_TARGET = 300_000;

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
  private volumePreviewGroup: THREE.Group | null = null;

  // Display decimation state
  private _vertexMap: Uint32Array | null = null; // full vertex → decimated vertex
  private _decimatedVertexCount = 0;
  private _isDecimated = false;

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
    this.sceneManager.requestRender();

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

    // Reset decimation state
    this._vertexMap = null;
    this._decimatedVertexCount = 0;
    this._isDecimated = false;

    let geometry: THREE.BufferGeometry;

    if (meshData.faceCount > DECIMATE_THRESHOLD) {
      // Decimate for display; keep full meshData for analysis
      const dec = this.decimateForDisplay(meshData, DISPLAY_FACE_TARGET);
      geometry = dec.geometry;
      this._vertexMap = dec.vertexMap;
      this._decimatedVertexCount = dec.decimatedVertexCount;
      this._isDecimated = true;
      console.log(`[LOD] Decimated display: ${meshData.faceCount} → ${dec.geometry.index!.count / 3} faces, ${meshData.vertexCount} → ${dec.decimatedVertexCount} verts`);
    } else {
      geometry = this.meshDataToGeometry(meshData);
      geometry.computeVertexNormals();
    }

    const mesh = new THREE.Mesh(geometry, this.innerMaterial.clone());
    mesh.name = 'inner-mesh';
    this.innerMeshObject = mesh;
    
    // Add in correct order
    this.originalGroup.add(mesh);
    this.reorderMeshes();
    this.sceneManager.requestRender();

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
    this.sceneManager.requestRender();
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
    this.sceneManager.requestRender();
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

  /**
   * Display volume preview: mesh enclosed volume (blue) + sphere cap (green).
   * Both are semi-transparent filled solids so the user can visually verify
   * the volumes used in the wear calculation.
   */
  public displayVolumePreview(
    meshData: MeshData,
    sphereCenter: THREE.Vector3,
    sphereRadius: number,
    planePoint: THREE.Vector3,
    planeNormal: THREE.Vector3,
    visible: boolean = false,
    smoothContinuous: boolean = false
  ): void {
    this.removeNamedObject('volume-preview');
    if (this.volumePreviewGroup) {
      this.originalGroup.remove(this.volumePreviewGroup);
      this.volumePreviewGroup.traverse(child => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
          else child.material.dispose();
        }
      });
    }

    const group = new THREE.Group();
    group.name = 'volume-preview';
    group.visible = visible;

    const pn = planeNormal.clone().normalize();

    // For better visual continuity at the rim cut, use a lightly smoothed
    // preview surface when inner-face repair is enabled.
    const previewPositions = smoothContinuous
      ? this.smoothPositionsPreview(meshData.positions, meshData.indices, 2, 0.25)
      : meshData.positions;

    // --- 1. Mesh enclosed volume (blue, filled) ---
    // Clip triangles against the rim plane so the surface reaches the plane continuously.
    const clipped = this.buildClippedSurfaceToPlane(previewPositions, meshData.indices, planePoint, pn);

    const meshGeo = new THREE.BufferGeometry();
    meshGeo.setAttribute('position', new THREE.Float32BufferAttribute(clipped.positions, 3));
    meshGeo.setIndex(new THREE.Uint32BufferAttribute(clipped.indices, 1));
    meshGeo.computeVertexNormals();
    meshGeo.computeBoundingSphere();

    const meshMat = new THREE.MeshStandardMaterial({
      color: 0x2266dd,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const meshObj = new THREE.Mesh(meshGeo, meshMat);
    meshObj.renderOrder = 8;
    meshObj.name = 'vol-mesh-surface';
    group.add(meshObj);

    // Cap polygon from boundary edges of the FILTERED faces projected onto the rim plane.
    // This ensures the cap exactly matches the visible blue mesh surface.
    const capGeo = this.buildBoundaryCapGeometry(clipped.positions, clipped.indices, planePoint, pn);
    if (capGeo) {
      const capMat = new THREE.MeshStandardMaterial({
        color: 0x2266dd,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const capObj = new THREE.Mesh(capGeo, capMat);
      capObj.renderOrder = 8;
      capObj.name = 'vol-mesh-cap';
      group.add(capObj);
    }

    // --- 2. Sphere cap volume (green, filled) ---
    const sphereCapGeo = this.buildSphereCapGeometry(sphereCenter, sphereRadius, planePoint, pn);
    if (sphereCapGeo) {
      const capMat2 = new THREE.MeshStandardMaterial({
        color: 0x22bb44,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const capObj2 = new THREE.Mesh(sphereCapGeo, capMat2);
      capObj2.renderOrder = 9;
      capObj2.name = 'vol-sphere-cap';
      group.add(capObj2);
    }

    this.volumePreviewGroup = group;
    this.originalGroup.add(group);
  }

  public setVolumePreviewVisible(visible: boolean): void {
    if (this.volumePreviewGroup) this.volumePreviewGroup.visible = visible;
  }

  private updateVolumePreviewGroupVisibility(): void {
    if (!this.volumePreviewGroup) return;
    const surf = this.volumePreviewGroup.getObjectByName('vol-mesh-surface');
    const cap = this.volumePreviewGroup.getObjectByName('vol-mesh-cap');
    const sphere = this.volumePreviewGroup.getObjectByName('vol-sphere-cap');
    const anyVisible = Boolean(surf?.visible || cap?.visible || sphere?.visible);
    this.volumePreviewGroup.visible = anyVisible;
  }

  public setMeshVolumeVisible(visible: boolean): void {
    if (!this.volumePreviewGroup) return;
    const surf = this.volumePreviewGroup.getObjectByName('vol-mesh-surface');
    const cap = this.volumePreviewGroup.getObjectByName('vol-mesh-cap');
    if (surf) surf.visible = visible;
    if (cap) cap.visible = visible;
    this.updateVolumePreviewGroupVisibility();
  }

  public setSphereCapVisible(visible: boolean): void {
    if (!this.volumePreviewGroup) return;
    const cap = this.volumePreviewGroup.getObjectByName('vol-sphere-cap');
    if (cap) cap.visible = visible;
    this.updateVolumePreviewGroupVisibility();
  }

  public showOriginal(): void {
    const orig = this.originalGroup.getObjectByName('original-mesh');
    if (orig) orig.visible = true;
  }

  public setOriginalVisible(visible: boolean): void {
    // Full STL Sample controls the analysis STL surfaces as one block.
    // Keep original-mesh hidden to avoid duplicate overlay with inner/outer/ghost.
    if (this.innerMeshObject) this.innerMeshObject.visible = visible;
    if (this.outerMeshObject) this.outerMeshObject.visible = visible;
    if (this.ghostMeshObject) this.ghostMeshObject.visible = visible;
    if (this.wireframeObject) this.wireframeObject.visible = visible;
    const original = this.originalGroup.getObjectByName('original-mesh');
    if (original) original.visible = false;
  }

  private smoothPositionsPreview(
    positions: Float32Array,
    indices: Uint32Array,
    iterations: number,
    alpha: number
  ): Float32Array {
    const vertexCount = positions.length / 3;
    const adj: Array<Set<number>> = new Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) adj[i] = new Set<number>();

    const faceCount = indices.length / 3;
    for (let f = 0; f < faceCount; f++) {
      const a = indices[f * 3];
      const b = indices[f * 3 + 1];
      const c = indices[f * 3 + 2];
      adj[a].add(b); adj[a].add(c);
      adj[b].add(a); adj[b].add(c);
      adj[c].add(a); adj[c].add(b);
    }

    let curr = new Float32Array(positions);
    let next = new Float32Array(positions.length);

    for (let it = 0; it < iterations; it++) {
      for (let v = 0; v < vertexCount; v++) {
        const neighbors = adj[v];
        if (!neighbors || neighbors.size === 0) {
          next[v * 3] = curr[v * 3];
          next[v * 3 + 1] = curr[v * 3 + 1];
          next[v * 3 + 2] = curr[v * 3 + 2];
          continue;
        }

        let ax = 0, ay = 0, az = 0;
        for (const n of neighbors) {
          ax += curr[n * 3];
          ay += curr[n * 3 + 1];
          az += curr[n * 3 + 2];
        }
        const inv = 1 / neighbors.size;
        ax *= inv; ay *= inv; az *= inv;

        next[v * 3] = curr[v * 3] + alpha * (ax - curr[v * 3]);
        next[v * 3 + 1] = curr[v * 3 + 1] + alpha * (ay - curr[v * 3 + 1]);
        next[v * 3 + 2] = curr[v * 3 + 2] + alpha * (az - curr[v * 3 + 2]);
      }

      const swap = curr;
      curr = next;
      next = swap;
    }

    return curr;
  }

  /**
   * Recreate the full STL sample mesh from MeshData without clearing other overlays.
   */
  public displayOriginalMeshFromData(meshData: MeshData, visible: boolean = false): void {
    const existing = this.originalGroup.getObjectByName('original-mesh');
    if (existing) {
      this.originalGroup.remove(existing);
      if (existing instanceof THREE.Mesh) {
        existing.geometry.dispose();
        if (Array.isArray(existing.material)) existing.material.forEach(m => m.dispose());
        else existing.material.dispose();
      }
    }

    const geometry = this.meshDataToGeometry(meshData);
    geometry.computeVertexNormals();

    const mesh = new THREE.Mesh(geometry, this.innerMaterial.clone());
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'original-mesh';
    mesh.visible = visible;
    this.originalGroup.add(mesh);
  }

  private buildClippedSurfaceToPlane(
    positions: Float32Array,
    indices: Uint32Array,
    planePoint: THREE.Vector3,
    planeNormal: THREE.Vector3,
  ): { positions: Float32Array; indices: Uint32Array } {
    const px = planePoint.x, py = planePoint.y, pz = planePoint.z;
    const nx = planeNormal.x, ny = planeNormal.y, nz = planeNormal.z;
    const eps = 1e-6;

    const outPositions: number[] = [];
    const outIndices: number[] = [];
    const vertexMap = new Map<string, number>();

    const addVertex = (x: number, y: number, z: number): number => {
      const qx = Math.round(x * 1e5);
      const qy = Math.round(y * 1e5);
      const qz = Math.round(z * 1e5);
      const key = `${qx}_${qy}_${qz}`;
      const existing = vertexMap.get(key);
      if (existing !== undefined) return existing;
      const idx = outPositions.length / 3;
      outPositions.push(x, y, z);
      vertexMap.set(key, idx);
      return idx;
    };

    type Vtx = { x: number; y: number; z: number; d: number };
    const intersect = (a: Vtx, b: Vtx): Vtx => {
      const t = a.d / (a.d - b.d);
      return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t,
        d: 0,
      };
    };

    const faceCount = indices.length / 3;
    for (let f = 0; f < faceCount; f++) {
      const i0 = indices[f * 3];
      const i1 = indices[f * 3 + 1];
      const i2 = indices[f * 3 + 2];

      const v0: Vtx = {
        x: positions[i0 * 3],
        y: positions[i0 * 3 + 1],
        z: positions[i0 * 3 + 2],
        d: (positions[i0 * 3] - px) * nx + (positions[i0 * 3 + 1] - py) * ny + (positions[i0 * 3 + 2] - pz) * nz,
      };
      const v1: Vtx = {
        x: positions[i1 * 3],
        y: positions[i1 * 3 + 1],
        z: positions[i1 * 3 + 2],
        d: (positions[i1 * 3] - px) * nx + (positions[i1 * 3 + 1] - py) * ny + (positions[i1 * 3 + 2] - pz) * nz,
      };
      const v2: Vtx = {
        x: positions[i2 * 3],
        y: positions[i2 * 3 + 1],
        z: positions[i2 * 3 + 2],
        d: (positions[i2 * 3] - px) * nx + (positions[i2 * 3 + 1] - py) * ny + (positions[i2 * 3 + 2] - pz) * nz,
      };

      let poly: Vtx[] = [v0, v1, v2];

      // Clip polygon by half-space d >= 0 (Sutherland-Hodgman for a single plane)
      const clipped: Vtx[] = [];
      for (let e = 0; e < poly.length; e++) {
        const a = poly[e];
        const b = poly[(e + 1) % poly.length];
        const aInside = a.d >= -eps;
        const bInside = b.d >= -eps;

        if (aInside && bInside) {
          clipped.push({ ...b, d: Math.max(0, b.d) });
        } else if (aInside && !bInside) {
          clipped.push(intersect(a, b));
        } else if (!aInside && bInside) {
          clipped.push(intersect(a, b));
          clipped.push({ ...b, d: Math.max(0, b.d) });
        }
      }

      if (clipped.length < 3) continue;

      // Triangulate clipped polygon as a fan
      const iA = addVertex(clipped[0].x, clipped[0].y, clipped[0].z);
      for (let k = 1; k + 1 < clipped.length; k++) {
        const iB = addVertex(clipped[k].x, clipped[k].y, clipped[k].z);
        const iC = addVertex(clipped[k + 1].x, clipped[k + 1].y, clipped[k + 1].z);
        outIndices.push(iA, iB, iC);
      }
    }

    return {
      positions: new Float32Array(outPositions),
      indices: new Uint32Array(outIndices),
    };
  }

  /**
   * Build a cap polygon from the mesh boundary edges, ordered into a loop
   * and projected onto the rim plane. Creates a triangle fan from planePoint.
   */
  private buildBoundaryCapGeometry(
    positions: Float32Array,
    indices: number[] | Uint32Array,
    planePoint: THREE.Vector3,
    planeNormal: THREE.Vector3
  ): THREE.BufferGeometry | null {
    const faceCount = indices.length / 3;

    // Find boundary edges (edges used by exactly one face in the filtered set)
    const edgeUsage = new Map<string, { a: number; b: number; count: number }>();
    for (let f = 0; f < faceCount; f++) {
      for (let e = 0; e < 3; e++) {
        const a = indices[f * 3 + e];
        const b = indices[f * 3 + ((e + 1) % 3)];
        const key = Math.min(a, b) + '_' + Math.max(a, b);
        const existing = edgeUsage.get(key);
        if (existing) {
          existing.count++;
        } else {
          edgeUsage.set(key, { a, b, count: 1 });
        }
      }
    }

    const boundaryVerts = new Set<number>();
    for (const [, edge] of edgeUsage) {
      if (edge.count === 1) {
        boundaryVerts.add(edge.a);
        boundaryVerts.add(edge.b);
      }
    }
    if (boundaryVerts.size < 3) return null;

    // Build orthonormal basis on plane for angular sorting.
    const N = planeNormal.clone().normalize();
    const U = new THREE.Vector3();
    if (Math.abs(N.x) < 0.9) U.crossVectors(N, new THREE.Vector3(1, 0, 0)).normalize();
    else U.crossVectors(N, new THREE.Vector3(0, 1, 0)).normalize();
    const V = new THREE.Vector3().crossVectors(N, U).normalize();

    // Project boundary points onto plane and compute planar coords.
    type P = { x: number; y: number; z: number; u2d: number; v2d: number; a: number };
    const pts: P[] = [];
    for (const v of boundaryVerts) {
      const vx = positions[v * 3], vy = positions[v * 3 + 1], vz = positions[v * 3 + 2];
      const dist = (vx - planePoint.x) * N.x + (vy - planePoint.y) * N.y + (vz - planePoint.z) * N.z;
      const px = vx - dist * N.x;
      const py = vy - dist * N.y;
      const pz = vz - dist * N.z;
      const rx = px - planePoint.x, ry = py - planePoint.y, rz = pz - planePoint.z;
      const u2d = rx * U.x + ry * U.y + rz * U.z;
      const v2d = rx * V.x + ry * V.y + rz * V.z;
      pts.push({ x: px, y: py, z: pz, u2d, v2d, a: 0 });
    }

    const hull = this.computeConvexHull2D(pts.map((p, i) => ({ i, x: p.u2d, y: p.v2d })));
    if (hull.length < 3) return null;

    const hullPts = hull.map(h => pts[h.i]);

    for (const p of hullPts) {
      const rx = p.x - planePoint.x, ry = p.y - planePoint.y, rz = p.z - planePoint.z;
      const u = rx * U.x + ry * U.y + rz * U.z;
      const v = rx * V.x + ry * V.y + rz * V.z;
      p.u2d = u;
      p.v2d = v;
      p.a = Math.atan2(p.v2d, p.u2d);
    }
    hullPts.sort((a, b) => a.a - b.a);

    // Build fan from plane center to sorted rim polygon.
    const verts: number[] = [];
    verts.push(planePoint.x, planePoint.y, planePoint.z);
    for (const p of hullPts) {
      verts.push(p.x, p.y, p.z);
    }

    // Fan triangles: center(0) → loop[i+1] → loop[i+2]
    const idxs: number[] = [];
    for (let i = 0; i < hullPts.length; i++) {
      const ni = (i + 1) % hullPts.length;
      idxs.push(0, i + 1, ni + 1);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setIndex(idxs);
    geo.computeVertexNormals();
    return geo;
  }

  private computeConvexHull2D(points: Array<{ i: number; x: number; y: number }>): Array<{ i: number; x: number; y: number }> {
    if (points.length <= 3) return points.slice();

    const pts = points.slice().sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));

    const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) => {
      return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    };

    const lower: Array<{ i: number; x: number; y: number }> = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
        lower.pop();
      }
      lower.push(p);
    }

    const upper: Array<{ i: number; x: number; y: number }> = [];
    for (let k = pts.length - 1; k >= 0; k--) {
      const p = pts[k];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
        upper.pop();
      }
      upper.push(p);
    }

    lower.pop();
    upper.pop();
    return lower.concat(upper);
  }

  /**
   * Build a spherical cap geometry on the pole (normal) side of a cutting plane.
   * Returns a closed solid: spherical surface + flat disc base.
   */
  private buildSphereCapGeometry(
    center: THREE.Vector3,
    radius: number,
    planePoint: THREE.Vector3,
    planeNormal: THREE.Vector3
  ): THREE.BufferGeometry | null {
    const N = planeNormal.clone().normalize();
    const d = center.clone().sub(planePoint).dot(N);
    const h = radius + d;
    if (h <= 0) return null;

    // Angle from pole to cap edge on the rim plane:
    // Point at angle θ has signed distance to plane = d + R·cos(θ)
    // At the plane: d + R·cos(θ) = 0  →  cos(θ) = -d/R
    const cosTheta = Math.max(-1, Math.min(1, -d / radius));
    const thetaMax = Math.acos(cosTheta);

    // Orthonormal basis: N, U, V
    const U = new THREE.Vector3();
    if (Math.abs(N.x) < 0.9) U.crossVectors(N, new THREE.Vector3(1, 0, 0)).normalize();
    else U.crossVectors(N, new THREE.Vector3(0, 1, 0)).normalize();
    const V = new THREE.Vector3().crossVectors(N, U).normalize();

    const rings = 32;
    const segments = 64;
    const positions: number[] = [];
    const idxs: number[] = [];

    // Ring 0 = pole, ring `rings` = cap edge
    for (let r = 0; r <= rings; r++) {
      const theta = (r / rings) * thetaMax;
      const sinT = Math.sin(theta);
      const cosT = Math.cos(theta);
      for (let s = 0; s <= segments; s++) {
        const phi = (s / segments) * Math.PI * 2;
        positions.push(
          center.x + radius * (cosT * N.x + sinT * (Math.cos(phi) * U.x + Math.sin(phi) * V.x)),
          center.y + radius * (cosT * N.y + sinT * (Math.cos(phi) * U.y + Math.sin(phi) * V.y)),
          center.z + radius * (cosT * N.z + sinT * (Math.cos(phi) * U.z + Math.sin(phi) * V.z))
        );
      }
    }

    // Sphere surface triangles
    for (let r = 0; r < rings; r++) {
      for (let s = 0; s < segments; s++) {
        const a = r * (segments + 1) + s;
        const b = a + segments + 1;
        idxs.push(a, b, a + 1);
        idxs.push(a + 1, b, b + 1);
      }
    }

    // Flat disc base to close the cap
    const discCenter = positions.length / 3;
    const projCenter = center.clone().sub(N.clone().multiplyScalar(d));
    positions.push(projCenter.x, projCenter.y, projCenter.z);

    const capBaseRadius = radius * Math.sin(thetaMax);
    const discStart = positions.length / 3;
    for (let s = 0; s <= segments; s++) {
      const phi = (s / segments) * Math.PI * 2;
      positions.push(
        projCenter.x + capBaseRadius * (Math.cos(phi) * U.x + Math.sin(phi) * V.x),
        projCenter.y + capBaseRadius * (Math.cos(phi) * U.y + Math.sin(phi) * V.y),
        projCenter.z + capBaseRadius * (Math.cos(phi) * U.z + Math.sin(phi) * V.z)
      );
    }

    // Disc fan triangles (reversed winding)
    for (let s = 0; s < segments; s++) {
      idxs.push(discCenter, discStart + s + 1, discStart + s);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(idxs);
    geo.computeVertexNormals();
    return geo;
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

  /** Clear zone spheres, commercial sphere, rim plane, and volume preview */
  public clearZoneSpheres(): void {
    for (const name of ['commercial-sphere', 'worn-sphere', 'unworn-sphere', 'rim-plane', 'wear-plane', 'volume-preview']) {
      this.removeNamedObject(name);
    }
    this.commercialSphereObject = null;
    this.wornSphereObject = null;
    this.unwornSphereObject = null;
    this.rimPlaneObject = null;
    this.wearPlaneObject = null;
    this.volumePreviewGroup = null;
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

    // If display is decimated, remap colors from full mesh to decimated mesh
    let finalColors = colors;
    if (this._isDecimated && this._vertexMap) {
      finalColors = this.remapColors(colors);
    }

    geometry.setAttribute('color', new THREE.Float32BufferAttribute(finalColors, 3));

    const mat = this.innerMeshObject.material as THREE.MeshStandardMaterial;
    mat.vertexColors = true;
    mat.needsUpdate = true;
    this.sceneManager.requestRender();
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
    this.sceneManager.requestRender();
  }

  // ---------- Display decimation helpers ----------

  /**
   * Decimate a mesh for display using vertex clustering.
   * O(n) — groups vertices into a 3D grid and merges per cell.
   */
  private decimateForDisplay(
    meshData: MeshData,
    targetFaces: number
  ): {
    geometry: THREE.BufferGeometry;
    vertexMap: Uint32Array;
    decimatedVertexCount: number;
  } {
    const { positions, indices, vertexCount, faceCount } = meshData;

    // Bounding box
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < vertexCount; i++) {
      const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }

    // Grid resolution: aim for ~targetFaces/2 unique cells
    const targetVerts = targetFaces / 2;
    const gridRes = Math.max(10, Math.ceil(Math.cbrt(targetVerts)));

    const sizeX = (maxX - minX) || 1e-6;
    const sizeY = (maxY - minY) || 1e-6;
    const sizeZ = (maxZ - minZ) || 1e-6;
    const cellSizeX = sizeX / gridRes;
    const cellSizeY = sizeY / gridRes;
    const cellSizeZ = sizeZ / gridRes;

    // Map each vertex to a grid cell
    const vertexMap = new Uint32Array(vertexCount);
    const cellMap = new Map<number, number>(); // cellKey → cellId
    const cellSums: number[] = [];  // interleaved x,y,z sums
    const cellCounts: number[] = [];
    let nextCellId = 0;

    const gridY = gridRes + 1;
    const gridZ = (gridRes + 1) * (gridRes + 1);

    for (let i = 0; i < vertexCount; i++) {
      const x = positions[i * 3];
      const y = positions[i * 3 + 1];
      const z = positions[i * 3 + 2];

      const cx = Math.min(gridRes - 1, Math.floor((x - minX) / cellSizeX));
      const cy = Math.min(gridRes - 1, Math.floor((y - minY) / cellSizeY));
      const cz = Math.min(gridRes - 1, Math.floor((z - minZ) / cellSizeZ));

      const key = cx + cy * gridY + cz * gridZ;

      let cellId = cellMap.get(key);
      if (cellId === undefined) {
        cellId = nextCellId++;
        cellMap.set(key, cellId);
        cellSums.push(0, 0, 0);
        cellCounts.push(0);
      }

      cellSums[cellId * 3] += x;
      cellSums[cellId * 3 + 1] += y;
      cellSums[cellId * 3 + 2] += z;
      cellCounts[cellId]++;
      vertexMap[i] = cellId;
    }

    // Build decimated positions (cell centroids)
    const decimatedVertexCount = nextCellId;
    const newPositions = new Float32Array(decimatedVertexCount * 3);
    for (let c = 0; c < decimatedVertexCount; c++) {
      newPositions[c * 3] = cellSums[c * 3] / cellCounts[c];
      newPositions[c * 3 + 1] = cellSums[c * 3 + 1] / cellCounts[c];
      newPositions[c * 3 + 2] = cellSums[c * 3 + 2] / cellCounts[c];
    }

    // Remap indices, skip degenerate faces
    const newIndices: number[] = [];
    for (let f = 0; f < faceCount; f++) {
      const a = vertexMap[indices[f * 3]];
      const b = vertexMap[indices[f * 3 + 1]];
      const c = vertexMap[indices[f * 3 + 2]];
      if (a !== b && b !== c && a !== c) {
        newIndices.push(a, b, c);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(newPositions, 3));
    geometry.setIndex(new THREE.Uint32BufferAttribute(new Uint32Array(newIndices), 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    return { geometry, vertexMap, decimatedVertexCount };
  }

  /**
   * Remap vertex colors from full mesh to decimated mesh by averaging per cluster.
   */
  private remapColors(fullColors: Float32Array): Float32Array {
    const result = new Float32Array(this._decimatedVertexCount * 3);
    const counts = new Float32Array(this._decimatedVertexCount);

    const fullVertexCount = this._vertexMap!.length;
    for (let i = 0; i < fullVertexCount; i++) {
      const dv = this._vertexMap![i];
      result[dv * 3] += fullColors[i * 3];
      result[dv * 3 + 1] += fullColors[i * 3 + 1];
      result[dv * 3 + 2] += fullColors[i * 3 + 2];
      counts[dv]++;
    }

    for (let i = 0; i < this._decimatedVertexCount; i++) {
      if (counts[i] > 0) {
        result[i * 3] /= counts[i];
        result[i * 3 + 1] /= counts[i];
        result[i * 3 + 2] /= counts[i];
      }
    }

    return result;
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
    this.volumePreviewGroup = null;
  }

  public dispose(): void {
    this.clearAll();
    this.innerMaterial.dispose();
    this.outerMaterial.dispose();
    this.ghostMaterial.dispose();
    this.wireframeMaterial.dispose();
  }
}
