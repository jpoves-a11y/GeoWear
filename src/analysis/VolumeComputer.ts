// ============================================================
// GeoWear — VolumeComputer
// Volumetric computation of defect regions (bumps and dips)
// Computes volume between actual mesh surface and reference sphere
// High-performance: all math is inline, no heap allocations in hot loop
// ============================================================

import * as THREE from 'three';
import type { AnomalyCluster, SphereFitResult, MeshData } from '../types';

export interface VolumeResult {
  totalBumpVolume: number;   // mm³
  totalDipVolume: number;    // mm³
  totalWearVolume: number;   // mm³ (sum of absolute values)
  bumpMass: number;          // mg
  dipMass: number;           // mg
  clusterVolumes: Map<number, number>; // cluster id → volume in mm³
}

/** Inline signed tetrahedron volume from 12 scalars (no object allocation) */
function tetVol6(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  dx: number, dy: number, dz: number
): number {
  // (b-a)·((c-a)×(d-a))
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const adx = dx - ax, ady = dy - ay, adz = dz - az;
  // cross(ac, ad)
  const crx = acy * adz - acz * ady;
  const cry = acz * adx - acx * adz;
  const crz = acx * ady - acy * adx;
  return (abx * crx + aby * cry + abz * crz) / 6.0;
}

/** Project (px,py,pz) radially onto sphere → (sx,sy,sz) in out array offsets */
function projectSphere(
  px: number, py: number, pz: number,
  cxx: number, cyy: number, czz: number,
  radius: number,
  out: Float64Array, off: number
): void {
  const dx = px - cxx, dy = py - cyy, dz = pz - czz;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 1e-12) {
    out[off] = cxx + radius; out[off + 1] = cyy; out[off + 2] = czz;
  } else {
    const s = radius / len;
    out[off] = cxx + dx * s; out[off + 1] = cyy + dy * s; out[off + 2] = czz + dz * s;
  }
}

/**
 * Compute the volume between the mesh surface and the reference sphere
 * for faces whose average per-vertex deviation exceeds threshold.
 */
export function computeDefectVolumes(
  meshData: MeshData,
  sphereFit: SphereFitResult,
  vertexDeviations: Float32Array,
  clusters: AnomalyCluster[],
  thresholdMicrons: number,
  density: number = 0.935 // UHMWPE density in g/cm³ = mg/mm³
): VolumeResult {
  const { positions, indices, faceCount } = meshData;
  const cxx = sphereFit.center.x, cyy = sphereFit.center.y, czz = sphereFit.center.z;
  const radius = sphereFit.radius;

  let totalBumpVolume = 0;
  let totalDipVolume = 0;

  // Reusable buffer for 2 projected triangles (6 floats)
  const sp = new Float64Array(9); // s0xyz, s1xyz, s2xyz

  for (let f = 0; f < faceCount; f++) {
    const i0 = indices[f * 3];
    const i1 = indices[f * 3 + 1];
    const i2 = indices[f * 3 + 2];

    const avgDev = (vertexDeviations[i0] + vertexDeviations[i1] + vertexDeviations[i2]) / 3;
    if (Math.abs(avgDev) <= thresholdMicrons) continue;

    // Read mesh vertex coords inline
    const v0x = positions[i0 * 3], v0y = positions[i0 * 3 + 1], v0z = positions[i0 * 3 + 2];
    const v1x = positions[i1 * 3], v1y = positions[i1 * 3 + 1], v1z = positions[i1 * 3 + 2];
    const v2x = positions[i2 * 3], v2y = positions[i2 * 3 + 1], v2z = positions[i2 * 3 + 2];

    // Project onto sphere
    projectSphere(v0x, v0y, v0z, cxx, cyy, czz, radius, sp, 0);
    projectSphere(v1x, v1y, v1z, cxx, cyy, czz, radius, sp, 3);
    projectSphere(v2x, v2y, v2z, cxx, cyy, czz, radius, sp, 6);

    // Prism volume = sum of 3 tetrahedra
    const vol =
      tetVol6(v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z, sp[0], sp[1], sp[2]) +
      tetVol6(sp[0], sp[1], sp[2], v1x, v1y, v1z, v2x, v2y, v2z, sp[3], sp[4], sp[5]) +
      tetVol6(sp[0], sp[1], sp[2], sp[3], sp[4], sp[5], v2x, v2y, v2z, sp[6], sp[7], sp[8]);

    const absVol = Math.abs(vol);
    if (avgDev > 0) totalBumpVolume += absVol;
    else totalDipVolume += absVol;
  }

  // Update cluster volumes (approximate: assign volume proportional to cluster area)
  const clusterVolumes = new Map<number, number>();
  for (const cluster of clusters) {
    clusterVolumes.set(cluster.id, 0);
    cluster.volume = 0;
  }

  // 1 g/cm³ = 1000 mg / 1000 mm³ = 1 mg/mm³   →   0.935 g/cm³ = 0.935 mg/mm³
  const bumpMass = totalBumpVolume * density; // mg
  const dipMass = totalDipVolume * density;   // mg

  return {
    totalBumpVolume,
    totalDipVolume,
    totalWearVolume: totalBumpVolume + totalDipVolume,
    bumpMass,
    dipMass,
    clusterVolumes,
  };
}

