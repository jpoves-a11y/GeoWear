// ============================================================
// GeoWear — MeshSmoother
// Laplacian smoothing for mesh data to reduce tessellation noise
// while preserving the overall geometric shape.
// ============================================================

import type { MeshData } from '../types';

/** Result returned by repairInnerFaceMesh — includes the repaired mesh and info about filled holes for visualisation. */
export interface RepairResult {
  meshData: MeshData;
  /** Index of the first face added by hole fill (equals original faceCount). Use to slice the index buffer for the overlay. */
  filledFaceStart: number;
  /** Number of holes that were filled (0 when no holes found or all exceeded maxHoleLoopSize). */
  holeCount: number;
}

/**
 * Sphere-fit data used to guide hole fill center-vertex placement.
 * The center vertex of each fan-fill is placed on the fitted sphere surface,
 * guaranteeing it is always within the cup geometry.
 */
export interface GeodesicRepairData {
  /** Preliminary fitted sphere center (mesh-local coordinates). */
  sphereCenter: [number, number, number];
  /** Preliminary fitted sphere radius (mm). */
  R: number;
}

/**
 * Optional cleanup pass for scanned inner faces:
 * 1) fill small boundary holes (except the largest rim loop),
 * 2) apply a light Taubin smoothing to soften scan texture.
 *
 * maxHoleLoopSize raised to 1000 (from 300) to handle larger scanning artefacts.
 *
 * @param seeds  Optional mesh-local seed points. Each seed forces the hole whose
 *               boundary centroid is closest to it to be filled, even when the
 *               loop exceeds maxHoleLoopSize. Useful for large artefact holes.
 */
export function repairInnerFaceMesh(
  meshData: MeshData,
  smoothingIterations: number = 2,
  maxHoleLoopSize: number = 1000,
  seeds?: [number, number, number][],
  geoData?: GeodesicRepairData,
): RepairResult {
  const result = fillSmallBoundaryHoles(meshData, maxHoleLoopSize, seeds, geoData);
  if (smoothingIterations <= 0) return result;
  const smoothedData = smoothMesh(result.meshData, smoothingIterations);
  return { ...result, meshData: smoothedData };
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

/** Compute the total perimeter length of a closed boundary loop (3-D). */
function computeLoopPerimeter(loop: number[], positions: Float32Array): number {
  let perimeter = 0;
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % n];
    const dx = positions[a * 3] - positions[b * 3];
    const dy = positions[a * 3 + 1] - positions[b * 3 + 1];
    const dz = positions[a * 3 + 2] - positions[b * 3 + 2];
    perimeter += Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  return perimeter;
}

/**
 * Extract all closed boundary loops by greedily walking boundary adjacency.
 *
 * Each vertex is visited at most once globally. The algorithm handles:
 *  - degree-2 vertices (normal closed loops) correctly
 *  - degree-1 endpoints (open chains): returned as-is, the caller closes them via modulo
 *  - degree-3+ T-junctions: picks the first unvisited non-prev neighbour and continues
 *
 * This replaces the old two-phase (DFS component + ordering) approach that could
 * silently discard loops when the greedy walk happened to terminate early.
 */
function extractBoundaryLoops(adj: Map<number, Set<number>>): number[][] {
  const loops: number[][] = [];
  const globalVisited = new Set<number>();

  for (const start of adj.keys()) {
    if (globalVisited.has(start)) continue;

    const loop: number[] = [];
    const loopSet  = new Set<number>();
    let prev = -1;
    let curr = start;

    for (let step = 0; step <= adj.size + 1; step++) {
      if (globalVisited.has(curr)) break;   // merges into an already-traced loop

      loop.push(curr);
      loopSet.add(curr);
      globalVisited.add(curr);

      const nbs = adj.get(curr);
      if (!nbs) break;

      let next = -1;
      for (const nb of nbs) {
        if (nb === prev) continue;
        // Allow closing back to the start vertex (loop complete)
        if (nb === start && loop.length >= 3) { next = -2; break; }
        if (loopSet.has(nb) || globalVisited.has(nb)) continue;
        next = nb;
        break;
      }

      if (next < 0) break;   // −1 = dead end / open chain,  −2 = loop closed
      prev = curr;
      curr = next;
    }

    if (loop.length >= 3) loops.push(loop);
  }

  return loops;
}

