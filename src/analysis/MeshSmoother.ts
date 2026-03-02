// ============================================================
// GeoWear — MeshSmoother
// Laplacian smoothing for mesh data to reduce tessellation noise
// while preserving the overall geometric shape.
// ============================================================

import type { MeshData } from '../types';

/**
 * Build an adjacency list from the index buffer.
 * Returns an array where neighbors[v] = Set of vertex indices adjacent to v.
 */
function buildAdjacency(indices: Uint32Array, vertexCount: number): Array<Set<number>> {
  const adj: Array<Set<number>> = new Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) adj[i] = new Set();

  const faceCount = indices.length / 3;
  for (let f = 0; f < faceCount; f++) {
    const a = indices[f * 3];
    const b = indices[f * 3 + 1];
    const c = indices[f * 3 + 2];
    adj[a].add(b); adj[a].add(c);
    adj[b].add(a); adj[b].add(c);
    adj[c].add(a); adj[c].add(b);
  }

  return adj;
}

/**
 * Apply Taubin smoothing (λ|μ) to a mesh.
 *
 * Unlike simple Laplacian smoothing which shrinks the mesh,
 * Taubin smoothing alternates between a smoothing step (λ > 0)
 * and an inflation step (μ < 0) to preserve volume/shape.
 *
 * This removes high-frequency tessellation noise while keeping
 * the low-frequency shape (wear patterns) intact.
 *
 * @param meshData   The mesh to smooth (positions are NOT modified in place)
 * @param iterations Number of Taubin iterations (each = 1 smooth + 1 inflate)
 * @param lambda     Smoothing factor (0 < λ < 1), default 0.5
 * @param mu         Inflation factor (μ < -λ), default -0.53
 * @returns A new MeshData with smoothed positions (same indices/normals)
 */
export function smoothMesh(
  meshData: MeshData,
  iterations: number = 3,
  lambda: number = 0.5,
  mu: number = -0.53,
): MeshData {
  if (iterations <= 0) {
    // No smoothing — return a copy
    return {
      positions: new Float32Array(meshData.positions),
      normals: new Float32Array(meshData.normals),
      indices: new Uint32Array(meshData.indices),
      vertexCount: meshData.vertexCount,
      faceCount: meshData.faceCount,
    };
  }

  const { indices, vertexCount } = meshData;
  const adj = buildAdjacency(indices, vertexCount);

  // Work on a copy of positions
  let pos = new Float32Array(meshData.positions);
  const tmp = new Float32Array(vertexCount * 3);

  for (let iter = 0; iter < iterations; iter++) {
    // --- Smoothing pass (λ) ---
    applyLaplacianStep(pos, adj, vertexCount, lambda, tmp);
    // Swap: tmp becomes pos for next step
    const swap1 = pos;
    pos = tmp;

    // --- Inflation pass (μ) ---
    applyLaplacianStep(pos, adj, vertexCount, mu, swap1);
    pos = swap1;
  }

  // Recompute normals from the smoothed positions
  const normals = recomputeNormals(pos, indices, vertexCount);

  return {
    positions: pos,
    normals,
    indices: new Uint32Array(meshData.indices),
    vertexCount: meshData.vertexCount,
    faceCount: meshData.faceCount,
  };
}

/**
 * Apply one Laplacian step: newPos[v] = pos[v] + factor * Δ(v)
 * where Δ(v) = average(neighbors) - pos[v]
 */
function applyLaplacianStep(
  pos: Float32Array,
  adj: Array<Set<number>>,
  vertexCount: number,
  factor: number,
  out: Float32Array,
): void {
  for (let v = 0; v < vertexCount; v++) {
    const neighbors = adj[v];
    if (neighbors.size === 0) {
      out[v * 3] = pos[v * 3];
      out[v * 3 + 1] = pos[v * 3 + 1];
      out[v * 3 + 2] = pos[v * 3 + 2];
      continue;
    }

    // Compute Laplacian: average of neighbors minus current position
    let avgX = 0, avgY = 0, avgZ = 0;
    for (const n of neighbors) {
      avgX += pos[n * 3];
      avgY += pos[n * 3 + 1];
      avgZ += pos[n * 3 + 2];
    }
    const count = neighbors.size;
    avgX /= count;
    avgY /= count;
    avgZ /= count;

    const lapX = avgX - pos[v * 3];
    const lapY = avgY - pos[v * 3 + 1];
    const lapZ = avgZ - pos[v * 3 + 2];

    out[v * 3] = pos[v * 3] + factor * lapX;
    out[v * 3 + 1] = pos[v * 3 + 1] + factor * lapY;
    out[v * 3 + 2] = pos[v * 3 + 2] + factor * lapZ;
  }
}

/**
 * Recompute per-vertex normals from face normals (area-weighted average).
 */
function recomputeNormals(
  positions: Float32Array,
  indices: Uint32Array,
  vertexCount: number,
): Float32Array {
  const normals = new Float32Array(vertexCount * 3);
  const faceCount = indices.length / 3;

  for (let f = 0; f < faceCount; f++) {
    const a = indices[f * 3];
    const b = indices[f * 3 + 1];
    const c = indices[f * 3 + 2];

    // Edge vectors
    const abx = positions[b * 3] - positions[a * 3];
    const aby = positions[b * 3 + 1] - positions[a * 3 + 1];
    const abz = positions[b * 3 + 2] - positions[a * 3 + 2];
    const acx = positions[c * 3] - positions[a * 3];
    const acy = positions[c * 3 + 1] - positions[a * 3 + 1];
    const acz = positions[c * 3 + 2] - positions[a * 3 + 2];

    // Cross product (not normalized — magnitude proportional to area)
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;

    // Accumulate for each vertex of the face
    normals[a * 3] += nx; normals[a * 3 + 1] += ny; normals[a * 3 + 2] += nz;
    normals[b * 3] += nx; normals[b * 3 + 1] += ny; normals[b * 3 + 2] += nz;
    normals[c * 3] += nx; normals[c * 3 + 1] += ny; normals[c * 3 + 2] += nz;
  }

  // Normalize
  for (let v = 0; v < vertexCount; v++) {
    const x = normals[v * 3];
    const y = normals[v * 3 + 1];
    const z = normals[v * 3 + 2];
    const len = Math.sqrt(x * x + y * y + z * z);
    if (len > 1e-12) {
      normals[v * 3] /= len;
      normals[v * 3 + 1] /= len;
      normals[v * 3 + 2] /= len;
    }
  }

  return normals;
}
