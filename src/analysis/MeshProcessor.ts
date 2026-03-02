// ============================================================
// GeoWear — MeshProcessor
// Inner/outer face detection, rim trimming, vertex welding
// ============================================================

import type { MeshData, SeparationResult, TrimResult } from '../types';
import { faceNormal } from '../utils/geometry';

/**
 * Separate inner (concave) and outer (convex) faces of a hemispherical cup.
 * 
 * Algorithm:
 * 1. Compute mesh centroid
 * 2. Compute principal axis (PCA or bounding box)
 * 3. For each face, check if normal points toward or away from centroid
 * 4. Inner faces (concave): face normal points toward centroid (negative dot product)
 * 5. Outer faces (convex): face normal points away from centroid
 */
export function separateFaces(meshData: MeshData): SeparationResult {
  const { positions, normals, indices } = meshData;
  const faceCount = indices.length / 3;

  // Step 1: Compute centroid
  let cx = 0, cy = 0, cz = 0;
  const totalVerts = positions.length / 3;
  for (let i = 0; i < positions.length; i += 3) {
    cx += positions[i];
    cy += positions[i + 1];
    cz += positions[i + 2];
  }
  cx /= totalVerts;
  cy /= totalVerts;
  cz /= totalVerts;

  // Step 2: Build face data for robust filtering
  type FaceInfo = {
    index: number;
    v0: number;
    v1: number;
    v2: number;
    cx: number;
    cy: number;
    cz: number;
    dot: number;
    distance: number;
  };

  const faceData: FaceInfo[] = [];
  const distances: number[] = [];

  for (let f = 0; f < faceCount; f++) {
    const i0 = indices[f * 3];
    const i1 = indices[f * 3 + 1];
    const i2 = indices[f * 3 + 2];

    const ax = positions[i0 * 3];
    const ay = positions[i0 * 3 + 1];
    const az = positions[i0 * 3 + 2];
    const bx = positions[i1 * 3];
    const by = positions[i1 * 3 + 1];
    const bz = positions[i1 * 3 + 2];
    const cxp = positions[i2 * 3];
    const cyp = positions[i2 * 3 + 1];
    const czp = positions[i2 * 3 + 2];

    const fcx = (ax + bx + cxp) / 3;
    const fcy = (ay + by + cyp) / 3;
    const fcz = (az + bz + czp) / 3;

    const [fnx, fny, fnz] = faceNormal(ax, ay, az, bx, by, bz, cxp, cyp, czp);
    const dtx = cx - fcx;
    const dty = cy - fcy;
    const dtz = cz - fcz;
    const dlen = Math.sqrt(dtx * dtx + dty * dty + dtz * dtz) || 1;
    const tnx = dtx / dlen;
    const tny = dty / dlen;
    const tnz = dtz / dlen;
    const dot = fnx * tnx + fny * tny + fnz * tnz;
    const distance = dlen;

    faceData.push({ index: f, v0: i0, v1: i1, v2: i2, cx: fcx, cy: fcy, cz: fcz, dot, distance });
    distances.push(distance);
  }

  // Step 3: Robust normal + distance filter (inner is closer to centroid, concave normals)
  distances.sort((a, b) => a - b);
  const q1 = distances[Math.floor(distances.length * 0.25)] ?? 0;
  const q3 = distances[Math.floor(distances.length * 0.75)] ?? 0;
  const maxDistance = q3 || q1 || Infinity;

  let candidateFaces = faceData.filter(f => f.dot > 0.5 && f.distance <= maxDistance);
  if (candidateFaces.length === 0) {
    candidateFaces = faceData.filter(f => f.dot > 0);
  }

  // Step 4: Keep largest connected component (shared vertices)
  const vertexToFaces = new Map<number, number[]>();
  for (const f of candidateFaces) {
    const verts = [f.v0, f.v1, f.v2];
    for (const v of verts) {
      const list = vertexToFaces.get(v);
      if (list) list.push(f.index);
      else vertexToFaces.set(v, [f.index]);
    }
  }

  const adjacency = new Map<number, Set<number>>();
  for (const f of candidateFaces) adjacency.set(f.index, new Set());

  for (const f of candidateFaces) {
    const neighbors = adjacency.get(f.index)!;
    const verts = [f.v0, f.v1, f.v2];
    for (const v of verts) {
      const list = vertexToFaces.get(v);
      if (!list) continue;
      for (const n of list) {
        if (n !== f.index) neighbors.add(n);
      }
    }
  }

  const visited = new Set<number>();
  const components: number[][] = [];
  for (const f of candidateFaces) {
    if (visited.has(f.index)) continue;
    const queue: number[] = [f.index];
    const component: number[] = [];
    visited.add(f.index);
    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);
      const neighbors = adjacency.get(current);
      if (!neighbors) continue;
      for (const n of neighbors) {
        if (!visited.has(n)) {
          visited.add(n);
          queue.push(n);
        }
      }
    }
    components.push(component);
  }

  components.sort((a, b) => b.length - a.length);
  const innerFaceSet = new Set<number>(components[0] ?? []);
  const innerFaces: number[] = [];
  const outerFaces: number[] = [];
  for (let f = 0; f < faceCount; f++) {
    if (innerFaceSet.has(f)) innerFaces.push(f);
    else outerFaces.push(f);
  }

  // Step 5: Build separated mesh data
  let inner = buildMeshFromFaces(positions, normals, indices, innerFaces);
  let outer = buildMeshFromFaces(positions, normals, indices, outerFaces);

  // Sanity check: inner surface should be closer to the centroid than outer surface.
  // If not, swap to correct misclassification due to centroid or normal issues.
  const innerMean = meanDistanceToPoint(inner.positions, cx, cy, cz);
  const outerMean = meanDistanceToPoint(outer.positions, cx, cy, cz);
  if (innerMean > outerMean) {
    const temp = inner;
    inner = outer;
    outer = temp;
  }

  // Step 4: Determine cup axis (from centroid to innermost point)
  // The cup axis is the direction from the rim center to the pole (bottom of the cup)
  const axis = computeCupAxis(inner.positions, cx, cy, cz);

  return {
    inner,
    outer,
    centroid: [cx, cy, cz],
    cupAxis: axis,
  };
}

