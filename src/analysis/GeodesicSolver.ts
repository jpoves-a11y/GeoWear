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
export function buildLocalFrame(cupAxis: [number, number, number]): {
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

  // --- Longitude culling: precompute per-face centroid longitude and angular radius ---
  // This allows skipping faces that can't intersect a given meridian plane,
  // reducing work from O(360 × faceCount) to ~O(360 × faceCount/18).
  const LONGITUDE_MARGIN = Math.PI / 36; // 5° safety margin
  const poleLat = latPerVertex[poleVertex];
  const POLE_LAT_THRESHOLD = poleLat * 0.85;

  const faceCentroidLon = new Float64Array(faceCount);
  const faceAngularRadius = new Float64Array(faceCount);
  const faceNearPole = new Uint8Array(faceCount);

  for (let f = 0; f < faceCount; f++) {
    const i0 = indices[f * 3];
    const i1 = indices[f * 3 + 1];
    const i2 = indices[f * 3 + 2];

    const l0 = lonPerVertex[i0], l1 = lonPerVertex[i1], l2 = lonPerVertex[i2];

    // Circular centroid via vector averaging
    const ccx = Math.cos(l0) + Math.cos(l1) + Math.cos(l2);
    const ccy = Math.sin(l0) + Math.sin(l1) + Math.sin(l2);
    let centroidLon = Math.atan2(ccy, ccx);
    if (centroidLon < 0) centroidLon += 2 * Math.PI;
    faceCentroidLon[f] = centroidLon;

    // Angular radius = max circular distance from centroid to any vertex longitude
    let maxCDist = 0;
    for (const l of [l0, l1, l2]) {
      let d = Math.abs(l - centroidLon);
      if (d > Math.PI) d = 2 * Math.PI - d;
      if (d > maxCDist) maxCDist = d;
    }
    faceAngularRadius[f] = maxCDist;

    // Faces near the pole have unstable longitudes; always include them
    if (latPerVertex[i0] > POLE_LAT_THRESHOLD ||
        latPerVertex[i1] > POLE_LAT_THRESHOLD ||
        latPerVertex[i2] > POLE_LAT_THRESHOLD) {
      faceNearPole[f] = 1;
    }
  }

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

    // Collect intersection segments: pairs of points, with edge keys for chaining
    // Edge key = "min_max" of the two vertex indices forming the mesh edge
    const segments: Array<{
      p1: [number, number, number];
      p2: [number, number, number];
      lat1: number;
      lat2: number;
      edgeKey1: string; // edge key for p1
      edgeKey2: string; // edge key for p2
    }> = [];

    for (let f = 0; f < faceCount; f++) {
      // Longitude culling: skip faces far from this meridian
      if (!faceNearPole[f]) {
        let dLon = Math.abs(faceCentroidLon[f] - theta);
        if (dLon > Math.PI) dLon = 2 * Math.PI - dLon;
        if (dLon > faceAngularRadius[f] + LONGITUDE_MARGIN) {
          continue;
        }
      }

      const i0 = indices[f * 3];
      const i1 = indices[f * 3 + 1];
      const i2 = indices[f * 3 + 2];

      // Signed distances to the meridian plane
      // Perturb near-zero values to avoid vertex-on-plane edge cases
      // that produce unmatchable keys and break edge-key chaining.
      // IMPORTANT: preserve original sign so crossings aren't eliminated.
      const SD_EPS = 1e-10;
      let sd0 = (positions[i0 * 3] - cx) * nx + (positions[i0 * 3 + 1] - cy) * ny + (positions[i0 * 3 + 2] - cz) * nz;
      let sd1 = (positions[i1 * 3] - cx) * nx + (positions[i1 * 3 + 1] - cy) * ny + (positions[i1 * 3 + 2] - cz) * nz;
      let sd2 = (positions[i2 * 3] - cx) * nx + (positions[i2 * 3 + 1] - cy) * ny + (positions[i2 * 3 + 2] - cz) * nz;
      if (Math.abs(sd0) < SD_EPS) sd0 = sd0 >= 0 ? SD_EPS : -SD_EPS;
      if (Math.abs(sd1) < SD_EPS) sd1 = sd1 >= 0 ? SD_EPS : -SD_EPS;
      if (Math.abs(sd2) < SD_EPS) sd2 = sd2 >= 0 ? SD_EPS : -SD_EPS;

      // Find edges that cross the plane (sd changes sign)
      const crossings: Array<[number, number, number]> = [];
      const crossLats: number[] = [];
      const crossEdgeKeys: string[] = [];

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
          // Edge key: canonical "min_max" of vertex indices
          const eMin = ia < ib ? ia : ib;
          const eMax = ia < ib ? ib : ia;
          crossEdgeKeys.push(`${eMin}_${eMax}`);
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
            edgeKey1: crossEdgeKeys[0],
            edgeKey2: crossEdgeKeys[1],
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

    // ---- Chain segments into an ordered polyline using edge-key adjacency ----
    // Two segments sharing a mesh edge (same edgeKey) are topological neighbors.
    // This produces correctly ordered polylines even near the pole where
    // latitude-based sorting fails.

    // Build adjacency: for each edge key, collect which segments touch it
    const edgeKeyToSegIdx = new Map<string, number[]>();
    for (let s = 0; s < segments.length; s++) {
      const seg = segments[s];
      for (const ek of [seg.edgeKey1, seg.edgeKey2]) {
        let arr = edgeKeyToSegIdx.get(ek);
        if (!arr) { arr = []; edgeKeyToSegIdx.set(ek, arr); }
        arr.push(s);
      }
    }

    // For each segment, find its neighbors (segments sharing an edge key)
    const segNeighbors: number[][] = new Array(segments.length);
    for (let s = 0; s < segments.length; s++) segNeighbors[s] = [];
    for (const [, segIndices] of edgeKeyToSegIdx) {
      if (segIndices.length === 2) {
        const a = segIndices[0], b = segIndices[1];
        segNeighbors[a].push(b);
        segNeighbors[b].push(a);
      } else if (segIndices.length > 2) {
        // Multiple segments share this edge key (near pole or non-manifold edges).
        // Link all pairs so chains don't break.
        for (let i = 0; i < segIndices.length; i++) {
          for (let j = i + 1; j < segIndices.length; j++) {
            segNeighbors[segIndices[i]].push(segIndices[j]);
            segNeighbors[segIndices[j]].push(segIndices[i]);
          }
        }
      }
    }

    // Extract connected chains by walking the adjacency graph
    const visitedSeg = new Uint8Array(segments.length);
    const chains: number[][] = [];
    for (let s = 0; s < segments.length; s++) {
      if (visitedSeg[s]) continue;
      // Find a chain-end (degree 0 or 1) to start from
      let start = s;
      const seen = new Set<number>();
      seen.add(start);
      // Walk to one end
      let cur = start;
      while (true) {
        const nbs = segNeighbors[cur].filter(n => !seen.has(n));
        if (nbs.length === 0) break;
        cur = nbs[0];
        seen.add(cur);
      }
      // cur is now one end; walk the full chain from here
      const chain: number[] = [cur];
      visitedSeg[cur] = 1;
      while (true) {
        const nbs = segNeighbors[chain[chain.length - 1]].filter(n => !visitedSeg[n]);
        if (nbs.length === 0) break;
        const next = nbs[0];
        chain.push(next);
        visitedSeg[next] = 1;
      }
      chains.push(chain);
    }

    // Pick the best chain: the longest one (most segments = fullest pole-to-rim coverage)
    let bestChain = chains[0];
    for (const chain of chains) {
      if (chain.length > bestChain.length) {
        bestChain = chain;
      }
    }

    // Try to extend bestChain toward the pole by concatenating nearby chains.
    // This bridges small gaps caused by missing segments near the pole.
    if (chains.length > 1) {
      // Compute average segment length for gap threshold
      let sumSegLen = 0;
      for (const seg of segments) {
        const dx = seg.p2[0] - seg.p1[0], dy = seg.p2[1] - seg.p1[1], dz = seg.p2[2] - seg.p1[2];
        sumSegLen += Math.sqrt(dx * dx + dy * dy + dz * dz);
      }
      const avgSegLen = sumSegLen / segments.length;
      const gapThreshold = avgSegLen * 5; // allow gaps up to 5× average segment length
      const gapThresholdSq = gapThreshold * gapThreshold;

      // Iteratively try to prepend/append other chains to bestChain
      const usedChainIdx = new Set<number>();
      usedChainIdx.add(chains.indexOf(bestChain));
      let changed = true;
      while (changed) {
        changed = false;
        // Get current endpoints of bestChain
        const headSeg = segments[bestChain[0]];
        const tailSeg = segments[bestChain[bestChain.length - 1]];
        const headPts = [headSeg.p1, headSeg.p2];
        const tailPts = [tailSeg.p1, tailSeg.p2];

        for (let ci = 0; ci < chains.length; ci++) {
          if (usedChainIdx.has(ci)) continue;
          const chain = chains[ci];
          const cHeadSeg = segments[chain[0]];
          const cTailSeg = segments[chain[chain.length - 1]];
          const cHeadPts = [cHeadSeg.p1, cHeadSeg.p2];
          const cTailPts = [cTailSeg.p1, cTailSeg.p2];

          // Check if chain's tail connects to bestChain's head
          let canPrepend = false;
          for (const cp of cTailPts) {
            for (const bp of headPts) {
              const d2 = (cp[0] - bp[0]) ** 2 + (cp[1] - bp[1]) ** 2 + (cp[2] - bp[2]) ** 2;
              if (d2 < gapThresholdSq) canPrepend = true;
            }
          }
          // Check if chain's head connects to bestChain's head
          let canPrependReversed = false;
          for (const cp of cHeadPts) {
            for (const bp of headPts) {
              const d2 = (cp[0] - bp[0]) ** 2 + (cp[1] - bp[1]) ** 2 + (cp[2] - bp[2]) ** 2;
              if (d2 < gapThresholdSq) canPrependReversed = true;
            }
          }
          // Check if chain's head connects to bestChain's tail
          let canAppend = false;
          for (const cp of cHeadPts) {
            for (const bp of tailPts) {
              const d2 = (cp[0] - bp[0]) ** 2 + (cp[1] - bp[1]) ** 2 + (cp[2] - bp[2]) ** 2;
              if (d2 < gapThresholdSq) canAppend = true;
            }
          }
          // Check if chain's tail connects to bestChain's tail
          let canAppendReversed = false;
          for (const cp of cTailPts) {
            for (const bp of tailPts) {
              const d2 = (cp[0] - bp[0]) ** 2 + (cp[1] - bp[1]) ** 2 + (cp[2] - bp[2]) ** 2;
              if (d2 < gapThresholdSq) canAppendReversed = true;
            }
          }

          if (canPrepend) {
            bestChain = [...chain, ...bestChain];
            usedChainIdx.add(ci);
            changed = true;
            break;
          } else if (canPrependReversed) {
            bestChain = [...chain.slice().reverse(), ...bestChain];
            usedChainIdx.add(ci);
            changed = true;
            break;
          } else if (canAppend) {
            bestChain = [...bestChain, ...chain];
            usedChainIdx.add(ci);
            changed = true;
            break;
          } else if (canAppendReversed) {
            bestChain = [...bestChain, ...chain.slice().reverse()];
            usedChainIdx.add(ci);
            changed = true;
            break;
          }
        }
      }
    }

    // Orient chain so it starts at the pole end
    const firstSeg = segments[bestChain[0]];
    const lastSeg = segments[bestChain[bestChain.length - 1]];
    const dFirst1 = (firstSeg.p1[0] - polePx) ** 2 + (firstSeg.p1[1] - polePy) ** 2 + (firstSeg.p1[2] - polePz) ** 2;
    const dFirst2 = (firstSeg.p2[0] - polePx) ** 2 + (firstSeg.p2[1] - polePy) ** 2 + (firstSeg.p2[2] - polePz) ** 2;
    const dFirstMin = Math.min(dFirst1, dFirst2);
    const dLast1 = (lastSeg.p1[0] - polePx) ** 2 + (lastSeg.p1[1] - polePy) ** 2 + (lastSeg.p1[2] - polePz) ** 2;
    const dLast2 = (lastSeg.p2[0] - polePx) ** 2 + (lastSeg.p2[1] - polePy) ** 2 + (lastSeg.p2[2] - polePz) ** 2;
    const dLastMin = Math.min(dLast1, dLast2);
    if (dLastMin < dFirstMin) {
      bestChain.reverse();
    }

    // Walk the chain, collecting ordered points.
    // Use edge keys (not distance) to determine which endpoint is "shared"
    // (connecting to the previous segment) vs "new" (continuing the path).
    // Distance-based detection fails when the chain link happens via the
    // "backward" edge key of the previous segment, causing wrong point selection.
    const uniquePoints: Array<{ pos: [number, number, number]; lat: number }> = [];
    for (let ci = 0; ci < bestChain.length; ci++) {
      const seg = segments[bestChain[ci]];
      if (ci === 0) {
        // First segment: determine orientation from connection to next segment
        if (bestChain.length > 1) {
          const nextSeg = segments[bestChain[1]];
          // Check which edge key of seg connects to nextSeg
          const fwdIsKey1 = (seg.edgeKey1 === nextSeg.edgeKey1 || seg.edgeKey1 === nextSeg.edgeKey2);
          if (fwdIsKey1) {
            // edgeKey1 connects forward: p2 is the start (backward end), p1 is forward
            uniquePoints.push({ pos: seg.p2, lat: seg.lat2 });
            uniquePoints.push({ pos: seg.p1, lat: seg.lat1 });
          } else {
            // edgeKey2 connects forward: p1 is the start (backward end), p2 is forward
            uniquePoints.push({ pos: seg.p1, lat: seg.lat1 });
            uniquePoints.push({ pos: seg.p2, lat: seg.lat2 });
          }
        } else {
          // Single segment: pole-closest first
          const d1 = (seg.p1[0] - polePx) ** 2 + (seg.p1[1] - polePy) ** 2 + (seg.p1[2] - polePz) ** 2;
          const d2 = (seg.p2[0] - polePx) ** 2 + (seg.p2[1] - polePy) ** 2 + (seg.p2[2] - polePz) ** 2;
          if (d1 <= d2) {
            uniquePoints.push({ pos: seg.p1, lat: seg.lat1 });
            uniquePoints.push({ pos: seg.p2, lat: seg.lat2 });
          } else {
            uniquePoints.push({ pos: seg.p2, lat: seg.lat2 });
            uniquePoints.push({ pos: seg.p1, lat: seg.lat1 });
          }
        }
      } else {
        // Determine shared vs new endpoint using edge keys
        const prevSeg = segments[bestChain[ci - 1]];
        const sharedIsKey1 = (seg.edgeKey1 === prevSeg.edgeKey1 || seg.edgeKey1 === prevSeg.edgeKey2);
        if (sharedIsKey1) {
          // seg.p1 is on the shared edge → p2 is the new point
          uniquePoints.push({ pos: seg.p2, lat: seg.lat2 });
        } else {
          // seg.p2 is on the shared edge → p1 is the new point
          uniquePoints.push({ pos: seg.p1, lat: seg.lat1 });
        }
      }
    }

    // Post-process: remove spike points that create anomalous detours
    // (safety net for edge cases like non-manifold edges or spurious segments)
    if (uniquePoints.length > 3) {
      let si = 1;
      while (si < uniquePoints.length - 1) {
        const prev = uniquePoints[si - 1].pos;
        const curr = uniquePoints[si].pos;
        const next = uniquePoints[si + 1].pos;
        const dPC = Math.sqrt((curr[0] - prev[0]) ** 2 + (curr[1] - prev[1]) ** 2 + (curr[2] - prev[2]) ** 2);
        const dCN = Math.sqrt((next[0] - curr[0]) ** 2 + (next[1] - curr[1]) ** 2 + (next[2] - curr[2]) ** 2);
        const dPN = Math.sqrt((next[0] - prev[0]) ** 2 + (next[1] - prev[1]) ** 2 + (next[2] - prev[2]) ** 2);
        const detour = dPN > 1e-12 ? (dPC + dCN) / dPN : 1;
        if (detour > 4) {
          uniquePoints.splice(si, 1);
        } else {
          si++;
        }
      }
    }

    // Add pole as the first point if not already very close
    const eps = 1e-6;
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

/**
 * Lightweight meridian extraction for geodesic-guided hole repair.
 *
 * For each of the nAngles meridians, returns the sorted list of
 * mesh-plane intersection points (pole-end first, high cup-axis projection first).
 * Gaps in the mesh (holes) appear as sudden jumps in that sorted list.
 *
 * Unlike computeGeodesics, this skips deviation computation, segment chaining,
 * and common-pole consolidation — it is only meant to supply trajectory shapes
 * for the extrapolation-based hole-fill algorithm.
 */
export function extractMeridianPolylines(
  positions: Float32Array,
  indices: Uint32Array,
  vertexCount: number,
  faceCount: number,
  sphereCenter: [number, number, number],
  cupAxis: [number, number, number],
  nAngles: number = 360,
): Array<Array<[number, number, number]>> {
  const frame = buildLocalFrame(cupAxis);
  const [ux, uy, uz] = frame.U;
  const [vx, vy, vz] = frame.V;
  const [wx, wy, wz] = frame.W;
  const [cx, cy, cz] = sphereCenter;

  // Precompute per-vertex longitude for face culling
  const lonPerVertex = new Float64Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    const dx = positions[i * 3] - cx;
    const dy = positions[i * 3 + 1] - cy;
    const dz = positions[i * 3 + 2] - cz;
    let lon = Math.atan2(dx * vx + dy * vy + dz * vz, dx * ux + dy * uy + dz * uz);
    if (lon < 0) lon += 2 * Math.PI;
    lonPerVertex[i] = lon;
  }

  // Precompute per-face centroid longitude and angular radius
  const faceCentLon = new Float64Array(faceCount);
  const faceAngRad = new Float64Array(faceCount);
  for (let f = 0; f < faceCount; f++) {
    const i0 = indices[f * 3], i1 = indices[f * 3 + 1], i2 = indices[f * 3 + 2];
    const l0 = lonPerVertex[i0], l1 = lonPerVertex[i1], l2 = lonPerVertex[i2];
    let cLon = Math.atan2(
      Math.sin(l0) + Math.sin(l1) + Math.sin(l2),
      Math.cos(l0) + Math.cos(l1) + Math.cos(l2),
    );
    if (cLon < 0) cLon += 2 * Math.PI;
    faceCentLon[f] = cLon;
    let maxD = 0;
    for (const l of [l0, l1, l2]) {
      let d = Math.abs(l - cLon);
      if (d > Math.PI) d = 2 * Math.PI - d;
      if (d > maxD) maxD = d;
    }
    faceAngRad[f] = maxD;
  }

  const MARGIN = Math.PI / 36; // 5° longitude safety margin
  const SD_EPS = 1e-10;
  const angStep = (2 * Math.PI) / nAngles;

  const result: Array<Array<[number, number, number]>> = new Array(nAngles);

  for (let g = 0; g < nAngles; g++) {
    const theta = g * angStep;
    const cosT = Math.cos(theta), sinT = Math.sin(theta);

    // Meridian half-plane normal (same formula as in computeGeodesics)
    const nx = (uy * cosT + vy * sinT) * wz - (uz * cosT + vz * sinT) * wy;
    const ny = (uz * cosT + vz * sinT) * wx - (ux * cosT + vx * sinT) * wz;
    const nz = (ux * cosT + vx * sinT) * wy - (uy * cosT + vy * sinT) * wx;

    const pts: { pos: [number, number, number]; lat: number }[] = [];

    for (let f = 0; f < faceCount; f++) {
      // Longitude culling
      let dLon = Math.abs(faceCentLon[f] - theta);
      if (dLon > Math.PI) dLon = 2 * Math.PI - dLon;
      if (dLon > faceAngRad[f] + MARGIN) continue;

      const i0 = indices[f * 3], i1 = indices[f * 3 + 1], i2 = indices[f * 3 + 2];
      let sd0 = (positions[i0 * 3] - cx) * nx + (positions[i0 * 3 + 1] - cy) * ny + (positions[i0 * 3 + 2] - cz) * nz;
      let sd1 = (positions[i1 * 3] - cx) * nx + (positions[i1 * 3 + 1] - cy) * ny + (positions[i1 * 3 + 2] - cz) * nz;
      let sd2 = (positions[i2 * 3] - cx) * nx + (positions[i2 * 3 + 1] - cy) * ny + (positions[i2 * 3 + 2] - cz) * nz;
      if (Math.abs(sd0) < SD_EPS) sd0 = sd0 >= 0 ? SD_EPS : -SD_EPS;
      if (Math.abs(sd1) < SD_EPS) sd1 = sd1 >= 0 ? SD_EPS : -SD_EPS;
      if (Math.abs(sd2) < SD_EPS) sd2 = sd2 >= 0 ? SD_EPS : -SD_EPS;

      const crossings: { pos: [number, number, number]; lat: number }[] = [];
      const edges: [number, number, number, number][] = [
        [i0, i1, sd0, sd1],
        [i1, i2, sd1, sd2],
        [i2, i0, sd2, sd0],
      ];
      for (const [ia, ib, sda, sdb] of edges) {
        if (sda * sdb < 0) {
          const t = sda / (sda - sdb);
          const px = positions[ia * 3] + t * (positions[ib * 3] - positions[ia * 3]);
          const py = positions[ia * 3 + 1] + t * (positions[ib * 3 + 1] - positions[ia * 3 + 1]);
          const pz = positions[ia * 3 + 2] + t * (positions[ib * 3 + 2] - positions[ia * 3 + 2]);
          const lat = (px - cx) * wx + (py - cy) * wy + (pz - cz) * wz;
          crossings.push({ pos: [px, py, pz], lat });
        }
      }

      if (crossings.length >= 2) {
        // Half-plane check: midpoint must be on the correct longitude side
        const mx = (crossings[0].pos[0] + crossings[1].pos[0]) / 2;
        const my = (crossings[0].pos[1] + crossings[1].pos[1]) / 2;
        const mz = (crossings[0].pos[2] + crossings[1].pos[2]) / 2;
        let mLon = Math.atan2(
          (mx - cx) * vx + (my - cy) * vy + (mz - cz) * vz,
          (mx - cx) * ux + (my - cy) * uy + (mz - cz) * uz,
        );
        if (mLon < 0) mLon += 2 * Math.PI;
        let lonDiff = Math.abs(mLon - theta);
        if (lonDiff > Math.PI) lonDiff = 2 * Math.PI - lonDiff;
        if (lonDiff < Math.PI / 2) pts.push(...crossings);
      }
    }

    // Sort by cup-axis projection descending: pole-end (high lat) first
    pts.sort((a, b) => b.lat - a.lat);
    result[g] = pts.map(p => p.pos);
  }

  return result;
}