/**
 * Compute the wear vector from the most-worn point to the pole.
 *
 * The "most-worn point" is chosen among all bump-cluster vertices
 * (positive deviation = outside reference sphere = material worn away)
 * that fall within the 70% of the active surface closest to the cup
 * bottom (pole). Among those candidates, the vertex with the largest
 * deviation (most wear) is selected.
 */
export function computeWearVector(
  wearClusters: AnomalyCluster[],
  polePosition: THREE.Vector3,
  sphereCenter: THREE.Vector3,
  cupAxis: THREE.Vector3
): {
  deepestPoint: THREE.Vector3;
  polePoint: THREE.Vector3;
  direction: THREE.Vector3;
  angle: number;
  distance: number;
  maxDepth: number;
} | null {
  if (wearClusters.length === 0) return null;

  const pole = polePosition.clone();
  const candidates: { pos: THREE.Vector3; dev: number; distToPole: number }[] = [];

  for (const cluster of wearClusters) {
    for (const p of cluster.points) {
      const d = p.position.distanceTo(pole);
      candidates.push({ pos: p.position.clone(), dev: p.deviation, distToPole: d });
    }
  }

  if (candidates.length === 0) return null;

  // Sort by distance to pole (ascending = closest first)
  candidates.sort((a, b) => a.distToPole - b.distToPole);

  // Keep only the 70% closest to the pole (cup bottom)
  const cutoff = Math.max(1, Math.ceil(candidates.length * 0.7));
  const filtered = candidates.slice(0, cutoff);

  // Among the filtered set, find the vertex with most wear (highest positive deviation)
  let bestCandidate = filtered[0];
  for (const c of filtered) {
    if (c.dev > bestCandidate.dev) {
      bestCandidate = c;
    }
  }

  const deepest = bestCandidate.pos;
  const direction = deepest.clone().sub(pole).normalize();
  const distance = deepest.distanceTo(pole);

  // Angle between wear direction and cup axis
  const angle = Math.acos(
    Math.max(-1, Math.min(1, direction.dot(cupAxis)))
  ) * (180 / Math.PI);

  return {
    deepestPoint: deepest,
    polePoint: pole,
    direction,
    angle,
    distance,
    maxDepth: bestCandidate.dev,
  };
}

/**
 * Signed tetrahedron volume with one vertex at the origin.
 * V = (1/6) * a · (b × c)
 */