/**
 * Build a MeshData from selected face indices.
 */
function buildMeshFromFaces(
  positions: Float32Array,
  normals: Float32Array,
  indices: Uint32Array,
  faceIndices: number[]
): MeshData {
  const newPositions: number[] = [];
  const newNormals: number[] = [];
  const newIndices: number[] = [];
  const vertexMap = new Map<number, number>();
  let newVertexCount = 0;

  for (const f of faceIndices) {
    const i0 = indices[f * 3];
    const i1 = indices[f * 3 + 1];
    const i2 = indices[f * 3 + 2];
    const faceVerts = [i0, i1, i2];

    for (const oldIdx of faceVerts) {
      let newIdx = vertexMap.get(oldIdx);
      if (newIdx === undefined) {
        newIdx = newVertexCount++;
        vertexMap.set(oldIdx, newIdx);
        newPositions.push(
          positions[oldIdx * 3],
          positions[oldIdx * 3 + 1],
          positions[oldIdx * 3 + 2]
        );
        newNormals.push(
          normals[oldIdx * 3],
          normals[oldIdx * 3 + 1],
          normals[oldIdx * 3 + 2]
        );
      }
      newIndices.push(newIdx);
    }
  }

  return {
    positions: new Float32Array(newPositions),
    normals: new Float32Array(newNormals),
    indices: new Uint32Array(newIndices),
    vertexCount: newVertexCount,
    faceCount: faceIndices.length,
  };
}

