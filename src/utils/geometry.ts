// ============================================================
// GeoWear — Geometry Utility Functions
// ============================================================

import * as THREE from 'three';

/**
 * Compute the centroid of a position array (xyz interleaved).
 */
export function computeCentroid(positions: Float32Array): THREE.Vector3 {
  const count = positions.length / 3;
  let sx = 0, sy = 0, sz = 0;
  for (let i = 0; i < positions.length; i += 3) {
    sx += positions[i];
    sy += positions[i + 1];
    sz += positions[i + 2];
  }
  return new THREE.Vector3(sx / count, sy / count, sz / count);
}

/**
 * Compute the bounding box of a position array.
 */
export function computeBounds(positions: Float32Array): THREE.Box3 {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let i = 0; i < positions.length; i += 3) {
    v.set(positions[i], positions[i + 1], positions[i + 2]);
    box.expandByPoint(v);
  }
  return box;
}

/**
 * Compute face normal from three vertices.
 */
export function faceNormal(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number
): [number, number, number] {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  let nx = aby * acz - abz * acy;
  let ny = abz * acx - abx * acz;
  let nz = abx * acy - aby * acx;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len > 1e-12) {
    nx /= len; ny /= len; nz /= len;
  }
  return [nx, ny, nz];
}

/**
 * Compute the signed volume of a tetrahedron formed by a triangle and the origin.
 * Using the divergence theorem: V = (1/6) * v1 . (v2 x v3)
 */
export function signedTetraVolume(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number
): number {
  return (
    ax * (by * cz - bz * cy) +
    ay * (bz * cx - bx * cz) +
    az * (bx * cy - by * cx)
  ) / 6.0;
}

/**
 * Compute the area of a triangle.
 */
export function triangleArea(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number
): number {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  return 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
}

/**
 * Euclidean distance between two 3D points.
 */
export function dist3(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number
): number {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Dot product of two 3D vectors.
 */
export function dot3(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number
): number {
  return ax * bx + ay * by + az * bz;
}

/**
 * Normalize a 3D vector in-place, return length.
 */
export function normalize3(v: [number, number, number]): number {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (len > 1e-12) {
    v[0] /= len; v[1] /= len; v[2] /= len;
  }
  return len;
}

/**
 * Cross product of two 3D vectors.
 */
export function cross3(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number
): [number, number, number] {
  return [
    ay * bz - az * by,
    az * bx - ax * bz,
    ax * by - ay * bx,
  ];
}

/**
 * Project a point onto a sphere surface.
 */
export function projectOntoSphere(
  px: number, py: number, pz: number,
  cx: number, cy: number, cz: number,
  radius: number
): [number, number, number] {
  const dx = px - cx, dy = py - cy, dz = pz - cz;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (d < 1e-12) return [cx + radius, cy, cz];
  const scale = radius / d;
  return [cx + dx * scale, cy + dy * scale, cz + dz * scale];
}

/**
 * Compute spherical coordinates (latitude, longitude) relative to a sphere center and axis.
 */
export function toSpherical(
  px: number, py: number, pz: number,
  cx: number, cy: number, cz: number,
  axis: THREE.Vector3
): { lat: number; lon: number; r: number } {
  const dx = px - cx, dy = py - cy, dz = pz - cz;
  const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const v = new THREE.Vector3(dx, dy, dz);
  const cosLat = v.dot(axis) / r;
  const lat = Math.acos(Math.max(-1, Math.min(1, cosLat)));

  // Project onto plane perpendicular to axis
  const proj = v.clone().sub(axis.clone().multiplyScalar(v.dot(axis)));
  const lon = Math.atan2(proj.z, proj.x);

  return { lat, lon: lon < 0 ? lon + 2 * Math.PI : lon, r };
}

/**
 * Convert BufferGeometry to indexed form by welding vertices.
 * Returns merged positions, normals, and index array.
 */
export function weldVertices(
  positions: Float32Array,
  normals: Float32Array,
  tolerance: number = 1e-6
): { positions: Float32Array; normals: Float32Array; indices: Uint32Array } {
  const vertexCount = positions.length / 3;
  const hashMap = new Map<string, number>();
  const newPositions: number[] = [];
  const newNormals: number[] = [];
  const indices = new Uint32Array(vertexCount);
  let uniqueCount = 0;

  const factor = 1 / tolerance;

  for (let i = 0; i < vertexCount; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];

    // Quantize position for hash key
    const key = `${Math.round(x * factor)},${Math.round(y * factor)},${Math.round(z * factor)}`;

    const existing = hashMap.get(key);
    if (existing !== undefined) {
      indices[i] = existing;
      // Average the normals
      newNormals[existing * 3] += normals[i * 3];
      newNormals[existing * 3 + 1] += normals[i * 3 + 1];
      newNormals[existing * 3 + 2] += normals[i * 3 + 2];
    } else {
      hashMap.set(key, uniqueCount);
      indices[i] = uniqueCount;
      newPositions.push(x, y, z);
      newNormals.push(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]);
      uniqueCount++;
    }
  }

  // Normalize the averaged normals
  for (let i = 0; i < uniqueCount; i++) {
    const nx = newNormals[i * 3];
    const ny = newNormals[i * 3 + 1];
    const nz = newNormals[i * 3 + 2];
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 1e-12) {
      newNormals[i * 3] /= len;
      newNormals[i * 3 + 1] /= len;
      newNormals[i * 3 + 2] /= len;
    }
  }

  return {
    positions: new Float32Array(newPositions),
    normals: new Float32Array(newNormals),
    indices,
  };
}

/**
 * Build triangle index array from sequential vertex indices (non-indexed → indexed).
 * Input: indices from weldVertices (one per original vertex).
 * Output: triangle indices (3 per triangle).
 */
export function buildTriangleIndices(weldedIndices: Uint32Array): Uint32Array {
  // weldedIndices already maps each original vertex to its welded index
  // Original vertices form triangles in groups of 3
  const triCount = weldedIndices.length / 3;
  const result = new Uint32Array(triCount * 3);
  for (let i = 0; i < triCount; i++) {
    result[i * 3] = weldedIndices[i * 3];
    result[i * 3 + 1] = weldedIndices[i * 3 + 1];
    result[i * 3 + 2] = weldedIndices[i * 3 + 2];
  }
  return result;
}
