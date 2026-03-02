// ============================================================
// GeoWear — GeodesicSolver
// Geodesic computation on mesh using Dijkstra + angular slicing
// Optimized for 360 meridians on >1M triangle meshes
// ============================================================

import { MeshGraph, PriorityQueue } from '../math/MeshGraph';
import type { GeodesicPoint, Geodesic } from '../types';

/**
 * Compute geodesic distance from a single source vertex to all other vertices.
 * Uses Dijkstra's algorithm on the mesh adjacency graph.
 */
export function dijkstraDistances(
  graph: MeshGraph,
  source: number
): { distances: Float64Array; predecessors: Int32Array } {
  const n = graph.vertexCount;
  const distances = new Float64Array(n);
  const predecessors = new Int32Array(n);
  const visited = new Uint8Array(n);

  distances.fill(Infinity);
  predecessors.fill(-1);
  distances[source] = 0;

  const pq = new PriorityQueue();
  pq.push(source, 0);

  while (pq.size > 0) {
    const current = pq.pop()!;
    const u = current.vertex;

    if (visited[u]) continue;
    visited[u] = 1;

    const start = graph.offsets[u];
    const end = graph.offsets[u + 1];

    for (let i = start; i < end; i++) {
      const v = graph.neighbors[i];
      if (visited[v]) continue;

      const newDist = distances[u] + graph.weights[i];
      if (newDist < distances[v]) {
        distances[v] = newDist;
        predecessors[v] = u;
        pq.push(v, newDist);
      }
    }
  }

  return { distances, predecessors };
}

/**
 * Find the pole vertex (bottom of the cup).
 * The pole is the vertex on the inner mesh closest to the projection
 * of the sphere center along the cup axis.
 */
export function findPoleVertex(
  positions: Float32Array,
  vertexCount: number,
  sphereCenter: [number, number, number],
  cupAxis: [number, number, number]
): number {
  // The pole is the point farthest along the cup axis direction from the center
  // (cup axis points from rim toward pole)
  let maxProj = -Infinity;
  let poleIdx = 0;

  for (let i = 0; i < vertexCount; i++) {
    const dx = positions[i * 3] - sphereCenter[0];
    const dy = positions[i * 3 + 1] - sphereCenter[1];
    const dz = positions[i * 3 + 2] - sphereCenter[2];
    const proj = dx * cupAxis[0] + dy * cupAxis[1] + dz * cupAxis[2];
    if (proj > maxProj) {
      maxProj = proj;
      poleIdx = i;
    }
  }

  return poleIdx;
}

/**
 * Compute the angular position of each vertex relative to the pole and cup axis.
 * Returns longitude angle [0, 2π) for each vertex.
 */
export function computeVertexAngles(
  positions: Float32Array,
  vertexCount: number,
  polePosition: [number, number, number],
  sphereCenter: [number, number, number],
  cupAxis: [number, number, number]
): Float64Array {
  const angles = new Float64Array(vertexCount);

  // Build a local coordinate system at the pole:
  // W = cupAxis (from center toward pole)
  // U, V = orthogonal axes in the plane perpendicular to W
  const wx = cupAxis[0], wy = cupAxis[1], wz = cupAxis[2];

  // Find a vector not parallel to W
  let ux: number, uy: number, uz: number;
  if (Math.abs(wx) < 0.9) {
    // Cross W with X
    ux = 0; uy = -wz; uz = wy;
  } else {
    // Cross W with Y
    ux = wz; uy = 0; uz = -wx;
  }
  let len = Math.sqrt(ux * ux + uy * uy + uz * uz);
  ux /= len; uy /= len; uz /= len;

  // V = W × U
  const vx = wy * uz - wz * uy;
  const vy = wz * ux - wx * uz;
  const vz = wx * uy - wy * ux;

  for (let i = 0; i < vertexCount; i++) {
    // Direction from sphere center to vertex
    const dx = positions[i * 3] - sphereCenter[0];
    const dy = positions[i * 3 + 1] - sphereCenter[1];
    const dz = positions[i * 3 + 2] - sphereCenter[2];

    // Project onto U and V to get the angular position
    const projU = dx * ux + dy * uy + dz * uz;
    const projV = dx * vx + dy * vy + dz * vz;

    let angle = Math.atan2(projV, projU);
    if (angle < 0) angle += 2 * Math.PI;
    angles[i] = angle;
  }

  return angles;
}

/**
 * Trace geodesic meridians from the pole outward to the rim.
 *
 * For each angular slice (0°-359°), we:
 * 1. Find the farthest reachable vertex within the angular band (rim vertex)
 * 2. Trace the Dijkstra predecessor chain from that rim vertex back to the pole
 * 3. This produces a connected path along actual mesh edges (a true geodesic)
 */