/**
 * Fill small boundary holes by triangulating boundary loops with a fan.
 *
 * When geoData is provided, the fan's center vertex is placed by extrapolating
 * the geodesic meridian trajectory that passes through the hole, constrained
 * to the [rimS, poleS] range along the cup axis.  Without geoData the legacy
 * sphere-offset centroid (r²/2R) is used as the center position.
 *
 * KEY IMPROVEMENT: the rim loop is now identified by the LARGEST PERIMETER (mm),
 * not the largest vertex count.
 *
 * Returns the repaired mesh together with metadata needed for hole visualisation.
 */
function fillSmallBoundaryHoles(
  meshData: MeshData,
  maxHoleLoopSize: number,
  seeds?: [number, number, number][],
  geoData?: GeodesicRepairData,
): RepairResult {
  const { positions, normals, indices, vertexCount, faceCount } = meshData;

  // --- Build boundary edge adjacency (edges used exactly once = boundary) ---
  const edgeUsage = new Map<string, { a: number; b: number; count: number }>();
  for (let f = 0; f < faceCount; f++) {
    for (let e = 0; e < 3; e++) {
      const a = indices[f * 3 + e];
      const b = indices[f * 3 + ((e + 1) % 3)];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const ex = edgeUsage.get(key);
      if (ex) ex.count++;
      else edgeUsage.set(key, { a, b, count: 1 });
    }
  }

  const boundaryAdj = new Map<number, Set<number>>();
  for (const [, edge] of edgeUsage) {
    if (edge.count !== 1) continue;
    if (!boundaryAdj.has(edge.a)) boundaryAdj.set(edge.a, new Set());
    if (!boundaryAdj.has(edge.b)) boundaryAdj.set(edge.b, new Set());
    boundaryAdj.get(edge.a)!.add(edge.b);
    boundaryAdj.get(edge.b)!.add(edge.a);
  }

  const noRepairResult: RepairResult = {
    meshData: {
      positions: new Float32Array(positions),
      normals:   new Float32Array(normals),
      indices:   new Uint32Array(indices),
      vertexCount,
      faceCount,
    },
    filledFaceStart: faceCount,
    holeCount: 0,
  };

  if (boundaryAdj.size === 0) return noRepairResult;

  // --- Extract all closed boundary loops ---
  const loops = extractBoundaryLoops(boundaryAdj);
  if (loops.length === 0) return noRepairResult;

  // --- Identify rim = loop with the LARGEST PERIMETER ---
  // Using actual 3-D perimeter is more reliable than vertex count:
  // the rim spans the full cup opening (~160-190 mm for typical cups),
  // while any interior hole is far smaller (<60 mm for worst-case large defects).
  let rimLoopIdx = 0;
  let maxPerimeter = -1;
  for (let i = 0; i < loops.length; i++) {
    const perim = computeLoopPerimeter(loops[i], positions);
    if (perim > maxPerimeter) { maxPerimeter = perim; rimLoopIdx = i; }
  }

  // --- Fan-fill all non-rim loops within the user-specified vertex-count limit ---
  // A loop is also filled when a user seed point is closest to its centroid.
  const posOut = Array.from(positions);
  const idxOut = Array.from(indices);
  const filledFaceStart = faceCount;
  let holeCount = 0;

  // Pre-compute loop centroids once (needed for seed matching)
  const loopCentroids: [number, number, number][] = loops.map((loop) => {
    let cx = 0, cy = 0, cz = 0;
    for (const v of loop) {
      cx += positions[v * 3];
      cy += positions[v * 3 + 1];
      cz += positions[v * 3 + 2];
    }
    const n = loop.length;
    return [cx / n, cy / n, cz / n];
  });

  // For each seed, mark the closest non-rim loop (by centroid distance) as forced.
  const forcedBySeeds = new Set<number>();
  if (seeds && seeds.length > 0) {
    for (const seed of seeds) {
      let bestDist = Infinity;
      let bestIdx = -1;
      for (let li = 0; li < loops.length; li++) {
        if (li === rimLoopIdx) continue;
        const [cx, cy, cz] = loopCentroids[li];
        const dx = seed[0] - cx, dy = seed[1] - cy, dz = seed[2] - cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestDist) { bestDist = d2; bestIdx = li; }
      }
      if (bestIdx >= 0) forcedBySeeds.add(bestIdx);
    }
  }

  for (let li = 0; li < loops.length; li++) {
    if (li === rimLoopIdx) continue;
    const loop = loops[li];
    if (loop.length < 3) continue;
    // Fill if within size limit OR if a seed forced this loop
    if (loop.length > maxHoleLoopSize && !forcedBySeeds.has(li)) continue;

    // Compute loop centroid and average normal
    let cx = 0, cy = 0, cz = 0;
    let nx = 0, ny = 0, nz = 0;
    for (const v of loop) {
      cx += positions[v * 3];     cy += positions[v * 3 + 1];     cz += positions[v * 3 + 2];
      nx += normals[v * 3];       ny += normals[v * 3 + 1];       nz += normals[v * 3 + 2];
    }
    const nv = loop.length;
    cx /= nv; cy /= nv; cz /= nv;

    if (geoData) {
      // Geodesic-guided center: follow the meridian trajectory through the hole,
      // clamped to the valid [rimS, poleS] cup-axis range.
      [cx, cy, cz] = computeGeodesicHoleCenter(loop, positions, cx, cy, cz, geoData);
    } else {
      // Legacy: offset centroid outward along average normal to approximate sphere curvature
      let avgDist = 0;
      for (const v of loop) {
        const dx = positions[v * 3] - cx;
        const dy = positions[v * 3 + 1] - cy;
        const dz = positions[v * 3 + 2] - cz;
        avgDist += Math.sqrt(dx * dx + dy * dy + dz * dz);
      }
      avgDist /= nv;
      const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      const offset = (avgDist * avgDist) / (2 * 15.0);   // r²/(2R), R≈15 mm nominal
      cx += (nx / nLen) * offset;
      cy += (ny / nLen) * offset;
      cz += (nz / nLen) * offset;
    }

    // Orient fan triangles to face the same way as the surrounding surface
    let lnx = 0, lny = 0, lnz = 0;
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      const ax = positions[a * 3] - cx, ay = positions[a * 3 + 1] - cy, az = positions[a * 3 + 2] - cz;
      const bx = positions[b * 3] - cx, by = positions[b * 3 + 1] - cy, bz = positions[b * 3 + 2] - cz;
      lnx += ay * bz - az * by;
      lny += az * bx - ax * bz;
      lnz += ax * by - ay * bx;
    }
    if (lnx * nx + lny * ny + lnz * nz < 0) loop.reverse();

    const centerIdx = posOut.length / 3;
    posOut.push(cx, cy, cz);
    for (let i = 0; i < loop.length; i++) {
      idxOut.push(loop[i], loop[(i + 1) % loop.length], centerIdx);
    }
    holeCount++;
  }

  if (holeCount === 0) return noRepairResult;

  const posArr = new Float32Array(posOut);
  const idxArr = new Uint32Array(idxOut);
  const vCount = posArr.length / 3;
  const fCount = idxArr.length / 3;
  const nrmArr = recomputeNormals(posArr, idxArr, vCount);

  return {
    meshData: { positions: posArr, normals: nrmArr, indices: idxArr, vertexCount: vCount, faceCount: fCount },
    filledFaceStart,
    holeCount,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sphere-surface hole fill helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the center-vertex position for fan-triangulating a hole by projecting
 * the hole centroid radially onto the fitted sphere surface.
 *
 * This replaces the previous meridian-extrapolation approach, which could produce
 * wildly out-of-bounds positions when meridian data near the hole was sparse or
 * noisy (unstable regression slope → large lateral drift uncaught by s-clamp).
 *
 * The radial projection is guaranteed to land exactly on the sphere surface and
 * can never exceed the geometry bounds regardless of hole size or scan quality.
 */
function computeGeodesicHoleCenter(
  _loop: number[],
  _positions: Float32Array,
  hcx: number, hcy: number, hcz: number, // pre-computed hole centroid
  g: GeodesicRepairData,
): [number, number, number] {
  const [scx, scy, scz] = g.sphereCenter;
  const dx = hcx - scx, dy = hcy - scy, dz = hcz - scz;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 1e-9) return [scx, scy, scz]; // degenerate: centroid at sphere center
  const scale = g.R / len;
  return [scx + dx * scale, scy + dy * scale, scz + dz * scale];
}

// ─────────────────────────────────────────────────────────────────────────────

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
