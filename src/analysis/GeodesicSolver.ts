// ============================================================
// GeoWear — GeodesicSolver
// Geodesic meridians via mesh-plane intersection
// Produces smooth great-circle-like curves on triangulated meshes
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
 */
export function findPoleVertex(
  positions: Float32Array,
  vertexCount: number,
  sphereCenter: [number, number, number],
  cupAxis: [number, number, number]
): number {
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
  const wx = cupAxis[0], wy = cupAxis[1], wz = cupAxis[2];

  let ux: number, uy: number, uz: number;
  if (Math.abs(wx) < 0.9) {
    ux = 0; uy = -wz; uz = wy;
  } else {
    ux = wz; uy = 0; uz = -wx;
  }
  let len = Math.sqrt(ux * ux + uy * uy + uz * uz);
  ux /= len; uy /= len; uz /= len;

  const vx = wy * uz - wz * uy;
  const vy = wz * ux - wx * uz;
  const vz = wx * uy - wy * ux;

  for (let i = 0; i < vertexCount; i++) {
    const dx = positions[i * 3] - sphereCenter[0];
    const dy = positions[i * 3 + 1] - sphereCenter[1];
    const dz = positions[i * 3 + 2] - sphereCenter[2];
    const projU = dx * ux + dy * uy + dz * uz;
    const projV = dx * vx + dy * vy + dz * vz;
    let angle = Math.atan2(projV, projU);
    if (angle < 0) angle += 2 * Math.PI;
    angles[i] = angle;
  }

  return angles;
}

/**
 * Build an equatorial coordinate system (U, V, W) for the cup.
 * W = cup axis, U and V span the equatorial plane.
 */
function buildLocalFrame(cupAxis: [number, number, number]): {
  U: [number, number, number];
  V: [number, number, number];
  W: [number, number, number];
} {
  const wx = cupAxis[0], wy = cupAxis[1], wz = cupAxis[2];
  let ux: number, uy: number, uz: number;
  if (Math.abs(wx) < 0.9) {
    ux = 0; uy = -wz; uz = wy;
  } else {
    ux = wz; uy = 0; uz = -wx;
  }
  let len = Math.sqrt(ux * ux + uy * uy + uz * uz);
  ux /= len; uy /= len; uz /= len;
  const vx = wy * uz - wz * uy;
  const vy = wz * ux - wx * uz;
  const vz = wx * uy - wy * ux;
  return {
    U: [ux, uy, uz],
    V: [vx, vy, vz],
    W: [wx, wy, wz],
  };
}

/**
 * Compute geodesic meridians by intersecting the mesh with meridian planes.
 *
 * For each meridian angle θ:
 *   1. Define a half-plane containing the cup axis at longitude θ
 *   2. Find all triangle edges that cross this plane
 *   3. Compute exact intersection points (interpolated on edges)
 *   4. Chain segments into a continuous polyline from pole to rim
 *
 * This produces smooth, straight meridian curves on the triangulated surface,
 * because intersection points lie exactly on the mesh faces.
 */