export function computeGeodesics(
  positions: Float32Array,
  vertexCount: number,
  graph: MeshGraph,
  poleVertex: number,
  sphereCenter: [number, number, number],
  cupAxis: [number, number, number],
  geodesicCount: number = 360,
  onProgress?: (progress: number) => void
): Geodesic[] {
  // Step 1: Compute distances from pole
  const { distances, predecessors } = dijkstraDistances(graph, poleVertex);

  // Step 2: Compute angular positions
  const polePos: [number, number, number] = [
    positions[poleVertex * 3],
    positions[poleVertex * 3 + 1],
    positions[poleVertex * 3 + 2],
  ];
  const angles = computeVertexAngles(positions, vertexCount, polePos, sphereCenter, cupAxis);

  // Compute sphere radius for deviation calculation
  let sumR = 0;
  for (let i = 0; i < vertexCount; i++) {
    const dx = positions[i * 3] - sphereCenter[0];
    const dy = positions[i * 3 + 1] - sphereCenter[1];
    const dz = positions[i * 3 + 2] - sphereCenter[2];
    sumR += Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  const avgRadius = sumR / vertexCount;

  // Step 3: For each angular slice, trace a geodesic meridian
  const geodesics: Geodesic[] = [];
  const angularStep = (2 * Math.PI) / geodesicCount;
  const bandHalf = angularStep * 0.6; // narrow band to pick the rim target

  for (let g = 0; g < geodesicCount; g++) {
    const targetAngle = g * angularStep;
    const angleDeg = (g * 360) / geodesicCount;

    // Find the farthest vertex within the angular band (rim endpoint)
    let rimVertex = -1;
    let rimDist = -1;

    for (let i = 0; i < vertexCount; i++) {
      if (distances[i] === Infinity || i === poleVertex) continue;

      let angleDiff = Math.abs(angles[i] - targetAngle);
      if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;

      if (angleDiff <= bandHalf && distances[i] > rimDist) {
        rimDist = distances[i];
        rimVertex = i;
      }
    }

    if (rimVertex < 0) {
      // No vertex found in this band — emit empty geodesic
      geodesics.push({
        angle: angleDeg,
        points: [],
        totalLength: 0,
        maxDeviation: 0,
        minDeviation: 0,
        anomalyCount: 0,
        isRegular: true,
      });
      if (onProgress) onProgress((g + 1) / geodesicCount);
      continue;
    }

    // Trace predecessor chain from rim → pole (reverse path)
    const pathReversed: number[] = [];
    let current = rimVertex;
    const maxSteps = vertexCount; // safety limit
    let steps = 0;

    while (current !== -1 && steps < maxSteps) {
      pathReversed.push(current);
      if (current === poleVertex) break;
      current = predecessors[current];
      steps++;
    }

    // Reverse to get pole → rim order
    const path = pathReversed.reverse();

    // Sub-sample if too many vertices (large meshes can have very long paths)
    const maxPoints = 500;
    let sampledPath: number[];
    if (path.length > maxPoints) {
      const sampleStep = (path.length - 1) / (maxPoints - 1);
      sampledPath = [];
      for (let i = 0; i < maxPoints; i++) {
        sampledPath.push(path[Math.round(i * sampleStep)]);
      }
    } else {
      sampledPath = path;
    }

    // Build geodesic points
    const points: GeodesicPoint[] = [];
    let maxDev = -Infinity, minDev = Infinity;

    for (const vi of sampledPath) {
      const px = positions[vi * 3];
      const py = positions[vi * 3 + 1];
      const pz = positions[vi * 3 + 2];

      const dx = px - sphereCenter[0];
      const dy = py - sphereCenter[1];
      const dz = pz - sphereCenter[2];
      const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const deviation = (r - avgRadius) * 1000; // mm → μm

      if (deviation > maxDev) maxDev = deviation;
      if (deviation < minDev) minDev = deviation;

      points.push({
        vertexIndex: vi,
        position: [px, py, pz],
        arcLength: distances[vi],
        deviation,
        derivative: 0,
        secondDerivative: 0,
      });
    }

    // Compute first derivatives (central difference)
    for (let i = 1; i < points.length - 1; i++) {
      const ds = points[i + 1].arcLength - points[i - 1].arcLength;
      if (ds > 1e-12) {
        points[i].derivative = (points[i + 1].deviation - points[i - 1].deviation) / ds;
      }
    }
    // Forward/backward difference at endpoints
    if (points.length >= 2) {
      const ds0 = points[1].arcLength - points[0].arcLength;
      if (ds0 > 1e-12) {
        points[0].derivative = (points[1].deviation - points[0].deviation) / ds0;
      }
      const dsN = points[points.length - 1].arcLength - points[points.length - 2].arcLength;
      if (dsN > 1e-12) {
        points[points.length - 1].derivative =
          (points[points.length - 1].deviation - points[points.length - 2].deviation) / dsN;
      }
    }

    // Second derivatives
    for (let i = 1; i < points.length - 1; i++) {
      const ds = points[i + 1].arcLength - points[i - 1].arcLength;
      if (ds > 1e-12) {
        points[i].secondDerivative =
          (points[i + 1].derivative - points[i - 1].derivative) / ds;
      }
    }

    // Count anomalies
    const anomalyCount = points.filter(p => Math.abs(p.deviation) > 1).length;

    geodesics.push({
      angle: angleDeg,
      points,
      totalLength: points.length > 0 ? points[points.length - 1].arcLength : 0,
      maxDeviation: maxDev,
      minDeviation: minDev,
      anomalyCount,
      isRegular: true, // classified later by curvature analysis
    });

    if (onProgress) {
      onProgress((g + 1) / geodesicCount);
    }
  }

  return geodesics;
}