function meanDistanceToPoint(
  positions: Float32Array,
  cx: number,
  cy: number,
  cz: number
): number {
  const n = positions.length / 3;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < positions.length; i += 3) {
    const dx = positions[i] - cx;
    const dy = positions[i + 1] - cy;
    const dz = positions[i + 2] - cz;
    sum += Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  return sum / n;
}

/**
 * Compute the cup axis direction (from rim center to pole).
 * Uses PCA: the principal axis with the smallest extent corresponds to
 * the "thickness" direction; the axis with largest spread is across the opening.
 * The cup axis is the direction from the centroid to the farthest point
 * in the direction perpendicular to the opening plane.
 */
function computeCupAxis(
  positions: Float32Array,
  cx: number, cy: number, cz: number
): [number, number, number] {
  const n = positions.length / 3;
  if (n === 0) return [0, 1, 0];

  // Compute covariance matrix
  let cxx = 0, cxy = 0, cxz = 0, cyy = 0, cyz = 0, czz = 0;
  for (let i = 0; i < positions.length; i += 3) {
    const dx = positions[i] - cx;
    const dy = positions[i + 1] - cy;
    const dz = positions[i + 2] - cz;
    cxx += dx * dx; cxy += dx * dy; cxz += dx * dz;
    cyy += dy * dy; cyz += dy * dz; czz += dz * dz;
  }
  cxx /= n; cxy /= n; cxz /= n;
  cyy /= n; cyz /= n; czz /= n;

  // Simple power iteration to find the principal eigenvector
  // (the direction of greatest variance — across the opening)
  let vx = 1, vy = 0, vz = 0;
  for (let iter = 0; iter < 50; iter++) {
    const nx = cxx * vx + cxy * vy + cxz * vz;
    const ny = cxy * vx + cyy * vy + cyz * vz;
    const nz = cxz * vx + cyz * vy + czz * vz;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len < 1e-12) break;
    vx = nx / len; vy = ny / len; vz = nz / len;
  }

  // The cup axis is perpendicular to the principal variance direction
  // Actually, for a hemisphere, the axis of symmetry has the LEAST variance
  // So we want the eigenvector with the smallest eigenvalue
  // Better approach: find the point farthest from centroid and use that direction
  let maxDist = 0;
  let farthestIdx = 0;
  for (let i = 0; i < positions.length; i += 3) {
    const dx = positions[i] - cx;
    const dy = positions[i + 1] - cy;
    const dz = positions[i + 2] - cz;
    const d = dx * dx + dy * dy + dz * dz;
    if (d > maxDist) {
      maxDist = d;
      farthestIdx = i;
    }
  }

  // Direction from centroid to farthest point (rim edge)
  // The cup axis is roughly opposite to this
  // For a hemisphere, the centroid is offset toward the opening
  // So the axis points from centroid toward the pole (deepest point)
  
  // Find the point closest to the centroid (the pole is typically near the centroid for concave surface)
  // Actually for the inner surface of a hemisphere, the centroid of the inner surface
  // is at the center of the opening, and the pole is the farthest point from the average
  // position of boundary vertices.
  
  // Simpler: The cup axis is the eigenvector with smallest eigenvalue
  // Let's use deflation to find it
  // Remove the principal component and find the next
  // But even simpler for a hemisphere: use the average normal direction
  let anx = 0, any = 0, anz = 0;
  const normals = positions; // We'll recompute from positions
  // Actually, we need normals. Let's just use the Y axis heuristic or
  // try a different approach: the axis is perpendicular to the "opening plane"
  
  // Heuristic: for most STL scans of acetabular cups, the axis is close to Y or Z
  // Use the eigenvector approach: smallest eigenvalue eigenvector
  
  // For now, use power iteration with deflation
  const eigenval1 = cxx * vx * vx + 2 * cxy * vx * vy + 2 * cxz * vx * vz + cyy * vy * vy + 2 * cyz * vy * vz + czz * vz * vz;
  
  // Deflate
  const d_cxx = cxx - eigenval1 * vx * vx;
  const d_cxy = cxy - eigenval1 * vx * vy;
  const d_cxz = cxz - eigenval1 * vx * vz;
  const d_cyy = cyy - eigenval1 * vy * vy;
  const d_cyz = cyz - eigenval1 * vy * vz;
  const d_czz = czz - eigenval1 * vz * vz;
  
  // Second eigenvector
  let v2x = 0, v2y = 1, v2z = 0;
  for (let iter = 0; iter < 50; iter++) {
    const nx = d_cxx * v2x + d_cxy * v2y + d_cxz * v2z;
    const ny = d_cxy * v2x + d_cyy * v2y + d_cyz * v2z;
    const nz = d_cxz * v2x + d_cyz * v2y + d_czz * v2z;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len < 1e-12) break;
    v2x = nx / len; v2y = ny / len; v2z = nz / len;
  }
  
  // Third eigenvector = cross product of first two (smallest eigenvalue)
  let axisX = vy * v2z - vz * v2y;
  let axisY = vz * v2x - vx * v2z;
  let axisZ = vx * v2y - vy * v2x;
  const axisLen = Math.sqrt(axisX * axisX + axisY * axisY + axisZ * axisZ);
  if (axisLen > 1e-12) {
    axisX /= axisLen; axisY /= axisLen; axisZ /= axisLen;
  } else {
    // Fallback
    axisX = 0; axisY = 1; axisZ = 0;
  }

  // Ensure axis points from rim toward pole (into the cup)
  // The pole should be in the direction where vertices are most sparse
  // For inner surface, the pole is the point farthest along the negative axis
  // Check: if most vertices are on the positive side, flip
  let positiveSide = 0;
  for (let i = 0; i < positions.length; i += 3) {
    const dx = positions[i] - cx;
    const dy = positions[i + 1] - cy;
    const dz = positions[i + 2] - cz;
    const dot = dx * axisX + dy * axisY + dz * axisZ;
    if (dot > 0) positiveSide++;
  }
  // If more vertices on positive side, the opening is positive, pole is negative
  // Flip axis to point toward pole
  if (positiveSide > n / 2) {
    axisX = -axisX; axisY = -axisY; axisZ = -axisZ;
  }

  return [axisX, axisY, axisZ];
}

