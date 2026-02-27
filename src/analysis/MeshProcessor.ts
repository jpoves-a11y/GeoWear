// ============================================================
// GeoWear — MeshProcessor
// Inner/outer face detection, rim trimming, vertex welding
// ============================================================

import type { MeshData, SeparationResult, TrimResult } from '../types';
import { weldVertices, buildTriangleIndices } from '../utils/geometry';

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
  const { positions, normals } = meshData;
  const faceCount = positions.length / 9; // 3 vertices * 3 components per face

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

  // Step 2: Classify faces
  const innerFaces: number[] = [];
  const outerFaces: number[] = [];

  for (let f = 0; f < faceCount; f++) {
    const baseIdx = f * 9; // 3 vertices * 3 components

    // Face centroid
    const fcx = (positions[baseIdx] + positions[baseIdx + 3] + positions[baseIdx + 6]) / 3;
    const fcy = (positions[baseIdx + 1] + positions[baseIdx + 4] + positions[baseIdx + 7]) / 3;
    const fcz = (positions[baseIdx + 2] + positions[baseIdx + 5] + positions[baseIdx + 8]) / 3;

    // Face normal (average of vertex normals for that face)
    const fnx = (normals[baseIdx] + normals[baseIdx + 3] + normals[baseIdx + 6]) / 3;
    const fny = (normals[baseIdx + 1] + normals[baseIdx + 4] + normals[baseIdx + 7]) / 3;
    const fnz = (normals[baseIdx + 2] + normals[baseIdx + 5] + normals[baseIdx + 8]) / 3;

    // Direction from mesh centroid to face centroid
    const dx = fcx - cx;
    const dy = fcy - cy;
    const dz = fcz - cz;

    // Dot product: negative means normal points toward centroid (inner/concave surface)
    const dot = fnx * dx + fny * dy + fnz * dz;

    if (dot < 0) {
      innerFaces.push(f);
    } else {
      outerFaces.push(f);
    }
  }

  // Step 3: Build separated mesh data
  const inner = buildMeshFromFaces(positions, normals, innerFaces);
  const outer = buildMeshFromFaces(positions, normals, outerFaces);

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
  faceIndices: number[]
): MeshData {
  const faceCount = faceIndices.length;
  const vertexCount = faceCount * 3;
  const newPositions = new Float32Array(vertexCount * 3);
  const newNormals = new Float32Array(vertexCount * 3);

  for (let i = 0; i < faceCount; i++) {
    const srcBase = faceIndices[i] * 9;
    const dstBase = i * 9;
    for (let j = 0; j < 9; j++) {
      newPositions[dstBase + j] = positions[srcBase + j];
      newNormals[dstBase + j] = normals[srcBase + j];
    }
  }

  // Weld vertices for efficient processing
  const welded = weldVertices(newPositions, newNormals);
  const triIndices = buildTriangleIndices(welded.indices);

  return {
    positions: welded.positions,
    normals: welded.normals,
    indices: triIndices,
    vertexCount: welded.positions.length / 3,
    faceCount,
  };
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

  // Compute centroid of the mesh
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < positions.length; i += 3) {
    cx += positions[i];
    cy += positions[i + 1];
    cz += positions[i + 2];
  }
  cx /= vertexCount;
  cy /= vertexCount;
  cz /= vertexCount;

  // Project each vertex onto the cup axis to get "height"
  const heights = new Float32Array(vertexCount);
  let minHeight = Infinity, maxHeight = -Infinity;

  for (let i = 0; i < vertexCount; i++) {
    const dx = positions[i * 3] - cx;
    const dy = positions[i * 3 + 1] - cy;
    const dz = positions[i * 3 + 2] - cz;
    const h = dx * cupAxis[0] + dy * cupAxis[1] + dz * cupAxis[2];
    heights[i] = h;
    if (h < minHeight) minHeight = h;
    if (h > maxHeight) maxHeight = h;
  }

  const heightRange = maxHeight - minHeight;
  // Cup axis points toward pole (negative height = pole, positive = rim)
  // Actually, cupAxis points toward the pole, so the pole has the most negative projection
  // and the rim has the most positive. We want to remove the rim (highest values).
  // Wait: the axis points from rim to pole, so pole = most positive projection.
  // We actually want to remove vertices near the rim = most negative projection.
  // Let's reconsider: the axis is defined as pointing from centroid toward the pole.
  // So vertices at the pole have the largest positive projection, and rim vertices
  // have the most negative projection. We want to REMOVE the rim (most negative).
  
  // Actually let's just remove the top `percent` based on distance from the pole.
  // The pole is the point with the maximum projection along the cup axis.
  // We want to keep vertices within (100-percent)% of the max height range.
  
  // Threshold: remove vertices whose height (along axis, relative to pole) > (100-percent)% of range
  // Height relative to pole: poleHeight - height[i]
  // If this distance > (1 - percent/100) * heightRange, remove it (it's near the rim)
  
  const threshold = maxHeight - (percent / 100) * heightRange;

  // Filter triangles: keep only if ALL three vertices are above the threshold
  // (i.e., closer to the pole than the cutoff)
  const keptFaces: number[] = [];
  
  for (let f = 0; f < faceCount; f++) {
    const i0 = indices[f * 3];
    const i1 = indices[f * 3 + 1];
    const i2 = indices[f * 3 + 2];

    // Keep face if all vertices have height > threshold (closer to pole)
    if (heights[i0] >= threshold && heights[i1] >= threshold && heights[i2] >= threshold) {
      // Wait, this is wrong. Heights closer to pole are MORE positive (axis points to pole).
      // So rim vertices have the LEAST positive height. We want height < threshold to be removed.
      // threshold = maxHeight - (percent/100)*range
      // Vertices with height < threshold are near the rim → remove them.
      // Keep vertices with height >= threshold.
      keptFaces.push(f);
    }
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

  return {
    mesh: {
      positions: new Float32Array(newPositions),
      normals: new Float32Array(newNormals),
      indices: new Uint32Array(newIndices),
      vertexCount: newVertexCount,
      faceCount: newFaceCount,
    },
    rimPercentRemoved: percent,
    heightRange: [minHeight, maxHeight],
  };
}