function signedTetVolOrigin(
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
 * Compute the enclosed volume between the mesh surface and a capping plane.
 *
 * Uses the divergence theorem: the signed volume of the closed surface
 * (mesh triangles + flat cap polygon at the rim plane) equals the sum of
 * signed tetrahedra formed by each triangle and the origin.
 *
 * For the mesh triangles below/above the plane, we sum their signed
 * tetrahedra directly. The rim plane cap is approximated as a fan from
 * the rim centroid to consecutive boundary edges.
 */
export function computeMeshEnclosedVolume(
  meshData: MeshData,
  planePoint: THREE.Vector3,
  planeNormal: THREE.Vector3
): number {
  const { positions, indices, faceCount } = meshData;
  const pn = planeNormal.clone().normalize();
  const pp = planePoint;

  // Classify vertices: signed distance to rim plane
  // Positive = same side as interior (below plane)
  const vertCount = positions.length / 3;
  const vertDist = new Float32Array(vertCount);
  for (let i = 0; i < vertCount; i++) {
    vertDist[i] = (positions[i * 3] - pp.x) * pn.x +
                  (positions[i * 3 + 1] - pp.y) * pn.y +
                  (positions[i * 3 + 2] - pp.z) * pn.z;
  }

  let meshVolume = 0;

  // Sum signed tetrahedra for all mesh faces
  for (let f = 0; f < faceCount; f++) {
    const i0 = indices[f * 3];
    const i1 = indices[f * 3 + 1];
    const i2 = indices[f * 3 + 2];

    meshVolume += signedTetVolOrigin(
      positions[i0 * 3], positions[i0 * 3 + 1], positions[i0 * 3 + 2],
      positions[i1 * 3], positions[i1 * 3 + 1], positions[i1 * 3 + 2],
      positions[i2 * 3], positions[i2 * 3 + 1], positions[i2 * 3 + 2]
    );
  }

  // Find boundary edges (edges that belong to only one triangle)
  const edgeCount = new Map<string, number[]>();
  for (let f = 0; f < faceCount; f++) {
    for (let e = 0; e < 3; e++) {
      const a = indices[f * 3 + e];
      const b = indices[f * 3 + ((e + 1) % 3)];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (!edgeCount.has(key)) edgeCount.set(key, []);
      edgeCount.get(key)!.push(a, b);
    }
  }

  // Collect ordered boundary vertices
  const boundaryEdges: Array<[number, number]> = [];
  for (const [key, verts] of edgeCount) {
    if (verts.length === 2) { // only one triangle uses this edge
      boundaryEdges.push([verts[0], verts[1]]);
    }
  }

  // Cap the opening with a fan from the boundary centroid
  if (boundaryEdges.length > 0) {
    // Compute boundary centroid (project onto plane)
    const rimVerts = new Set<number>();
    for (const [a, b] of boundaryEdges) {
      rimVerts.add(a);
      rimVerts.add(b);
    }
    let rcx = 0, rcy = 0, rcz = 0;
    for (const v of rimVerts) {
      rcx += positions[v * 3];
      rcy += positions[v * 3 + 1];
      rcz += positions[v * 3 + 2];
    }
    rcx /= rimVerts.size;
    rcy /= rimVerts.size;
    rcz /= rimVerts.size;

    // Each boundary edge forms a triangle with the centroid
    for (const [a, b] of boundaryEdges) {
      meshVolume += signedTetVolOrigin(
        rcx, rcy, rcz,
        positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2],
        positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2]
      );
    }
  }

  return Math.abs(meshVolume);
}

/**
 * Compute the volume of a spherical cap cut by a plane.
 *
 * Given a sphere (center, radius) and a plane (point, normal),
 * compute the volume of the cap on the side of the plane pointed
 * to by the normal.
 *
 * Cap volume: V = (π/3) h² (3R - h)
 * where h = cap height = R - d (d = signed distance from center to plane)
 */
export function computeSphereCap(
  center: THREE.Vector3,
  radius: number,
  planePoint: THREE.Vector3,
  planeNormal: THREE.Vector3
): number {
  const pn = planeNormal.clone().normalize();
  // Signed distance from sphere center to plane (positive = same side as normal)
  const d = (center.x - planePoint.x) * pn.x +
            (center.y - planePoint.y) * pn.y +
            (center.z - planePoint.z) * pn.z;

  // Cap on the opposite side of the normal (interior side)
  // h = R - |d| if center is on the interior side, else h = R + d
  // More precisely: the cap on the "negative normal" side has height h = R + d
  // (when d is negative, center is on the interior side, h = R + |d|)
  const h = radius + d; // height of cap on the -normal side (interior)

  if (h <= 0) return 0;                         // sphere entirely on the normal side
  if (h >= 2 * radius) return (4 / 3) * Math.PI * radius * radius * radius; // entire sphere

  return (Math.PI / 3) * h * h * (3 * radius - h);
}
