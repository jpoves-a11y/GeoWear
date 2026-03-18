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
  private volumePreviewGroup: THREE.Group | null = null;

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
    visible: boolean = false
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

    // --- 1. Mesh enclosed volume (blue, filled) ---
    // Inner face surface on the pole side of the rim plane
    const faceCount = meshData.indices.length / 3;
    const filteredIndices: number[] = [];
    for (let f = 0; f < faceCount; f++) {
      const i0 = meshData.indices[f * 3];
      const i1 = meshData.indices[f * 3 + 1];
      const i2 = meshData.indices[f * 3 + 2];
      const d0 = (meshData.positions[i0 * 3] - planePoint.x) * pn.x +
                 (meshData.positions[i0 * 3 + 1] - planePoint.y) * pn.y +
                 (meshData.positions[i0 * 3 + 2] - planePoint.z) * pn.z;
      const d1 = (meshData.positions[i1 * 3] - planePoint.x) * pn.x +
                 (meshData.positions[i1 * 3 + 1] - planePoint.y) * pn.y +
                 (meshData.positions[i1 * 3 + 2] - planePoint.z) * pn.z;
      const d2 = (meshData.positions[i2 * 3] - planePoint.x) * pn.x +
                 (meshData.positions[i2 * 3 + 1] - planePoint.y) * pn.y +
                 (meshData.positions[i2 * 3 + 2] - planePoint.z) * pn.z;

      // Keep only triangles fully on the pole side to avoid faces crossing the rim plane.
      if (Math.min(d0, d1, d2) >= -0.01) filteredIndices.push(i0, i1, i2);
    }

    const meshGeo = new THREE.BufferGeometry();
    meshGeo.setAttribute('position', new THREE.Float32BufferAttribute(meshData.positions, 3));
    if (meshData.normals.length > 0) {
      meshGeo.setAttribute('normal', new THREE.Float32BufferAttribute(meshData.normals, 3));
    }
    meshGeo.setIndex(filteredIndices);
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
    const capGeo = this.buildBoundaryCapGeometry(meshData.positions, filteredIndices, planePoint, pn);
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

  public setMeshVolumeVisible(visible: boolean): void {
    if (!this.volumePreviewGroup) return;
    this.volumePreviewGroup.visible = true;
    const surf = this.volumePreviewGroup.getObjectByName('vol-mesh-surface');
    const cap = this.volumePreviewGroup.getObjectByName('vol-mesh-cap');
    if (surf) surf.visible = visible;
    if (cap) cap.visible = visible;
  }

  public setSphereCapVisible(visible: boolean): void {
    if (!this.volumePreviewGroup) return;
    this.volumePreviewGroup.visible = true;
    const cap = this.volumePreviewGroup.getObjectByName('vol-sphere-cap');
    if (cap) cap.visible = visible;
  }

  public showOriginal(): void {
    const orig = this.originalGroup.getObjectByName('original-mesh');
    if (orig) orig.visible = true;
  }

  public setOriginalVisible(visible: boolean): void {
    // Show/hide ALL STL surface meshes (original + analysis inner/outer/ghost)
    const stlNames = new Set(['original-mesh', 'inner-mesh', 'outer-mesh', 'ghost-mesh', 'wireframe']);
    this.originalGroup.children.forEach(child => {
      if (stlNames.has(child.name)) {
        child.visible = visible;
      }
    });
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
