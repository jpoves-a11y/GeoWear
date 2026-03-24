// ============================================================
// GeoWear — MeshSmoother
// Laplacian smoothing for mesh data to reduce tessellation noise
// while preserving the overall geometric shape.
// ============================================================

import type { MeshData } from '../types';

/**
 * Optional cleanup pass for scanned inner faces:
 * 1) fill small boundary holes (except the largest rim loop),
 * 2) apply a light Taubin smoothing to soften scan texture.
 */
export function repairInnerFaceMesh(
  meshData: MeshData,
  smoothingIterations: number = 2,
  maxHoleLoopSize: number = 40,
): MeshData {
  const holeFilled = fillSmallBoundaryHoles(meshData, maxHoleLoopSize);
  if (smoothingIterations <= 0) return holeFilled;
  return smoothMesh(holeFilled, smoothingIterations);
}

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
 * Fill small boundary holes by triangulating boundary loops with a fan.
 * The largest boundary loop is assumed to be the cup rim and is never filled.
 */
function fillSmallBoundaryHoles(meshData: MeshData, maxHoleLoopSize: number): MeshData {
  const { positions, normals, indices, vertexCount, faceCount } = meshData;

  // Count edge usage.
  const edgeUsage = new Map<string, { a: number; b: number; count: number }>();
  for (let f = 0; f < faceCount; f++) {
    for (let e = 0; e < 3; e++) {
      const a = indices[f * 3 + e];
      const b = indices[f * 3 + ((e + 1) % 3)];
      const min = Math.min(a, b);
      const max = Math.max(a, b);
      const key = `${min}_${max}`;
      const existing = edgeUsage.get(key);
      if (existing) existing.count++;
      else edgeUsage.set(key, { a, b, count: 1 });
    }
  }

  // Boundary adjacency from edges used by exactly one face.
  const boundaryAdj = new Map<number, Set<number>>();
  for (const [, edge] of edgeUsage) {
    if (edge.count !== 1) continue;
    if (!boundaryAdj.has(edge.a)) boundaryAdj.set(edge.a, new Set());
    if (!boundaryAdj.has(edge.b)) boundaryAdj.set(edge.b, new Set());
    boundaryAdj.get(edge.a)!.add(edge.b);
    boundaryAdj.get(edge.b)!.add(edge.a);
  }

  if (boundaryAdj.size === 0) {
    return {
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      indices: new Uint32Array(indices),
      vertexCount,
      faceCount,
    };
  }

  const loops: number[][] = [];
  const visited = new Set<number>();

  // Build ordered boundary loops/components.
  for (const start of boundaryAdj.keys()) {
    if (visited.has(start)) continue;

    // Collect component vertices first.
    const component: number[] = [];
    const stack = [start];
    visited.add(start);
    while (stack.length > 0) {
      const v = stack.pop()!;
      component.push(v);
      const nbs = boundaryAdj.get(v);
      if (!nbs) continue;
      for (const nb of nbs) {
        if (!visited.has(nb)) {
          visited.add(nb);
          stack.push(nb);
        }
      }
    }

    if (component.length < 3) continue;

    // Order the component as a chain/loop.
    const compSet = new Set(component);
    let orderedStart = component[0];
    for (const v of component) {
      const deg = Array.from(boundaryAdj.get(v) || []).filter(nb => compSet.has(nb)).length;
      if (deg === 1) {
        orderedStart = v;
        break;
      }
    }

    const ordered: number[] = [];
    let prev = -1;
    let curr = orderedStart;
    const guardMax = component.length + 4;

    for (let guard = 0; guard < guardMax; guard++) {
      ordered.push(curr);
      const nbs = Array.from(boundaryAdj.get(curr) || []).filter(nb => compSet.has(nb));
      let next = -1;
      if (nbs.length === 0) break;
      if (nbs.length === 1) {
        next = nbs[0] === prev ? -1 : nbs[0];
      } else {
        next = nbs[0] === prev ? nbs[1] : nbs[0];
      }
      if (next < 0 || next === orderedStart) break;
      prev = curr;
      curr = next;
    }

    if (ordered.length >= 3) loops.push(ordered);
  }

  if (loops.length === 0) {
    return {
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      indices: new Uint32Array(indices),
      vertexCount,
      faceCount,
    };
  }

  // Skip the largest boundary loop (real cup rim opening).
  let largestLoopIdx = 0;
  for (let i = 1; i < loops.length; i++) {
    if (loops[i].length > loops[largestLoopIdx].length) largestLoopIdx = i;
  }

  const posOut = Array.from(positions);
  const idxOut = Array.from(indices);
  let filledAny = false;

  for (let li = 0; li < loops.length; li++) {
    if (li === largestLoopIdx) continue;
    const loop = loops[li];
    if (loop.length < 3 || loop.length > maxHoleLoopSize) continue;

    let cx = 0, cy = 0, cz = 0;
    let nx = 0, ny = 0, nz = 0;
    for (const v of loop) {
      cx += positions[v * 3];
      cy += positions[v * 3 + 1];
      cz += positions[v * 3 + 2];
      nx += normals[v * 3];
      ny += normals[v * 3 + 1];
      nz += normals[v * 3 + 2];
    }
    cx /= loop.length;
    cy /= loop.length;
    cz /= loop.length;

    // Orient loop consistently with average boundary normal.
    let lnx = 0, lny = 0, lnz = 0;
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      const ax = positions[a * 3] - cx;
      const ay = positions[a * 3 + 1] - cy;
      const az = positions[a * 3 + 2] - cz;
      const bx = positions[b * 3] - cx;
      const by = positions[b * 3 + 1] - cy;
      const bz = positions[b * 3 + 2] - cz;
      lnx += ay * bz - az * by;
      lny += az * bx - ax * bz;
      lnz += ax * by - ay * bx;
    }
    const dot = lnx * nx + lny * ny + lnz * nz;
    if (dot < 0) loop.reverse();

    const centerIdx = posOut.length / 3;
    posOut.push(cx, cy, cz);

    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      idxOut.push(a, b, centerIdx);
    }

    filledAny = true;
  }

  if (!filledAny) {
    return {
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      indices: new Uint32Array(indices),
      vertexCount,
      faceCount,
    };
  }

  const posArr = new Float32Array(posOut);
  const idxArr = new Uint32Array(idxOut);
  const vCount = posArr.length / 3;
  const fCount = idxArr.length / 3;
  const nrmArr = recomputeNormals(posArr, idxArr, vCount);

  return {
    positions: posArr,
    normals: nrmArr,
    indices: idxArr,
    vertexCount: vCount,
    faceCount: fCount,
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