/**
 * Trim the top 'percent' of the mesh near the rim of the cup.
 * Height is measured along the cup axis.
 */
export function trimRim(meshData: MeshData, cupAxis: [number, number, number], percent: number): TrimResult {
  const { positions, normals, indices } = meshData;
  const vertexCount = meshData.vertexCount;
  const faceCount = meshData.faceCount;

  // --- Detect rim using boundary edges ---
  // Find all boundary edges (shared by only 1 face)
  const edgeFaceCount = new Map<string, number>();
  for (let f = 0; f < faceCount; f++) {
    for (let e = 0; e < 3; e++) {
      const a = indices[f * 3 + e];
      const b = indices[f * 3 + ((e + 1) % 3)];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      edgeFaceCount.set(key, (edgeFaceCount.get(key) || 0) + 1);
    }
  }

  // Collect boundary edges as adjacency among boundary vertices
  const boundaryAdj = new Map<number, Set<number>>();
  for (const [key, count] of edgeFaceCount) {
    if (count === 1) {
      const parts = key.split('_');
      const va = Number(parts[0]);
      const vb = Number(parts[1]);
      if (!boundaryAdj.has(va)) boundaryAdj.set(va, new Set());
      if (!boundaryAdj.has(vb)) boundaryAdj.set(vb, new Set());
      boundaryAdj.get(va)!.add(vb);
      boundaryAdj.get(vb)!.add(va);
    }
  }

  // Group boundary vertices into connected loops/chains
  // The rim of the cup is the LARGEST connected boundary loop
  const visitedBoundary = new Set<number>();
  const boundaryLoops: Set<number>[] = [];
  for (const startVert of boundaryAdj.keys()) {
    if (visitedBoundary.has(startVert)) continue;
    const loop = new Set<number>();
    const queue = [startVert];
    visitedBoundary.add(startVert);
    while (queue.length > 0) {
      const v = queue.pop()!;
      loop.add(v);
      const neighbors = boundaryAdj.get(v);
      if (neighbors) {
        for (const nb of neighbors) {
          if (!visitedBoundary.has(nb)) {
            visitedBoundary.add(nb);
            queue.push(nb);
          }
        }
      }
    }
    boundaryLoops.push(loop);
  }

  // Use only the largest boundary loop (the actual rim) as seed
  let boundaryVerts = new Set<number>();
  if (boundaryLoops.length > 0) {
    boundaryLoops.sort((a, b) => b.size - a.size);
    boundaryVerts = boundaryLoops[0];
    console.log(`[trimRim] Found ${boundaryLoops.length} boundary loops. Largest (rim): ${boundaryVerts.size} verts. Others: ${boundaryLoops.slice(1).map(l => l.size).join(', ') || 'none'}`);
  }

  // --- Build adjacency for BFS geodesic distance ---
  const adj: Array<number[]> = new Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) adj[i] = [];
  for (let f = 0; f < faceCount; f++) {
    const a = indices[f * 3], b = indices[f * 3 + 1], c = indices[f * 3 + 2];
    adj[a].push(b); adj[a].push(c);
    adj[b].push(a); adj[b].push(c);
    adj[c].push(a); adj[c].push(b);
  }

  // --- Compute geodesic distance from boundary using Dijkstra ---
  // This ensures homogeneous trimming: every point at the same
  // mesh-walking distance from the rim edge gets treated equally.
  const dist = new Float32Array(vertexCount);
  dist.fill(Infinity);

  // Priority queue (simple array-based for correctness)
  // Entry: [distance, vertexIndex]
  const heap: Array<[number, number]> = [];
  const push = (d: number, v: number) => {
    heap.push([d, v]);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent][0] <= heap[i][0]) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
  };
  const pop = (): [number, number] | undefined => {
    if (heap.length === 0) return undefined;
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      while (true) {
        let smallest = i;
        const l = 2 * i + 1, r = 2 * i + 2;
        if (l < heap.length && heap[l][0] < heap[smallest][0]) smallest = l;
        if (r < heap.length && heap[r][0] < heap[smallest][0]) smallest = r;
        if (smallest === i) break;
        [heap[smallest], heap[i]] = [heap[i], heap[smallest]];
        i = smallest;
      }
    }
    return top;
  };

  // Seed: all boundary vertices at distance 0
  for (const bv of boundaryVerts) {
    dist[bv] = 0;
    push(0, bv);
  }

  // Dijkstra from all boundary vertices simultaneously
  const visited = new Uint8Array(vertexCount);
  while (heap.length > 0) {
    const [d, u] = pop()!;
    if (visited[u]) continue;
    visited[u] = 1;
    const neighbors = adj[u];
    for (let i = 0; i < neighbors.length; i++) {
      const v = neighbors[i];
      if (visited[v]) continue;
      const dx = positions[v * 3] - positions[u * 3];
      const dy = positions[v * 3 + 1] - positions[u * 3 + 1];
      const dz = positions[v * 3 + 2] - positions[u * 3 + 2];
      const edgeLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const newDist = d + edgeLen;
      if (newDist < dist[v]) {
        dist[v] = newDist;
        push(newDist, v);
      }
    }
  }

  // Find max geodesic distance from boundary
  let maxDist = 0;
  for (let i = 0; i < vertexCount; i++) {
    if (dist[i] !== Infinity && dist[i] > maxDist) maxDist = dist[i];
  }

  // Threshold: remove vertices within percent% of max geodesic distance from rim
  const distThreshold = (percent / 100) * maxDist;

  // Also compute heights for TrimResult metadata
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < positions.length; i += 3) {
    cx += positions[i]; cy += positions[i + 1]; cz += positions[i + 2];
  }
  cx /= vertexCount; cy /= vertexCount; cz /= vertexCount;
  let minHeight = Infinity, maxHeight = -Infinity;
  for (let i = 0; i < vertexCount; i++) {
    const h = (positions[i*3]-cx)*cupAxis[0] + (positions[i*3+1]-cy)*cupAxis[1] + (positions[i*3+2]-cz)*cupAxis[2];
    if (h < minHeight) minHeight = h;
    if (h > maxHeight) maxHeight = h;
  }

  // Filter: keep faces where ALL vertices are beyond threshold (away from rim)
  const keptFaces: number[] = [];
  for (let f = 0; f < faceCount; f++) {
    const i0 = indices[f * 3];
    const i1 = indices[f * 3 + 1];
    const i2 = indices[f * 3 + 2];
    if (dist[i0] > distThreshold && dist[i1] > distThreshold && dist[i2] > distThreshold) {
      keptFaces.push(f);
    }
  }

  // Build set of kept face indices for quick lookup
  const keptFaceSet = new Set<number>(keptFaces);
  const removedFaces: number[] = [];
  for (let f = 0; f < faceCount; f++) {
    if (!keptFaceSet.has(f)) removedFaces.push(f);
  }

  // Rebuild mesh from kept faces
  const newFaceCount = keptFaces.length;
  const newPositions: number[] = [];
  const newNormals: number[] = [];
  const vertexMap = new Map<number, number>();
  const newIndices: number[] = [];
  let newVertexCount = 0;

  for (const f of keptFaces) {
    for (let v = 0; v < 3; v++) {
      const oldIdx = indices[f * 3 + v];
      let newIdx = vertexMap.get(oldIdx);
      if (newIdx === undefined) {
        newIdx = newVertexCount++;
        vertexMap.set(oldIdx, newIdx);
        newPositions.push(
          positions[oldIdx * 3],
          positions[oldIdx * 3 + 1],
          positions[oldIdx * 3 + 2]
        );
        newNormals.push(
          normals[oldIdx * 3],
          normals[oldIdx * 3 + 1],
          normals[oldIdx * 3 + 2]
        );
      }
      newIndices.push(newIdx);
    }
  }

  // Build mesh from removed faces (rim)
  const rimFaceCount = removedFaces.length;
  const rimPositions: number[] = [];
  const rimNormals: number[] = [];
  const rimVertexMap = new Map<number, number>();
  const rimIndices: number[] = [];
  let rimVertexCount = 0;

  for (const f of removedFaces) {
    for (let v = 0; v < 3; v++) {
      const oldIdx = indices[f * 3 + v];
      let rimIdx = rimVertexMap.get(oldIdx);
      if (rimIdx === undefined) {
        rimIdx = rimVertexCount++;
        rimVertexMap.set(oldIdx, rimIdx);
        rimPositions.push(
          positions[oldIdx * 3],
          positions[oldIdx * 3 + 1],
          positions[oldIdx * 3 + 2]
        );
        rimNormals.push(
          normals[oldIdx * 3],
          normals[oldIdx * 3 + 1],
          normals[oldIdx * 3 + 2]
        );
      }
      rimIndices.push(rimIdx);
    }
  }

  return {
    mesh: {
      positions: new Float32Array(newPositions),
      normals: new Float32Array(newNormals),
      indices: new Uint32Array(newIndices),
      vertexCount: newVertexCount,
      faceCount: newFaceCount,
    },
    rimMesh: {
      positions: new Float32Array(rimPositions),
      normals: new Float32Array(rimNormals),
      indices: new Uint32Array(rimIndices),
      vertexCount: rimVertexCount,
      faceCount: rimFaceCount,
    },
    rimPercentRemoved: percent,
    heightRange: [minHeight, maxHeight],
  };
}