export function computeGeodesics(
  positions: Float32Array,
  vertexCount: number,
  graph: MeshGraph,
  poleVertex: number,
  sphereCenter: [number, number, number],
  cupAxis: [number, number, number],
  geodesicCount: number = 360,
  onProgress?: (progress: number) => void,
  indices?: Uint32Array
): Geodesic[] {
  const frame = buildLocalFrame(cupAxis);
  const [ux, uy, uz] = frame.U;
  const [vx, vy, vz] = frame.V;
  const [wx, wy, wz] = frame.W;

  const cx = sphereCenter[0], cy = sphereCenter[1], cz = sphereCenter[2];

  // Pole position
  const polePx = positions[poleVertex * 3];
  const polePy = positions[poleVertex * 3 + 1];
  const polePz = positions[poleVertex * 3 + 2];

  // Average radius for deviation computation
  let sumR = 0;
  for (let i = 0; i < vertexCount; i++) {
    const dx = positions[i * 3] - cx;
    const dy = positions[i * 3 + 1] - cy;
    const dz = positions[i * 3 + 2] - cz;
    sumR += Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  const avgRadius = sumR / vertexCount;

  // For each vertex, precompute:
  //   longitude (angle around axis) and latitude (angle from pole along axis)
  const lonPerVertex = new Float64Array(vertexCount);
  const latPerVertex = new Float64Array(vertexCount); // dot with W: high = near pole
  for (let i = 0; i < vertexCount; i++) {
    const dx = positions[i * 3] - cx;
    const dy = positions[i * 3 + 1] - cy;
    const dz = positions[i * 3 + 2] - cz;
    const pU = dx * ux + dy * uy + dz * uz;
    const pV = dx * vx + dy * vy + dz * vz;
    let lon = Math.atan2(pV, pU);
    if (lon < 0) lon += 2 * Math.PI;
    lonPerVertex[i] = lon;
    latPerVertex[i] = dx * wx + dy * wy + dz * wz; // projection on axis
  }

  // If we have triangle indices, use mesh-plane intersection
  // Otherwise fall back (should always have indices in our case)
  if (!indices) {
    // Shouldn't happen, but fallback to empty
    return [];
  }

  const faceCount = indices.length / 3;
  const geodesics: Geodesic[] = [];
  const angularStep = (2 * Math.PI) / geodesicCount;

  for (let g = 0; g < geodesicCount; g++) {
    const theta = g * angularStep;
    const angleDeg = (g * 360) / geodesicCount;

    // Meridian plane normal: perpendicular to both cup axis and the meridian direction
    // Direction in equatorial plane at angle theta: d = U*cos(theta) + V*sin(theta)
    // Plane normal: n = d × W (so the plane contains both W and d)
    // n = (U*cos + V*sin) × W
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    // d × W where d = U*cosT + V*sinT
    const nx = (uy * cosT + vy * sinT) * wz - (uz * cosT + vz * sinT) * wy;
    const ny = (uz * cosT + vz * sinT) * wx - (ux * cosT + vx * sinT) * wz;
    const nz = (ux * cosT + vx * sinT) * wy - (uy * cosT + vy * sinT) * wx;

    // Signed distance of each vertex to the meridian plane (plane passes through sphereCenter)
    // sd[i] = dot(pos[i] - center, n)
    // We'll compute per-vertex on the fly for each face

    // Collect intersection segments: pairs of points
    const segments: Array<{
      p1: [number, number, number];
      p2: [number, number, number];
      lat1: number; // latitude of p1
      lat2: number;
    }> = [];

    for (let f = 0; f < faceCount; f++) {
      const i0 = indices[f * 3];
      const i1 = indices[f * 3 + 1];
      const i2 = indices[f * 3 + 2];

      // Signed distances to the meridian plane
      const sd0 = (positions[i0 * 3] - cx) * nx + (positions[i0 * 3 + 1] - cy) * ny + (positions[i0 * 3 + 2] - cz) * nz;
      const sd1 = (positions[i1 * 3] - cx) * nx + (positions[i1 * 3 + 1] - cy) * ny + (positions[i1 * 3 + 2] - cz) * nz;
      const sd2 = (positions[i2 * 3] - cx) * nx + (positions[i2 * 3 + 1] - cy) * ny + (positions[i2 * 3 + 2] - cz) * nz;

      // Find edges that cross the plane (sd changes sign)
      const crossings: Array<[number, number, number]> = [];
      const crossLats: number[] = [];

      const edges: [number, number, number, number][] = [
        [i0, i1, sd0, sd1],
        [i1, i2, sd1, sd2],
        [i2, i0, sd2, sd0],
      ];

      for (const [ia, ib, sda, sdb] of edges) {
        if (sda * sdb < 0) {
          // Edge crosses the plane
          const t = sda / (sda - sdb);
          const px = positions[ia * 3] + t * (positions[ib * 3] - positions[ia * 3]);
          const py = positions[ia * 3 + 1] + t * (positions[ib * 3 + 1] - positions[ia * 3 + 1]);
          const pz = positions[ia * 3 + 2] + t * (positions[ib * 3 + 2] - positions[ia * 3 + 2]);
          crossings.push([px, py, pz]);

          // Latitude: projection onto cup axis
          const lat = (px - cx) * wx + (py - cy) * wy + (pz - cz) * wz;
          crossLats.push(lat);
        } else if (Math.abs(sda) < 1e-10) {
          // Vertex exactly on plane — include it
          crossings.push([
            positions[ia * 3],
            positions[ia * 3 + 1],
            positions[ia * 3 + 2],
          ]);
          crossLats.push(latPerVertex[ia]);
        }
      }

      if (crossings.length >= 2) {
        // Each triangle produces one segment (the intersection of the plane with the triangle)
        // Only keep points on the correct side (longitude ≈ theta, not theta+180°)
        // Check by seeing if the midpoint has longitude close to theta
        const mx = (crossings[0][0] + crossings[1][0]) / 2;
        const my = (crossings[0][1] + crossings[1][1]) / 2;
        const mz = (crossings[0][2] + crossings[1][2]) / 2;
        const mdx = mx - cx, mdy = my - cy, mdz = mz - cz;
        const mProjU = mdx * ux + mdy * uy + mdz * uz;
        const mProjV = mdx * vx + mdy * vy + mdz * vz;
        let mLon = Math.atan2(mProjV, mProjU);
        if (mLon < 0) mLon += 2 * Math.PI;

        let lonDiff = Math.abs(mLon - theta);
        if (lonDiff > Math.PI) lonDiff = 2 * Math.PI - lonDiff;

        if (lonDiff < Math.PI / 2) {
          // This segment is on the correct half-plane
          segments.push({
            p1: crossings[0],
            p2: crossings[1],
            lat1: crossLats[0],
            lat2: crossLats[1],
          });
        }
      }
    }

    if (segments.length === 0) {
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

    // Chain segments into an ordered polyline by sorting all intersection points
    // by latitude (projection on cup axis). High latitude = near pole.
    // Each segment contributes 2 points; we collect all unique points sorted by latitude.
    const allPoints: Array<{ pos: [number, number, number]; lat: number }> = [];
    for (const seg of segments) {
      allPoints.push({ pos: seg.p1, lat: seg.lat1 });
      allPoints.push({ pos: seg.p2, lat: seg.lat2 });
    }

    // Sort by latitude descending (pole first, rim last)
    allPoints.sort((a, b) => b.lat - a.lat);

    // Remove near-duplicate points (within epsilon)
    const eps = 1e-6;
    const uniquePoints: Array<{ pos: [number, number, number]; lat: number }> = [allPoints[0]];
    for (let i = 1; i < allPoints.length; i++) {
      const prev = uniquePoints[uniquePoints.length - 1];
      const dx = allPoints[i].pos[0] - prev.pos[0];
      const dy = allPoints[i].pos[1] - prev.pos[1];
      const dz = allPoints[i].pos[2] - prev.pos[2];
      if (dx * dx + dy * dy + dz * dz > eps * eps) {
        uniquePoints.push(allPoints[i]);
      }
    }

    // Add pole as the first point if not already very close
    const poleLatVal = (polePx - cx) * wx + (polePy - cy) * wy + (polePz - cz) * wz;
    if (uniquePoints.length > 0) {
      const first = uniquePoints[0];
      const dxP = polePx - first.pos[0];
      const dyP = polePy - first.pos[1];
      const dzP = polePz - first.pos[2];
      if (dxP * dxP + dyP * dyP + dzP * dzP > eps * eps) {
        uniquePoints.unshift({ pos: [polePx, polePy, polePz], lat: poleLatVal });
      }
    }

    // Sub-sample if too many points
    const maxPts = 500;
    let finalPoints = uniquePoints;
    if (uniquePoints.length > maxPts) {
      const step = (uniquePoints.length - 1) / (maxPts - 1);
      finalPoints = [];
      for (let i = 0; i < maxPts; i++) {
        finalPoints.push(uniquePoints[Math.round(i * step)]);
      }
    }

    // Build GeodesicPoint array
    const geoPoints: GeodesicPoint[] = [];
    let maxDev = -Infinity, minDev = Infinity;
    let cumulativeArc = 0;

    for (let i = 0; i < finalPoints.length; i++) {
      const [px, py, pz] = finalPoints[i].pos;

      // Arc length from previous point
      if (i > 0) {
        const [ppx, ppy, ppz] = finalPoints[i - 1].pos;
        const ddx = px - ppx, ddy = py - ppy, ddz = pz - ppz;
        cumulativeArc += Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
      }

      // Radial deviation
      const dx = px - cx, dy = py - cy, dz = pz - cz;
      const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const deviation = (r - avgRadius) * 1000; // mm → μm

      if (deviation > maxDev) maxDev = deviation;
      if (deviation < minDev) minDev = deviation;

      geoPoints.push({
        vertexIndex: -1, // intersection points aren't exact vertices
        position: [px, py, pz],
        arcLength: cumulativeArc,
        deviation,
        derivative: 0,
        secondDerivative: 0,
      });
    }

    // Compute first derivatives (central difference)
    for (let i = 1; i < geoPoints.length - 1; i++) {
      const ds = geoPoints[i + 1].arcLength - geoPoints[i - 1].arcLength;
      if (ds > 1e-12) {
        geoPoints[i].derivative = (geoPoints[i + 1].deviation - geoPoints[i - 1].deviation) / ds;
      }
    }
    if (geoPoints.length >= 2) {
      const ds0 = geoPoints[1].arcLength - geoPoints[0].arcLength;
      if (ds0 > 1e-12) {
        geoPoints[0].derivative = (geoPoints[1].deviation - geoPoints[0].deviation) / ds0;
      }
      const dsN = geoPoints[geoPoints.length - 1].arcLength - geoPoints[geoPoints.length - 2].arcLength;
      if (dsN > 1e-12) {
        geoPoints[geoPoints.length - 1].derivative =
          (geoPoints[geoPoints.length - 1].deviation - geoPoints[geoPoints.length - 2].deviation) / dsN;
      }
    }

    // Second derivatives
    for (let i = 1; i < geoPoints.length - 1; i++) {
      const ds = geoPoints[i + 1].arcLength - geoPoints[i - 1].arcLength;
      if (ds > 1e-12) {
        geoPoints[i].secondDerivative =
          (geoPoints[i + 1].derivative - geoPoints[i - 1].derivative) / ds;
      }
    }

    const anomalyCount = geoPoints.filter(p => Math.abs(p.deviation) > 1).length;

    geodesics.push({
      angle: angleDeg,
      points: geoPoints,
      totalLength: cumulativeArc,
      maxDeviation: maxDev,
      minDeviation: minDev,
      anomalyCount,
      isRegular: true, // classified later
    });

    if (onProgress) {
      onProgress((g + 1) / geodesicCount);
    }
  }

  // --- Common pole: compute average of all geodesics' first (pole-end) points ---
  // This ensures every geodesic converges to the exact same point.
  let avgPolX = 0, avgPolY = 0, avgPolZ = 0;
  let poleContribCount = 0;
  for (const geo of geodesics) {
    if (geo.points.length > 0) {
      avgPolX += geo.points[0].position[0];
      avgPolY += geo.points[0].position[1];
      avgPolZ += geo.points[0].position[2];
      poleContribCount++;
    }
  }
  if (poleContribCount > 0) {
    avgPolX /= poleContribCount;
    avgPolY /= poleContribCount;
    avgPolZ /= poleContribCount;
    // Replace every geodesic's first point with the common average pole
    for (const geo of geodesics) {
      if (geo.points.length > 0) {
        geo.points[0].position = [avgPolX, avgPolY, avgPolZ];
        // Recalculate arc length for first segment
        if (geo.points.length > 1) {
          const [nx, ny, nz] = geo.points[1].position;
          const ddx = nx - avgPolX, ddy = ny - avgPolY, ddz = nz - avgPolZ;
          geo.points[1].arcLength = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
        }
        // Deviation at the common pole
        const dx = avgPolX - cx, dy = avgPolY - cy, dz = avgPolZ - cz;
        const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
        geo.points[0].deviation = (r - avgRadius) * 1000;
      }
    }
  }

  return geodesics;
}
